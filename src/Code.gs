/**
 * Automated Travel Block Generator for Google Calendar
 *
 * Creates "travel blocks" in a separate calendar before (and after) your events,
 * telling you when to leave and how to get there: walking, biking, public transport
 * (Google Maps and NS) or driving. It keeps track of where your bike is.
 *
 * Setup:
 * 1. Add all .gs files from this project to a new project on https://script.google.com/
 * 2. Fill in Config.gs (or set TARGET_CALENDAR_ID, HOME_LOCATION and NS_API_KEY as Script Properties).
 * 3. Run installTriggers() once, or run processTravelBlocks() manually.
 */

const SOURCE_TAG = 'SOURCE_EVENT_ID';
const STATE_PREFIX = 'TRAVEL_STATE_';
const MAX_RUNTIME_MS = 5 * 60 * 1000; // Apps Script stops a run after 6 minutes
const CODE_FINGERPRINT_KEY = 'CODE_FINGERPRINT';
const MAX_CALENDAR_TRIGGERS = 15;      // Apps Script allows 20 triggers per script

// Route requests / block creations that failed during this run.
let failedRequests = 0;

/**
 * Main Trigger Function
 */
function onCalendarChange() {
  processTravelBlocks();
}

/**
 * Installs a trigger on every source calendar plus a daily run that keeps the
 * lookahead window moving. Safe to run again; it replaces its own triggers.
 */
function installTriggers() {
  applyLocalConfig();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onCalendarChange')
    .forEach(t => ScriptApp.deleteTrigger(t));

  syncCalendarTriggers(getSourceCalendars().map(s => s.calendar.getId()));

  ScriptApp.newTrigger('onCalendarChange').timeBased().everyDays(1).atHour(5).create();
  console.log('Installed daily trigger (around 05:00).');
}

/**
 * Makes sure there is a calendar trigger for exactly the given calendars, so
 * calendars you enable or disable later are picked up by the next run.
 */
function syncCalendarTriggers(calendarIds) {
  const wanted = calendarIds.slice(0, MAX_CALENDAR_TRIGGERS);
  if (calendarIds.length > wanted.length) {
    console.warn(`Only ${MAX_CALENDAR_TRIGGERS} calendars can have a change trigger; the others are checked by the daily run.`);
  }

  const installed = new Set();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onCalendarChange' && t.getEventType() === ScriptApp.EventType.ON_EVENT_UPDATED)
    .forEach(t => {
      const id = t.getTriggerSourceId();
      if (wanted.includes(id) && !installed.has(id)) {
        installed.add(id);
      } else {
        ScriptApp.deleteTrigger(t);
        console.log(`Removed calendar trigger for ${id}`);
      }
    });

  wanted.filter(id => !installed.has(id)).forEach(id => {
    try {
      ScriptApp.newTrigger('onCalendarChange').forUserCalendar(id).onEventUpdated().create();
      console.log(`Installed calendar trigger for ${id}`);
    } catch (e) {
      console.warn(`Could not install a trigger for calendar ${id}: ${e}`);
    }
  });
}

/**
 * Main Orchestrator Logic
 */
function processTravelBlocks() {
  const deadline = Date.now() + MAX_RUNTIME_MS;
  applyLocalConfig();
  // Calendar triggers can fire in quick succession; never run two scans at once.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3 * 60 * 1000)) {
    console.log('Another scan is still running; skipping this one.');
    return;
  }
  try {
    runScan(deadline);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Forgets which events were already processed, so every travel block is recalculated.
 */
function forceRefreshAll() {
  const props = PropertiesService.getScriptProperties();
  props.getKeys().filter(k => k.startsWith(STATE_PREFIX)).forEach(k => props.deleteProperty(k));
  processTravelBlocks();
}

/**
 * Picks up where a scan left off when it ran out of time.
 */
function continueProcessing() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'continueProcessing')
    .forEach(t => ScriptApp.deleteTrigger(t));
  processTravelBlocks();
}

