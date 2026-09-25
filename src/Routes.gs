/**
 * Route calculation (Google Maps) and travel mode selection.
 */

// urlCode is the travel mode code used in Google Maps "dir" URLs.
const TRAVEL_MODES = {
  WALKING:   { label: 'Walking', emoji: '🚶', urlCode: 2 },
  BICYCLING: { label: 'Biking',  emoji: '🚲', urlCode: 1 },
  TRANSIT:   { label: 'Transit', emoji: '🚌', urlCode: 3 },
  NS:        { label: 'NS',      emoji: '🚆' },
  DRIVING:   { label: 'Driving', emoji: '🚗', urlCode: 0 }
};

const GOOGLE_MODE_KEYS = ['WALKING', 'BICYCLING', 'TRANSIT', 'DRIVING'];
const ROUTE_DISPLAY_ORDER = ['WALKING', 'BICYCLING', 'TRANSIT', 'NS', 'DRIVING'];

const TRANSIT_SEARCH_SHIFT_MIN = 30;  // Search for later transit connections up to this much later
const ALTERNATIVE_WINDOW_MIN = 60;    // Earlier/later connections must arrive within this of the chosen one

/**
 * Calculates a route for every travel mode.
 * @param {Date} targetTime Arrival time, or departure time when isDepartureTime is true.
 * @return {Object} Map of mode key -> normalized route (or null when unavailable).
 */
function calculateAllRoutes(origin, destination, targetTime, isDepartureTime) {
  const results = {};

  GOOGLE_MODE_KEYS.forEach(key => {
    try {
      results[key] = getGoogleRoute(key, origin, destination, targetTime, isDepartureTime);
    } catch (e) {
      console.warn(`  -> ${key} route failed: ${e}`);
      results[key] = null;
      failedRequests++;
    }
  });

  try {
    results.NS = getNsRoute(origin, destination, targetTime, isDepartureTime);
  } catch (e) {
    console.warn(`  -> NS route failed: ${e}`);
    results.NS = null;
    failedRequests++;
  }

  return results;
}

function requestRoutes(key, origin, destination, time, isDepartureTime, alternatives) {
  if (CONFIG.API_DELAY_MS > 0) {
    Utilities.sleep(CONFIG.API_DELAY_MS);
  }

  const finder = Maps.newDirectionFinder()
    .setOrigin(origin)
    .setDestination(destination)
    .setMode(Maps.DirectionFinder.Mode[key])
    .setAlternatives(Boolean(alternatives));

  if (isDepartureTime) {
    finder.setDepart(time);
  } else {
    finder.setArrive(time);
  }

  const response = finder.getDirections();
  return response.routes || [];
}

function requestDirections(key, origin, destination, time, isDepartureTime) {
  return requestRoutes(key, origin, destination, time, isDepartureTime, false)[0] || null;
}

function getGoogleRoute(key, origin, destination, targetTime, isDepartureTime) {
  if (key === 'TRANSIT') {
    return getGoogleTransitRoute(origin, destination, targetTime, isDepartureTime);
  }

  const route = requestDirections(key, origin, destination, targetTime, isDepartureTime);
  if (!route) return null;

  const leg = route.legs[0];
  let duration = leg.duration;

  // Google only models traffic for a departure time. Estimate when you'd leave
  // from the traffic-free duration and ask again to get the duration in traffic.
  if (key === 'DRIVING' && !isDepartureTime) {
    const estimatedDeparture = new Date(targetTime.getTime() - (leg.duration.value * 1000));
    if (estimatedDeparture > new Date()) {
      const trafficRoute = requestDirections(key, origin, destination, estimatedDeparture, true);
      const trafficLeg = trafficRoute && trafficRoute.legs[0];
      if (trafficLeg && trafficLeg.duration_in_traffic) {
        duration = trafficLeg.duration_in_traffic;
      }
    }
  } else if (key === 'DRIVING' && leg.duration_in_traffic) {
    duration = leg.duration_in_traffic;
  }

  return withTravelTimes({
    key,
    durationSec: duration.value,
    durationText: duration.text,
    fareText: route.fare ? route.fare.text : null,
    departureTime: null,
    arrivalTime: null,
    url: buildGoogleMapsUrl(origin, destination, TRAVEL_MODES[key].urlCode, targetTime, isDepartureTime),
    stepsHtml: formatGoogleStepsHtml(route)
  }, targetTime, isDepartureTime);
}

