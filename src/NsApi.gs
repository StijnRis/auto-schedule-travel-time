/**
 * NS (Dutch Railways) journey planner: trains from the station nearest to you,
 * with the way to and from the stations (walking, biking or local transport)
 * planned with Google Maps. NS API keys for the "Ns-App" product can't plan from
 * an address, only between stations, so the script plans the rest itself.
 * API docs: https://apiportal.ns.nl/ (Reisinformatie API)
 */

const NS_API_BASE = 'https://gateway.apiportal.ns.nl/reisinformatie-api/api';
const NS_TRIPS_URL = `${NS_API_BASE}/v3/trips`;
const NS_TIME_ZONE = 'Europe/Amsterdam';
const NS_PLANNER_URL = 'https://www.ns.nl/en/journeyplanner/';
const NS_LOCAL_TRANSIT_WAIT_MIN = 5;   // Waiting time added to local transport to/from a station

/**
 * Plans an NS journey between two addresses.
 * @param {Date} targetTime Arrival time, or departure time when isDepartureTime is true.
 * @param {boolean} withBike Bike to the departure station (and park it there).
 * @return {Object|null} Normalized route, or null when NS is disabled or has no journey.
 */
function getNsRoute(origin, destination, targetTime, isDepartureTime, withBike) {
  if (!getSetting('NS_API_KEY')) return null;

  const from = geocodeAddress(origin);
  const to = geocodeAddress(destination);
  if (!from || !to) return null;

  const toStation = findNearestStations(to, 1)[0];
  if (!toStation) return null;
  // Biking, a station a bit further away can be faster (e.g. an intercity station).
  const maxDistance = withBike ? CONFIG.BIKE.maxStationDistanceKm * 1000 : 0;
  const fromStations = findNearestStations(from, withBike ? 3 : 1)
    .filter((s, i) => i === 0 || s.distance <= maxDistance)
    .filter(s => s.code !== toStation.code);
  if (fromStations.length === 0) return null;

  const lastMile = planStationAccess(stationLocation(toStation), destination, false, targetTime, isDepartureTime);
  if (!lastMile) return null;

  const candidates = [];
  fromStations.forEach(station => {
    const firstMile = planStationAccess(origin, stationLocation(station), withBike, targetTime, isDepartureTime);
    if (!firstMile) return;
    const trainTime = isDepartureTime
      ? new Date(targetTime.getTime() + firstMile.sec * 1000)
      : new Date(targetTime.getTime() - lastMile.sec * 1000);
    fetchNsTrips(station.code, toStation.code, trainTime, !isDepartureTime).forEach(trip => {
      candidates.push({
        trip,
        station,
        firstMile,
        departureTime: new Date(parseNsDate(nsTime(trip.legs[0].origin)).getTime() - firstMile.sec * 1000),
        arrivalTime: new Date(parseNsDate(nsTime(trip.legs[trip.legs.length - 1].destination)).getTime() + lastMile.sec * 1000)
      });
    });
  });

  const best = pickFastestConnection(candidates, targetTime, isDepartureTime);
  if (!best) return null;

  const trip = best.trip;
  const durationMins = Math.round((best.arrivalTime - best.departureTime) / 60000);
  const bikeLabel = withBike ? { label: `Bike + ${TRAVEL_MODES.NS.label}`, emoji: `🚲${TRAVEL_MODES.NS.emoji}` } : {};

  return Object.assign({
    key: 'NS',
    durationSec: durationMins * 60,
    durationText: `${durationMins} mins, ${trip.transfers || 0} transfer(s)`,
    fareText: trip.productFare && trip.productFare.priceInCents
      ? `€${(trip.productFare.priceInCents / 100).toFixed(2)}`
      : null,
    departureTime: best.departureTime,
    arrivalTime: best.arrivalTime,
    transfers: trip.transfers || 0,
    url: nsTripUrl(trip),
    stepsHtml: formatNsStepsHtml(trip, best.firstMile.line, lastMile.line),
    bikeParkedAt: withBike ? { name: `${best.station.namen.lang} station`, location: stationLocation(best.station) } : null,
    alternatives: pickAlternatives(candidates, best, c => nsTripUrl(c.trip))
  }, bikeLabel);
}

/**
 * The way between an address and a station: biking (plus parking), walking, or
 * local public transport when walking takes too long.
 * Returns { sec, line } or null.
 */
function planStationAccess(from, to, withBike, targetTime, isDepartureTime) {
  if (withBike) {
    const bikeSec = getCachedDuration('BICYCLING', from, to);
    if (bikeSec === null) return null;
    const park = CONFIG.BIKE.parkMinutes;
    return {
      sec: bikeSec + park * 60,
      line: `🚲 Bike to the station (${Math.round(bikeSec / 60)} mins) and park your bike (${park} mins)`
    };
  }

  const walkSec = getCachedDuration('WALKING', from, to);
  if (walkSec !== null && walkSec <= CONFIG.MODE_SELECTION.walkIfUnderMinutes * 60) {
    return { sec: walkSec, line: `🚶 Walk ${Math.round(walkSec / 60)} mins` };
  }

  // Too far to walk: local public transport, with a few minutes to wait for it.
  try {
    const route = requestDirections('TRANSIT', from, to, targetTime, isDepartureTime);
    if (route) {
      const sec = route.legs[0].duration.value + NS_LOCAL_TRANSIT_WAIT_MIN * 60;
      return { sec, line: `${TRAVEL_MODES.TRANSIT.emoji} Local public transport, about ${Math.round(sec / 60)} mins (see Google Maps)` };
    }
  } catch (e) {
    console.warn(`  -> Transit to/from the station failed: ${e}`);
    failedRequests++;
  }
  return walkSec === null ? null : { sec: walkSec, line: `🚶 Walk ${Math.round(walkSec / 60)} mins` };
}