function runScan(deadline) {
  const targetCalendarId = getSetting('TARGET_CALENDAR_ID');
  const targetCalendar = CalendarApp.getCalendarById(targetCalendarId);
  if (!targetCalendar) {
    console.error(`Target calendar not found: ${targetCalendarId}. Set TARGET_CALENDAR_ID in Config.gs or as a Script Property.`);
    return;
  }

  const { now, future } = getSearchWindow(CONFIG.SEARCH_RANGE_DAYS);
  console.log(`=== START SCAN: ${now.toLocaleString()} to ${future.toLocaleString()} ===`);

  const sources = getSourceCalendars();
  console.log(`Reading ${sources.length} calendar(s): ${sources.map(s => s.calendar.getName()).join(', ')}`);
  try {
    syncCalendarTriggers(sources.map(s => s.calendar.getId()));
  } catch (e) {
    console.warn(`Could not update calendar triggers: ${e}`);
  }

  const { events: sourceEvents, homes } = fetchAndMergeSourceEvents(sources, now, future);
  console.log(`Found ${sourceEvents.length} eligible source events.`);

  const existingBlocks = indexTravelBlocks(targetCalendar, now, future);
  const manualTravel = findManualTravelInTarget(targetCalendar, now, future);
  const context = { homes, manualTravel };

  // Clean up travel blocks whose source events were deleted
  cleanupOrphanedTravelBlocks(existingBlocks, sourceEvents, now, future);

  const props = PropertiesService.getScriptProperties();
  logCodeUpdate(props);
  const configFingerprint = getConfigFingerprint();
  let unchanged = 0;
  // Where your bike is ({ name, location }); null = at home. Followed trip by trip.
  let bike = null;

  for (let i = 0; i < sourceEvents.length; i++) {
    if (Date.now() > deadline) {
      console.warn(`\nOut of time; the remaining ${sourceEvents.length - i} events continue in a minute.`);
      scheduleContinuation();
      break;
    }

    const currentEvent = sourceEvents[i];
    const eventKey = getEventKey(currentEvent);
    const existing = existingBlocks.get(eventKey) || [];
    const plan = planTrip(sourceEvents, i, context, bike);

    // Keep the existing blocks when nothing that affects the trip has changed.
    const stateKey = getStateKey(eventKey);
    const hash = shortHash(JSON.stringify([plan, configFingerprint]), 24);
    const previous = JSON.parse(props.getProperty(stateKey) || 'null');
    if (previous && previous.hash === hash && previous.blocks === existing.length) {
      if (previous.bike !== undefined) bike = previous.bike;
      unchanged++;
      continue;
    }

    console.log(`\n[Processing] "${currentEvent.getTitle()}" (${currentEvent.getStartTime().toLocaleString()})`);
    console.log(`  -> Resolved Location: "${plan.destination || 'None'}"`);

    // Remove existing travel blocks for this event so they get recalculated cleanly
    deleteBlocks(existing, 'REFRESH: Removing old travel block');

    const failuresBefore = failedRequests;
    const result = createBlocksForPlan(targetCalendar, eventKey, plan);
    bike = result.bike;

    // Only remember the result when everything worked, so failures are retried next run.
    if (failedRequests === failuresBefore) {
      props.setProperty(stateKey, JSON.stringify({ hash, blocks: result.created, bike }));
    } else {
      props.deleteProperty(stateKey);
      console.warn('  -> Some requests failed; this event will be retried on the next run.');
    }
  }

  pruneState(props, sourceEvents);
  console.log(`\n=== END SCAN (${unchanged} unchanged events skipped) ===`);
}

/**
 * Everything that determines an event's travel blocks. As long as this stays the
 * same, the existing blocks are kept.
 * @param {Object|null} bike Where your bike is before this trip (null = at home).
 */
function planTrip(sourceEvents, index, context, bike) {
  const event = sourceEvents[index];
  const destination = event.resolvedLocation;
  if (!destination) return { destination: '', bike };

  // Evaluate special keyword rules (e.g. Flight / Vlucht / Vliegen)
  const ruleMatch = getMatchingRule(event.getTitle());
  const bufferMins = ruleMatch ? ruleMatch.arrivalBufferMinutes : CONFIG.ARRIVAL_BUFFER_MINUTES;
  const disableReturnHome = ruleMatch ? ruleMatch.disableReturnHome : false;

  // Where you slept last night and where you sleep tonight (all-day events).
  const day = dayKeyOf(event.getStartTime());
  const morningHome = getNightLocation(previousDayKey(day), context.homes) || getSetting('HOME_LOCATION');
  const eveningHome = getNightLocation(day, context.homes) || getSetting('HOME_LOCATION');

  const { origin, originSource } = determineOrigin(sourceEvents, index, morningHome);
  const planReturn = !disableReturnHome && isLastEventOfDay(sourceEvents, index);
  const previous = findPreviousEvent(sourceEvents, index);
  const eventStart = event.getStartTime().getTime();
  const eventEnd = event.getEndTime().getTime();
  const previousEnd = previous ? previous.getEndTime().getTime() : null;

  // Leaving from home means your bike is at home.
  if (isActualHome(origin)) bike = null;

  return {
    destination,
    origin,
    originSource,
    ruleMatched: Boolean(ruleMatch),
    bufferMins,
    disableReturnHome,
    eventStart,
    arrivalTime: eventStart - (bufferMins * 60 * 1000),
    previousTitle: previous ? previous.getTitle() : null,
    previousEnd,
    bike,
    manualOutbound: findManualOutbound(context.manualTravel, eventStart, previousEnd),
    manualReturn: planReturn ? findManualReturn(context.manualTravel, eventEnd) : null,
    returnStart: planReturn ? eventEnd : null,
    home: planReturn ? eveningHome : null
  };
}