/**
 * Google transit: collects connections around the target time and picks the fastest,
 * plus the fastest connection arriving earlier and later.
 */
function getGoogleTransitRoute(origin, destination, targetTime, isDepartureTime) {
  const connections = [];
  const search = (time, departAt) => {
    requestRoutes('TRANSIT', origin, destination, time, departAt, true).forEach(route => {
      const leg = route.legs[0];
      if (!leg.departure_time || !leg.arrival_time) return;
      const connection = {
        route,
        departureTime: new Date(leg.departure_time.value * 1000),
        arrivalTime: new Date(leg.arrival_time.value * 1000)
      };
      const duplicate = connections.some(c => c.departureTime.getTime() === connection.departureTime.getTime()
        && c.arrivalTime.getTime() === connection.arrivalTime.getTime());
      if (!duplicate) connections.push(connection);
    });
  };

  search(targetTime, isDepartureTime);
  const first = pickFastestConnection(connections, targetTime, isDepartureTime);
  if (!first) return null;

  // Look for connections arriving just before and up to TRANSIT_SEARCH_SHIFT_MIN after it.
  try {
    if (!isDepartureTime) search(new Date(first.arrivalTime.getTime() - 60 * 1000), false);
    search(new Date(first.arrivalTime.getTime() + TRANSIT_SEARCH_SHIFT_MIN * 60 * 1000), false);
  } catch (e) {
    console.warn(`  -> Extra transit search failed: ${e}`);
  }

  // The extra searches may have found an even faster connection that is still on time.
  const chosen = pickFastestConnection(connections, targetTime, isDepartureTime);

  const leg = chosen.route.legs[0];
  const transitUrl = c => buildGoogleMapsUrl(origin, destination, TRAVEL_MODES.TRANSIT.urlCode, c.arrivalTime, false);
  return {
    key: 'TRANSIT',
    durationSec: (chosen.arrivalTime - chosen.departureTime) / 1000,
    durationText: leg.duration.text,
    fareText: chosen.route.fare ? chosen.route.fare.text : null,
    departureTime: chosen.departureTime,
    arrivalTime: chosen.arrivalTime,
    url: transitUrl(chosen),
    stepsHtml: formatGoogleStepsHtml(chosen.route),
    alternatives: pickAlternatives(connections, chosen, transitUrl)
  };
}

/**
 * Fills in departure/arrival times for modes without a timetable (walking, biking,
 * driving): you leave just in time to arrive at targetTime, or leave at targetTime.
 */
function withTravelTimes(route, targetTime, isDepartureTime) {
  const durationMs = route.durationSec * 1000;
  if (!route.departureTime && !route.arrivalTime) {
    route.departureTime = isDepartureTime ? targetTime : new Date(targetTime.getTime() - durationMs);
  }
  if (!route.departureTime) route.departureTime = new Date(route.arrivalTime.getTime() - durationMs);
  if (!route.arrivalTime) route.arrivalTime = new Date(route.departureTime.getTime() + durationMs);
  return route;
}

// --- PUBLIC TRANSPORT CONNECTIONS (Google transit and NS) ---
// A connection is { departureTime, arrivalTime, ... }.

/**
 * The connection with the shortest total travel time.
 * Arriving: among connections that arrive on time, the shortest trip.
 * Departing (trip home): time counts from targetTime, so the earliest arrival wins.
 */
function pickFastestConnection(connections, targetTime, isDepartureTime) {
  const onTime = connections.filter(c => (isDepartureTime ? c.departureTime >= targetTime : c.arrivalTime <= targetTime));
  return pickShortest(onTime, isDepartureTime ? targetTime : null);
}

/**
 * Shortest trip; on a tie the one leaving last. countFrom overrides the departure
 * time as the start of the trip (used when waiting counts as travel time).
 */
function pickShortest(connections, countFrom) {
  const total = c => c.arrivalTime - (countFrom || c.departureTime);
  return connections.reduce((best, c) => {
    if (!best || total(c) < total(best) || (total(c) === total(best) && c.departureTime > best.departureTime)) return c;
    return best;
  }, null);
}

/**
 * The fastest connection that really arrives earlier, and later, than the chosen one
 * (within ALTERNATIVE_WINDOW_MIN of it).
 */