/** Station-to-station trips around the given time (station codes like "DT"). */
function fetchNsTrips(fromCode, toCode, time, searchForArrival) {
  const data = nsApiGet('/v3/trips', {
    fromStation: fromCode,
    toStation: toCode,
    dateTime: formatNsDateTime(time),
    searchForArrival,
    lang: CONFIG.NS.language || 'en'
  });
  return ((data && data.trips) || []).filter(t => t.legs && t.legs.length > 0 && t.status !== 'CANCELLED');
}

/**
 * The NS stations nearest to a point, closest first, cached for 6 hours.
 * Each has code, namen.lang, lat, lng and distance (meters).
 */
function findNearestStations(point, limit) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `nsnear_${point.lat.toFixed(4)}_${point.lng.toFixed(4)}_${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const data = nsApiGet('/v2/stations/nearest', { lat: point.lat, lng: point.lng, limit });
  if (!data) return [];
  const stations = (data.payload || [])
    .filter(s => s.code && s.lat !== undefined)
    .map(s => ({ code: s.code, namen: { lang: s.namen.lang }, lat: s.lat, lng: s.lng, distance: s.distance }));
  cache.put(cacheKey, JSON.stringify(stations), 6 * 60 * 60);
  return stations;
}

function stationLocation(station) {
  return `${station.lat},${station.lng}`;
}

/** GET request to the NS API; returns the parsed JSON, or null on an error. */
function nsApiGet(path, params) {
  const query = Object.keys(params)
    .map(k => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');

  const response = UrlFetchApp.fetch(`${NS_API_BASE}${path}?${query}`, {
    method: 'get',
    headers: {
      'Ocp-Apim-Subscription-Key': getSetting('NS_API_KEY'),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    console.warn(`  -> NS API error [HTTP ${response.getResponseCode()}]: ${response.getContentText().substring(0, 300)}`);
    failedRequests++;
    return null;
  }
  return JSON.parse(response.getContentText());
}

function nsTripUrl(trip) {
  return trip.shareUrl && trip.shareUrl.uri ? trip.shareUrl.uri : NS_PLANNER_URL;
}

function formatNsStepsHtml(trip, firstLine, lastLine) {
  const lines = ['<b>🚆 NS Journey:</b>'];
  if (firstLine) lines.push(firstLine);

  trip.legs.forEach((leg, idx) => {
    const dep = formatTime(parseNsDate(nsTime(leg.origin)));
    const arr = formatTime(parseNsDate(nsTime(leg.destination)));
    const originName = escapeHtml(leg.origin.name);
    const destinationName = escapeHtml(leg.destination.name);
    const cancelled = leg.cancelled ? ' <b>❌ CANCELLED</b>' : '';

    if (leg.travelType === 'WALK') {
      lines.push(`${idx + 1}. [${dep}] Walk from <i>${originName}</i> ➔ <i>${destinationName}</i> [${arr}]`);
      return;
    }

    const product = leg.product
      ? (leg.product.displayName || leg.product.longCategoryName || leg.product.shortCategoryName)
      : (leg.name || 'Train');
    const direction = leg.direction ? ` towards ${escapeHtml(leg.direction)}` : '';
    const track = leg.origin.actualTrack || leg.origin.plannedTrack;
    const trackText = track ? ` (track ${escapeHtml(track)})` : '';
    const crowd = leg.crowdForecast && leg.crowdForecast !== 'UNKNOWN'
      ? ` · crowd: ${leg.crowdForecast.toLowerCase()}`
      : '';

    lines.push(`${idx + 1}. <b>[${dep}] ${escapeHtml(product)}${direction}</b> from <i>${originName}</i>${trackText} ➔ <i>${destinationName}</i> [${arr}]${crowd}${cancelled}`);
  });

  if (lastLine) lines.push(lastLine);
  return lines.join('<br>');
}

// --- NS HELPERS ---

/** Prefer real-time data when NS has it. */
function nsTime(stop) {
  return stop.actualDateTime || stop.plannedDateTime;
}

/** NS returns offsets like "+0200"; make them ISO 8601 ("+02:00") before parsing. */
function parseNsDate(value) {
  return new Date(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

function formatNsDateTime(date) {
  return Utilities.formatDate(date, NS_TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssZ")
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

/**
 * Address -> { lat, lng } using Google's geocoder, cached for 6 hours.
 */
function geocodeAddress(address) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `geo_${shortHash(address, 32)}`;

  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Already coordinates ("52.0067,4.3564"), e.g. the station where your bike is.
  const coordinates = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(address);
  if (coordinates) return { lat: Number(coordinates[1]), lng: Number(coordinates[2]) };

  const response = Maps.newGeocoder().geocode(address);
  if (!response.results || response.results.length === 0) {
    console.warn(`  -> Could not geocode "${address}"`);
    return null;
  }

  const location = response.results[0].geometry.location;
  const result = { lat: location.lat, lng: location.lng };
  cache.put(cacheKey, JSON.stringify(result), 6 * 60 * 60);
  return result;
}

/**
 * Run from the editor to check your NS API key.
 */
function testNsRoute() {
  const arriveAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const route = getNsRoute('Amsterdam Centraal', 'Rotterdam Centraal', arriveAt, false, false);
  console.log(route ? JSON.stringify(route, null, 2) : 'No NS route. Is NS_API_KEY set?');
}