/**
 * Creates the outbound (and, if needed, return) travel block.
 * Returns how many were created and where your bike is afterwards.
 */
function createBlocksForPlan(targetCalendar, eventKey, plan) {
  let bike = plan.bike;
  if (!plan.destination) {
    console.log(`  -> SKIP: No location specified or resolved from defaults.`);
    return { created: 0, bike };
  }

  if (plan.ruleMatched) {
    console.log(`  -> SPECIAL RULE MATCHED: Buffer set to ${plan.bufferMins} mins | Disable Return: ${plan.disableReturnHome}`);
  }

  let created = 0;
  if (plan.manualOutbound) {
    console.log(`  -> SKIP: You already planned travel yourself ("${plan.manualOutbound.title}").`);
  } else {
    const outbound = handleOutboundTravel(targetCalendar, eventKey, plan);
    created += outbound.created;
    bike = bikeAfter(outbound.route, bike, plan.destination);
  }

  // Handle Return Travel Block if last event of the day AND return is not disabled by a rule
  if (plan.disableReturnHome) {
    console.log(`  -> SKIP RETURN: Return travel disabled by special rule.`);
  } else if (plan.manualReturn) {
    console.log(`  -> SKIP RETURN: You already planned travel yourself ("${plan.manualReturn.title}").`);
  } else if (plan.returnStart) {
    const back = handleReturnTravel(targetCalendar, eventKey, plan, bike);
    created += back.created;
    bike = back.bike;
  }
  return { created, bike };
}

/**
 * Where your bike is after a trip: where you biked to, where you parked it before
 * taking public transport, or else still where it was.
 */
function bikeAfter(route, bike, destination) {
  if (!route) return bike;
  if (route.pickedUpBike) return null;
  if (route.key === 'BICYCLING') return isActualHome(destination) ? null : { name: destination, location: destination };
  if (route.bikeParkedAt) return route.bikeParkedAt;
  return bike;
}

/** Whether your bike is at the given location (null = at home). */
function hasBikeAt(bike, location) {
  return bike ? bike.location === location : isActualHome(location);
}

/**
 * Creates the outbound travel block. When you would have to leave before the
 * previous event ends, the trip doesn't fit: then two ❗ blocks are created, one
 * that arrives on time (leaving early) and one that leaves on time (arriving late).
 * Returns how many blocks were created and the route you take (for the bike).
 */
function handleOutboundTravel(targetCalendar, eventKey, plan) {
  const withBike = hasBikeAt(plan.bike, plan.origin);
  const routes = calculateAllRoutes(plan.origin, plan.destination, new Date(plan.arrivalTime), false, withBike, plan.bike);
  const selectedRoute = selectBestTravelMode(routes);
  if (!isUsableRoute(selectedRoute, '')) return { created: 0, route: null };

  const base = {
    targetCalendar,
    eventKey,
    isReturn: false,
    origin: plan.origin,
    destination: plan.destination,
    originSource: plan.originSource,
    bufferMins: plan.bufferMins
  };

  const fits = !plan.previousEnd || selectedRoute.departureTime.getTime() >= plan.previousEnd;
  if (fits) {
    const ok = createTravelBlock(Object.assign({ selectedRoute, routes }, base));
    return { created: ok ? 1 : 0, route: selectedRoute };
  }

  // Not enough time: see what happens when you leave as soon as the previous event ends.
  const previousEnd = new Date(plan.previousEnd);
  const leaveRoutes = calculateAllRoutes(plan.origin, plan.destination, previousEnd, true, withBike, plan.bike);
  const leaveRoute = selectBestTravelMode(leaveRoutes);
  const previous = `"${escapeHtml(plan.previousTitle)}" ends at ${formatTime(previousEnd)}`;

  // Still there before the event starts (only less buffer): one block is enough.
  if (leaveRoute && leaveRoute.arrivalTime.getTime() <= plan.eventStart) {
    console.log(`  -> TIGHT: Leaving when the previous event ends still gets you there before the start.`);
    const ok = createTravelBlock(Object.assign({}, base, {
      selectedRoute: leaveRoute,
      routes: leaveRoutes,
      note: `${previous}; leaving right after it you arrive ${formatTime(leaveRoute.arrivalTime)}, with less buffer than usual.`
    }));
    return { created: ok ? 1 : 0, route: leaveRoute };
  }

  console.log(`  -> CONFLICT: Not enough time after the previous event; creating an "arrive on time" and a "leave on time" block.`);
  let created = 0;
  if (createTravelBlock(Object.assign({}, base, {
    selectedRoute,
    routes,
    warning: 'arrive on time',
    note: `Not enough time: ${previous}. This option leaves before it ends, so you arrive on time.`
  }))) created++;

  if (leaveRoute) {
    const lateMins = Math.ceil((leaveRoute.arrivalTime.getTime() - plan.eventStart) / 60000);
    if (createTravelBlock(Object.assign({}, base, {
      selectedRoute: leaveRoute,
      routes: leaveRoutes,
      warning: `${lateMins} min late`,
      note: `Not enough time: ${previous}. This option leaves when it ends and arrives ${lateMins} min after the start.`
    }))) created++;
  }
  return { created, route: selectedRoute };
}