function pickAlternatives(connections, chosen, urlFor) {
  const windowMs = ALTERNATIVE_WINDOW_MIN * 60 * 1000;
  const chosenArrival = chosen.arrivalTime.getTime();
  const earlier = pickShortest(connections.filter(c =>
    c.arrivalTime.getTime() < chosenArrival && c.arrivalTime.getTime() >= chosenArrival - windowMs), null);
  const later = pickShortest(connections.filter(c =>
    c.arrivalTime.getTime() > chosenArrival && c.arrivalTime.getTime() <= chosenArrival + windowMs), null);

  const toAlternative = c => ({ departureTime: c.departureTime, arrivalTime: c.arrivalTime, url: urlFor(c) });
  const alternatives = {};
  if (earlier) alternatives.earlier = toAlternative(earlier);
  if (later) alternatives.later = toAlternative(later);
  return alternatives;
}

/**
 * Picks the travel mode to put in your calendar.
 */
function selectBestTravelMode(routes) {
  const rules = CONFIG.MODE_SELECTION;
  const walking = routes.WALKING;
  const bicycle = routes.BICYCLING;

  if (walking && walking.durationSec < rules.walkIfUnderMinutes * 60) return walking;
  if (bicycle && bicycle.durationSec < rules.bikeIfUnderMinutes * 60) return bicycle;

  // Fastest of public transport / bike (/ car). On a tie, earlier in the list wins.
  const candidates = [pickPublicTransport(routes), bicycle, rules.allowDriving ? routes.DRIVING : null].filter(Boolean);
  if (candidates.length > 0) {
    return candidates.reduce((best, r) => (r.durationSec < best.durationSec ? r : best));
  }

  return walking || null;
}

function pickPublicTransport(routes) {
  const transit = routes.TRANSIT;
  const ns = routes.NS;
  if (!ns) return transit;
  if (!transit || CONFIG.NS.preferOverGoogleTransit) return ns;
  return ns.durationSec <= transit.durationSec ? ns : transit;
}

/**
 * Google Maps directions link that opens the given travel mode with "Arrive by"
 * (or "Depart at") preset to the given time, so traffic and timetables match.
 */
function buildGoogleMapsUrl(origin, destination, modeCode, time, isDepartureTime) {
  const base = `https://www.google.com/maps/dir/${encodeURIComponent(singleLine(origin))}/${encodeURIComponent(singleLine(destination))}/`;
  // !6e0 = depart at, !6e1 = arrive by; !8j = local wall-clock time as Unix seconds.
  const timeType = isDepartureTime ? 0 : 1;
  return `${base}data=!4m6!4m5!2m3!6e${timeType}!7e2!8j${toWallClockSeconds(time)}!3e${modeCode}`;
}

/**
 * Google Maps URLs expect the local time as if it were UTC.
 */
function toWallClockSeconds(date) {
  const local = Utilities.formatDate(date, getTimeZone(), "yyyy-MM-dd'T'HH:mm:ss'Z'");
  return Math.floor(new Date(local).getTime() / 1000);
}

function formatGoogleStepsHtml(route) {
  if (!route || !route.legs || route.legs.length === 0) return '';

  const leg = route.legs[0];
  const lines = ['<b>🗺️ Step-by-Step Directions:</b>'];

  if (leg.departure_time) {
    lines.push(`<b>Depart:</b> ${leg.departure_time.text}`);
  }

  leg.steps.forEach((step, idx) => {
    const distText = step.distance && step.distance.text ? ` (${step.distance.text})` : '';
    const durText = step.duration && step.duration.text ? step.duration.text : '';

    if (step.travel_mode === 'TRANSIT' && step.transit_details) {
      const transit = step.transit_details;
      const line = transit.line || {};
      const departTime = transit.departure_time ? transit.departure_time.text : '';
      const lineName = line.short_name || line.name || 'Transit Line';

      lines.push(`${idx + 1}. <b>[${departTime}] Board ${escapeHtml(lineName)}</b> at <i>${escapeHtml(transit.departure_stop.name)}</i> (Ride ${durText}) ➔ Exit at <i>${escapeHtml(transit.arrival_stop.name)}</i>`);
    } else {
      const instruction = step.html_instructions || 'Continue onto destination';
      lines.push(`${idx + 1}. ${instruction} — <i>${durText}${distText}</i>`);
    }
  });

  if (leg.arrival_time) {
    lines.push(`<b>Arrive:</b> ${leg.arrival_time.text}`);
  }

  return lines.join('<br>');
}
