/**
 * NS (Dutch Railways) door-to-door journey planner.
 * API docs: https://apiportal.ns.nl/ (Reisinformatie API, /api/v3/trips)
 */

const NS_TRIPS_URL = 'https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/trips';
const NS_TIME_ZONE = 'Europe/Amsterdam';

/**
 * Plans an NS journey between two addresses.
 * @param {Date} targetTime Arrival time, or departure time when isDepartureTime is true.
 * @return {Object|null} Normalized route, or null when NS is disabled or has no journey.
 */
function getNsRoute(origin, destination, targetTime, isDepartureTime) {
  const apiKey = getSetting('NS_API_KEY');
  if (!apiKey) return null;

  const from = geocodeAddress(origin);
  const to = geocodeAddress(destination);
  if (!from || !to) return null;

  const params = {
    originLat: from.lat,
    originLng: from.lng,
    originName: origin,
    destinationLat: to.lat,
    destinationLng: to.lng,
    destinationName: destination,
    dateTime: formatNsDateTime(targetTime),
    searchForArrival: !isDepartureTime,
    previousAdvices: 3,   // Extra trips before/after, for the earlier/later options
    nextAdvices: 3,
    lang: CONFIG.NS.language || 'en'
  };
  const query = Object.keys(params)
    .map(k => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');

  const response = UrlFetchApp.fetch(`${NS_TRIPS_URL}?${query}`, {
    method: 'get',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    console.warn(`  -> NS API error [HTTP ${response.getResponseCode()}]: ${response.getContentText().substring(0, 300)}`);
    failedRequests++;
    return null;
  }

  const data = JSON.parse(response.getContentText());
  const candidates = (data.trips || [])
    .filter(t => t.legs && t.legs.length > 0 && t.status !== 'CANCELLED')
    .map(t => ({
      trip: t,
      departureTime: parseNsDate(nsTime(t.legs[0].origin)),
      arrivalTime: parseNsDate(nsTime(t.legs[t.legs.length - 1].destination))
    }));

  const best = pickFastestConnection(candidates, targetTime, isDepartureTime);
  if (!best) return null;

  const trip = best.trip;
  const durationMins = Math.round((best.arrivalTime - best.departureTime) / 60000)
    || trip.actualDurationInMinutes || trip.plannedDurationInMinutes;

  return {
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
    stepsHtml: formatNsStepsHtml(trip),
    alternatives: pickAlternatives(candidates, best, c => nsTripUrl(c.trip))
  };
}

function nsTripUrl(trip) {
  return trip.shareUrl && trip.shareUrl.uri ? trip.shareUrl.uri : 'https://www.ns.nl/en/journeyplanner/';
}

function formatNsStepsHtml(trip) {
  const lines = ['<b>🚆 NS Journey:</b>'];

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
  const route = getNsRoute('Amsterdam Centraal', 'Rotterdam Centraal', arriveAt, false);
  console.log(route ? JSON.stringify(route, null, 2) : 'No NS route. Is NS_API_KEY set?');
}