/**
 * Handles generating a return travel block for the last event of the day. Going
 * to your actual home you take your bike along: ride it home when you have it
 * with you, or first travel to where you parked it. Returns { created, bike }.
 */
function handleReturnTravel(targetCalendar, eventKey, plan, bike) {
  const endTime = new Date(plan.returnStart);
  const withBike = hasBikeAt(bike, plan.destination);
  const fetchBike = isActualHome(plan.home) && bike !== null && !withBike;

  console.log(`  -> CHECKING RETURN: Last event of day. Processing return home...`);

  let returnRoutes;
  let selectedRoute;
  if (fetchBike) {
    console.log(`  -> Your bike is at ${bike.name}; going there first.`);
    returnRoutes = calculateAllRoutes(plan.destination, bike.location, endTime, true, false, bike);
    returnRoutes.toBike = bike.name;
    selectedRoute = withBikeRide(selectBestTravelMode(returnRoutes), bike, plan.home, endTime);
  } else {
    returnRoutes = calculateAllRoutes(plan.destination, plan.home, endTime, true, withBike, bike);
    // With your bike at the event you ride it home.
    selectedRoute = isActualHome(plan.home) && withBike && returnRoutes.BICYCLING
      ? returnRoutes.BICYCLING
      : selectBestTravelMode(returnRoutes);
  }

  if (!isUsableRoute(selectedRoute, ' (Return)')) return { created: 0, bike };

  const ok = createTravelBlock({
    targetCalendar,
    eventKey,
    isReturn: true,
    origin: plan.destination,
    destination: plan.home,
    originSource: 'Last Event Location',
    selectedRoute,
    routes: returnRoutes,
    bufferMins: 0
  });
  return { created: ok ? 1 : 0, bike: bikeAfter(selectedRoute, bike, plan.home) };
}

/**
 * Trip home via your parked bike: travel to it (route; null or very short when
 * it's right there), pick it up and ride home.
 */
function withBikeRide(route, bike, home, endTime) {
  const rideSec = getCachedDuration('BICYCLING', bike.location, home);
  if (rideSec === null) return route;

  const pickUpMs = CONFIG.BIKE.pickUpMinutes * 60 * 1000;
  const reachBike = route && route.durationSec >= CONFIG.MIN_TRAVEL_DURATION_SEC ? route : null;
  const mode = reachBike ? TRAVEL_MODES[reachBike.key] : TRAVEL_MODES.BICYCLING;
  const departureTime = reachBike ? reachBike.departureTime : endTime;
  const arrivalTime = new Date((reachBike ? reachBike.arrivalTime.getTime() : endTime.getTime()) + pickUpMs + rideSec * 1000);
  const durationMins = Math.round((arrivalTime - departureTime) / 60000);
  const rideLine = `🚲 Pick up your bike at <i>${escapeHtml(bike.name)}</i> (${CONFIG.BIKE.pickUpMinutes} min) and bike home: ${Math.round(rideSec / 60)} mins`;

  return {
    key: reachBike ? reachBike.key : 'BICYCLING',
    label: reachBike ? `${reachBike.label || mode.label} + bike` : mode.label,
    emoji: reachBike ? `${reachBike.emoji || mode.emoji}🚲` : mode.emoji,
    durationSec: durationMins * 60,
    durationText: `${durationMins} mins`,
    departureTime,
    arrivalTime,
    url: reachBike ? reachBike.url : buildGoogleMapsUrl(bike.location, home, mode.urlCode, endTime, true),
    stepsHtml: [reachBike ? reachBike.stepsHtml : '', rideLine].filter(Boolean).join('<br>'),
    pickedUpBike: true
  };
}

function isUsableRoute(route, label) {
  if (!route) {
    console.log(`  -> SKIP${label}: No valid route found.`);
    return false;
  }
  if (route.durationSec < CONFIG.MIN_TRAVEL_DURATION_SEC) {
    const mins = (route.durationSec / 60).toFixed(1);
    const minThresholdMins = (CONFIG.MIN_TRAVEL_DURATION_SEC / 60).toFixed(1);
    console.log(`  -> SKIP${label}: Too short (${mins} mins below threshold of ${minThresholdMins} mins).`);
    return false;
  }
  return true;
}

