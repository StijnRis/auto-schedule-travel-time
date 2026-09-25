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

function requestDirections(key, origin, destination, time, isDepartureTime) {
  if (CONFIG.API_DELAY_MS > 0) {
    Utilities.sleep(CONFIG.API_DELAY_MS);
  }

  const finder = Maps.newDirectionFinder()
    .setOrigin(origin)
    .setDestination(destination)
    .setMode(Maps.DirectionFinder.Mode[key]);

  if (isDepartureTime) {
    finder.setDepart(time);
  } else {
    finder.setArrive(time);
  }

  const response = finder.getDirections();
  return response.routes && response.routes.length > 0 ? response.routes[0] : null;
}

function getGoogleRoute(key, origin, destination, targetTime, isDepartureTime) {
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

  return {
    key,
    durationSec: duration.value,
    durationText: duration.text,
    fareText: route.fare ? route.fare.text : null,
    departureTime: leg.departure_time ? new Date(leg.departure_time.value * 1000) : null,
    arrivalTime: leg.arrival_time ? new Date(leg.arrival_time.value * 1000) : null,
    url: buildGoogleMapsUrl(origin, destination, TRAVEL_MODES[key].urlCode, targetTime, isDepartureTime),
    stepsHtml: formatGoogleStepsHtml(route)
  };
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
  const base = `https://www.google.com/maps/dir/${encodeURIComponent(origin)}/${encodeURIComponent(destination)}/`;
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