/**
 * Finds matching special rule based on title keywords
 */
function getMatchingRule(eventTitle) {
  if (!CONFIG.SPECIAL_RULES || !eventTitle) return null;
  const lowerTitle = eventTitle.toLowerCase();

  return CONFIG.SPECIAL_RULES.find(rule =>
    rule.keywords.some(kw => lowerTitle.includes(kw.toLowerCase()))
  ) || null;
}

// --- HOME, PREVIOUS EVENT AND MANUAL TRAVEL ---

/**
 * Where you sleep the night after the given day ('yyyy-MM-dd'), according to your
 * all-day events, or null for your normal home. An all-day event spanning several
 * days covers the nights in between: from the first day until the morning of the
 * last day. Single-day events are not stays (see fetchAndMergeSourceEvents).
 */
function getNightLocation(day, homes) {
  const covering = (homes || []).filter(h => h.firstDay <= day && day < h.lastDay);
  if (covering.length === 0) return null;
  // Several? The one that started last (e.g. a night elsewhere during a longer stay).
  return covering.reduce((best, h) => (h.firstDay > best.firstDay ? h : best)).location;
}

function isActualHome(location) {
  return location === getSetting('HOME_LOCATION');
}

function dayKeyOf(date) {
  return Utilities.formatDate(date, getTimeZone(), 'yyyy-MM-dd');
}

/** The day before a 'yyyy-MM-dd' day (calendar arithmetic, safe around DST). */
function previousDayKey(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().substring(0, 10);
}

/**
 * The event that ends last before this one starts (and not longer ago than
 * MAX_GAP_BEFORE_HOME_HOURS). You can only leave once it is over.
 */
function findPreviousEvent(events, index) {
  const start = events[index].getStartTime().getTime();
  const maxGapMs = CONFIG.MAX_GAP_BEFORE_HOME_HOURS * 60 * 60 * 1000;
  let previous = null;
  for (let j = 0; j < index; j++) {
    const end = events[j].getEndTime().getTime();
    if (end <= start && start - end < maxGapMs && (!previous || end > previous.getEndTime().getTime())) {
      previous = events[j];
    }
  }
  return previous;
}

/**
 * A travel event you added yourself that ends shortly before the event starts
 * (and after the previous event ended). Returns { title, start, end } or null.
 */
function findManualOutbound(manualTravel, eventStart, previousEnd) {
  const windowMs = CONFIG.MANUAL_TRAVEL.windowMinutes * 60 * 1000;
  const earliestEnd = Math.max(eventStart - windowMs, previousEnd || 0);
  return (manualTravel || []).find(m =>
    m.start < eventStart && m.end >= earliestEnd && m.end <= eventStart + 15 * 60 * 1000) || null;
}

/**
 * A travel event you added yourself that starts shortly after the event ends.
 */
function findManualReturn(manualTravel, eventEnd) {
  const windowMs = CONFIG.MANUAL_TRAVEL.windowMinutes * 60 * 1000;
  return (manualTravel || []).find(m =>
    m.end > eventEnd && m.start >= eventEnd - 15 * 60 * 1000 && m.start <= eventEnd + windowMs) || null;
}

function toManualTravel(event) {
  return { title: event.getTitle(), start: event.getStartTime().getTime(), end: event.getEndTime().getTime() };
}

/**
 * Events you added to the travel calendar yourself (everything without our tag).
 */
function findManualTravelInTarget(targetCalendar, windowStart, windowEnd) {
  const searchStart = new Date(windowStart.getTime() - (24 * 60 * 60 * 1000));
  return targetCalendar.getEvents(searchStart, windowEnd)
    .filter(evt => !evt.getTag(SOURCE_TAG) && !evt.isAllDayEvent())
    .map(toManualTravel);
}

// --- TRAVEL BLOCK BOOKKEEPING ---

/**
 * Unique key per event occurrence. Recurring events share one ID, so the start
 * time is included to keep every occurrence's travel blocks apart.
 */
function getEventKey(event) {
  return `${event.getId()}_${event.getStartTime().getTime()}`;
}

/**
 * Returns a Map of event key -> travel blocks created for that event.
 */
function indexTravelBlocks(targetCalendar, windowStart, windowEnd) {
  // Look back a day: blocks for upcoming events may already have started or ended.
  const searchStart = new Date(windowStart.getTime() - (24 * 60 * 60 * 1000));
  const searchEnd = new Date(windowEnd.getTime() + (24 * 60 * 60 * 1000));
  const index = new Map();

  targetCalendar.getEvents(searchStart, searchEnd).forEach(evt => {
    const key = evt.getTag(SOURCE_TAG);
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(evt);
  });
  return index;
}

/**
 * Removes travel blocks whose source event no longer exists. Blocks belonging to
 * events outside the scan window are left alone (so past trips stay in your history).
 */
function cleanupOrphanedTravelBlocks(existingBlocks, validSourceEvents, windowStart, windowEnd) {
  const validKeys = new Set(validSourceEvents.map(getEventKey));

  existingBlocks.forEach((blocks, key) => {
    if (validKeys.has(key)) return;
    const sourceStart = Number(key.substring(key.lastIndexOf('_') + 1));
    const sourceInWindow = !sourceStart || (sourceStart >= windowStart.getTime() && sourceStart <= windowEnd.getTime());
    if (sourceInWindow) {
      deleteBlocks(blocks, `ORPHAN CLEANUP: Deleting travel block (source event no longer exists)`);
    }
  });
}

function deleteBlocks(blocks, message) {
  (blocks || []).forEach(evt => {
    console.log(`  -> ${message}`);
    evt.deleteEvent();
  });
}

/**
 * Script Property that stores the trip hash and block count of an event.
 */
function getStateKey(eventKey) {
  return STATE_PREFIX + shortHash(eventKey, 24);
}

/**
 * Removes stored hashes of events that are no longer in the scan window.
 */
function pruneState(props, sourceEvents) {
  const current = new Set(sourceEvents.map(e => getStateKey(getEventKey(e))));
  props.getKeys()
    .filter(k => k.startsWith(STATE_PREFIX) && !current.has(k))
    .forEach(k => props.deleteProperty(k));
}

/**
 * Code and settings that affect every travel block; changing any of them refreshes
 * all upcoming blocks.
 */
function getConfigFingerprint() {
  return JSON.stringify([getCodeFingerprint(), CONFIG, getSetting('HOME_LOCATION'), Boolean(getSetting('NS_API_KEY'))]);
}

/**
 * Fingerprint of the script's own code: the source of every function in the project
 * plus the lookup tables. Updating the script changes it, so all upcoming travel
 * blocks are recreated once. No version number to remember to bump.
 */
function getCodeFingerprint() {
  const scope = globalThis;
  const sources = Object.getOwnPropertyNames(scope)
    .map(name => {
      try {
        return typeof scope[name] === 'function' ? scope[name].toString() : null;
      } catch (e) {
        return null;
      }
    })
    .filter(source => source && !source.includes('[native code]'))
    .sort();

  if (!sources.some(source => source.startsWith('function processTravelBlocks('))) {
    console.warn('Could not read the script source; code updates will not refresh travel blocks automatically.');
  }

  const tables = [TRAVEL_MODES, ROUTE_DISPLAY_ORDER, GOOGLE_MODE_KEYS, TRANSIT_SEARCH_SHIFT_MIN,
    ALTERNATIVE_WINDOW_MIN, NS_TRIPS_URL, NS_TIME_ZONE, NS_PLANNER_URL, NS_API_BASE, NS_LOCAL_TRANSIT_WAIT_MIN, SOURCE_TAG];
  return shortHash(JSON.stringify([sources, tables]), 16);
}

/**
 * Logs when the script code changed since the last run.
 */
function logCodeUpdate(props) {
  const fingerprint = getCodeFingerprint();
  const previous = props.getProperty(CODE_FINGERPRINT_KEY);
  if (previous !== fingerprint) {
    console.log(`Script code ${previous ? 'updated' : 'first run'} (version ${fingerprint}): recalculating all upcoming travel blocks.`);
    props.setProperty(CODE_FINGERPRINT_KEY, fingerprint);
  } else {
    console.log(`Script version ${fingerprint}`);
  }
}

function scheduleContinuation() {
  const alreadyScheduled = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'continueProcessing');
  if (!alreadyScheduled) {
    ScriptApp.newTrigger('continueProcessing').timeBased().after(60 * 1000).create();
  }
}

// --- HELPER FUNCTIONS ---

function shortHash(text, length) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest).substring(0, length);
}

/**
 * Merges LOCAL_CONFIG (from the optional, git-ignored Config.local.gs) into CONFIG.
 * Done at runtime so it works no matter in which order the files are loaded.
 */
function applyLocalConfig() {
  if (CONFIG._localApplied || typeof LOCAL_CONFIG === 'undefined') return;
  Object.keys(LOCAL_CONFIG).forEach(key => {
    const value = LOCAL_CONFIG[key];
    const isPlainObject = value && typeof value === 'object' && !Array.isArray(value);
    CONFIG[key] = isPlainObject ? Object.assign({}, CONFIG[key], value) : value;
  });
  CONFIG._localApplied = true;
}

/**
 * Reads a setting from Script Properties, falling back to CONFIG.
 */
function getSetting(name) {
  applyLocalConfig();
  const value = PropertiesService.getScriptProperties().getProperty(name);
  return value ? value : CONFIG[name];
}

function getTimeZone() {
  return CONFIG.TIME_ZONE || Session.getScriptTimeZone();
}

function formatTime(date) {
  return Utilities.formatDate(date, getTimeZone(), 'HH:mm');
}

function getSearchWindow(days) {
  const now = new Date();
  const future = new Date(now.getTime() + (days * 24 * 60 * 60 * 1000));
  return { now, future };
}

/**
 * The calendars to read events from, each with its settings from SOURCE_CALENDARS.
 * By default that's every calendar that is enabled (checked) in Google Calendar,
 * except the travel calendar itself.
 */
function getSourceCalendars() {
  const targetId = getSetting('TARGET_CALENDAR_ID');
  const configs = CONFIG.SOURCE_CALENDARS || [];
  const defaultId = CalendarApp.getDefaultCalendar().getId();
  const configFor = id => configs.find(cfg => (cfg.id === 'primary' ? defaultId : cfg.id) === id) || {};

  let calendars;
  if (CONFIG.USE_ALL_ENABLED_CALENDARS) {
    calendars = CalendarApp.getAllCalendars().filter(cal => cal.isSelected() && !cal.isHidden());
  } else {
    calendars = configs.map(cfg => {
      const cal = CalendarApp.getCalendarById(cfg.id);
      if (!cal) console.warn(`Could not access source calendar: ${cfg.id}`);
      return cal;
    }).filter(Boolean);
  }

  return calendars
    .filter(cal => cal.getId() !== targetId)
    .map(calendar => ({ calendar, cfg: configFor(calendar.getId()) }));
}

/**
 * Reads the source calendars. Returns the events that need travel, plus the
 * all-day events that say where you sleep ({ firstDay, lastDay, location }).
 */
function fetchAndMergeSourceEvents(sources, start, end) {
  const events = [];
  const homes = [];
  const seen = new Set();
  // A day earlier, to know where you slept last night.
  const lookBack = new Date(start.getTime() - (24 * 60 * 60 * 1000));

  sources.forEach(({ calendar, cfg }) => {
    calendar.getEvents(lookBack, end).forEach(event => {
      if (event.getTag(SOURCE_TAG)) return;   // One of our own travel blocks
      if (CONFIG.SKIP_DECLINED_EVENTS && event.getMyStatus() === CalendarApp.GuestStatus.NO) return;

      // The same event can show up in several calendars (e.g. a shared one).
      const key = getEventKey(event);
      if (seen.has(key)) return;
      seen.add(key);

      const rawLocation = event.getLocation() ? singleLine(event.getLocation()) : '';

      if (event.isAllDayEvent()) {
        const firstDay = dayKeyOf(event.getStartTime());
        const lastDay = dayKeyOf(new Date(event.getEndTime().getTime() - 1));
        // Only a multi-day event is a stay; a single-day one (a festival, a day out) is not.
        if (CONFIG.ALL_DAY_EVENT_IS_HOME && rawLocation && firstDay < lastDay) {
          homes.push({ firstDay, lastDay, location: rawLocation });
        }
        return;
      }
      if (event.getEndTime() <= start) return;

      let finalLocation = '';
      if (rawLocation) {
        finalLocation = (cfg.locationPrefix || '') + rawLocation;
      } else if (cfg.defaultLocation) {
        finalLocation = cfg.defaultLocation;
      }

      event.resolvedLocation = finalLocation;
      events.push(event);
    });
  });

  events.sort((a, b) => a.getStartTime() - b.getStartTime());
  return { events, homes };
}

function determineOrigin(events, currentIndex, home) {
  let origin = home;
  let originSource = 'Default (Home)';

  if (currentIndex > 0) {
    const prevEvent = events[currentIndex - 1];
    if (prevEvent.resolvedLocation) {
      const diffHours = (events[currentIndex].getStartTime() - prevEvent.getEndTime()) / (1000 * 60 * 60);

      if (diffHours >= 0 && diffHours < CONFIG.MAX_GAP_BEFORE_HOME_HOURS) {
        origin = prevEvent.resolvedLocation;
        originSource = `Previous Event "${prevEvent.getTitle()}"`;
      }
    }
  }
  return { origin, originSource };
}

function isLastEventOfDay(events, currentIndex) {
  if (currentIndex >= events.length - 1) return true;
  const dayOf = event => Utilities.formatDate(event.getStartTime(), getTimeZone(), 'yyyy-MM-dd');
  return dayOf(events[currentIndex]) !== dayOf(events[currentIndex + 1]);
}

// --- CALENDAR EVENT OUTPUT ---

function createTravelBlock({ targetCalendar, eventKey, isReturn, origin, destination, originSource, selectedRoute, routes, bufferMins, warning, note }) {
  // The block covers the actual travel: for public transport that's from leaving
  // until arriving, which can be earlier than the arrival buffer.
  const start = selectedRoute.departureTime;
  const end = selectedRoute.arrivalTime;
  const leaveAt = formatTime(start);
  const emoji = selectedRoute.emoji || TRAVEL_MODES[selectedRoute.key].emoji;
  const label = selectedRoute.label || TRAVEL_MODES[selectedRoute.key].label;
  const eventTitle = `${warning ? '❗ ' : ''}${emoji} Leave ${leaveAt} · ${label}${isReturn ? ' home' : ''}${warning ? ` · ${warning}` : ''}`;

  const htmlDescription = [
    note ? `${warning ? '❗ ' : ''}<b>${note}</b><br>` : null,
    `📍 <a href="${selectedRoute.url}"><b>Open ${selectedRoute.key === 'NS' ? 'NS Journey Planner' : 'Google Maps Directions'}</b></a>`,
    `<br><b>Mode:</b> ${label}${isReturn ? ' (Return)' : ''}`,
    `<b>Route:</b> ${escapeHtml(singleLine(origin))} ➔ ${escapeHtml(singleLine(destination))}`,
    `<b>Origin Source:</b> ${escapeHtml(originSource)}`,
    `<b>Duration:</b> ${selectedRoute.durationText}`,
    isReturn ? null : `<b>Buffer:</b> ${bufferMins} mins before event`,
    `<br>${formatAllRouteSummaryHtml(routes, selectedRoute.key)}`,
    `<br>${selectedRoute.stepsHtml}`
  ].filter(line => line !== null).join('<br>');

  try {
    const newEvent = targetCalendar.createEvent(eventTitle, start, end, {
      description: htmlDescription,
      location: singleLine(origin)
    });

    newEvent.setTag(SOURCE_TAG, eventKey);

    console.log(`  -> CREATED: "${eventTitle}" [${start.toLocaleTimeString()} - ${end.toLocaleTimeString()}]`);
    return true;
  } catch (e) {
    console.error(`  -> ERROR: Failed to create event: ${e}`);
    failedRequests++;
    return false;
  }
}

/**
 * Lists every travel mode with its leave time, each linking to that specific mode.
 * Public transport also lists the connection before and after.
 */
function formatAllRouteSummaryHtml(routes, selectedKey) {
  const lines = [`<b>📊 Travel Options${routes.toBike ? ` to your bike at ${escapeHtml(routes.toBike)}` : ''}:</b>`];

  ROUTE_DISPLAY_ORDER.forEach(key => {
    const mode = TRAVEL_MODES[key];
    const r = routes[key];
    if (!r) {
      if (key === 'BICYCLING' && routes.bikeAway) {
        lines.push(`• ${mode.emoji} ${mode.label}: <i>your bike is at ${escapeHtml(routes.bikeAway)}</i>`);
      } else if (key !== 'NS' || getSetting('NS_API_KEY')) {
        // Without an NS key the NS option is simply left out.
        lines.push(`• ${mode.emoji} ${mode.label}: <i>N/A</i>`);
      }
      return;
    }
    const transfers = r.transfers !== undefined ? ` · ${r.transfers} transfer(s)` : '';
    const fare = r.fareText ? ` · ${escapeHtml(r.fareText)}` : '';
    const marker = key === selectedKey ? ' ✅' : '';
    lines.push(`• <a href="${r.url}">${r.emoji || mode.emoji} ${r.label || mode.label}</a>: <b>${formatTimeSpan(r)}</b>${transfers}${fare}${marker}`);

    const alternatives = r.alternatives || {};
    [['earlier', 'Arrive earlier'], ['later', 'Arrive later']].forEach(([which, label]) => {
      const alt = alternatives[which];
      if (alt) {
        lines.push(`&nbsp;&nbsp;&nbsp;&nbsp;↳ <a href="${alt.url}">${label}</a>: ${formatTimeSpan(alt)}`);
      }
    });
  });

  return lines.join('<br>');
}

/** "14:17 - 14:25 (0:08)": leave time, arrival time and travel time (H:MM). */
function formatTimeSpan(connection) {
  const totalMinutes = Math.round((connection.arrivalTime - connection.departureTime) / 60000);
  const duration = `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')}`;
  return `${formatTime(connection.departureTime)} - ${formatTime(connection.arrivalTime)} (${duration})`;
}

/** Multi-line addresses (common in calendar invites) on one line. */
function singleLine(text) {
  return String(text || '').replace(/\s*[\r\n]+\s*/g, ', ').trim();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
