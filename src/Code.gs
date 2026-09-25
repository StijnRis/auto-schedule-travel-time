/**
 * Automated Travel Block Generator for Google Calendar
 *
 * Creates "travel blocks" in a separate calendar before (and after) your events,
 * telling you when to leave and how to get there: walking, biking, public transport
 * (Google Maps and NS) or driving.
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

  CONFIG.SOURCE_CALENDARS.forEach(cfg => {
    const calendarId = cfg.id === 'primary' ? Session.getEffectiveUser().getEmail() : cfg.id;
    ScriptApp.newTrigger('onCalendarChange').forUserCalendar(calendarId).onEventUpdated().create();
    console.log(`Installed calendar trigger for ${calendarId}`);
  });

  ScriptApp.newTrigger('onCalendarChange').timeBased().everyDays(1).atHour(5).create();
  console.log('Installed daily trigger (around 05:00).');
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

  const sourceEvents = fetchAndMergeSourceEvents(CONFIG.SOURCE_CALENDARS, now, future);
  console.log(`Found ${sourceEvents.length} eligible source events.`);

  const existingBlocks = indexTravelBlocks(targetCalendar, now, future);

  // Clean up travel blocks whose source events were deleted
  cleanupOrphanedTravelBlocks(existingBlocks, sourceEvents, now, future);

  const props = PropertiesService.getScriptProperties();
  logCodeUpdate(props);
  const configFingerprint = getConfigFingerprint();
  let unchanged = 0;

  for (let i = 0; i < sourceEvents.length; i++) {
    if (Date.now() > deadline) {
      console.warn(`\nOut of time; the remaining ${sourceEvents.length - i} events continue in a minute.`);
      scheduleContinuation();
      break;
    }

    const currentEvent = sourceEvents[i];
    const eventKey = getEventKey(currentEvent);
    const existing = existingBlocks.get(eventKey) || [];
    const plan = planTrip(sourceEvents, i);

    // Keep the existing blocks when nothing that affects the trip has changed.
    const stateKey = getStateKey(eventKey);
    const hash = shortHash(JSON.stringify([plan, configFingerprint]), 24);
    const previous = JSON.parse(props.getProperty(stateKey) || 'null');
    if (previous && previous.hash === hash && previous.blocks === existing.length) {
      unchanged++;
      continue;
    }

    console.log(`\n[Processing] "${currentEvent.getTitle()}" (${currentEvent.getStartTime().toLocaleString()})`);
    console.log(`  -> Resolved Location: "${plan.destination || 'None'}"`);

    // Remove existing travel blocks for this event so they get recalculated cleanly
    deleteBlocks(existing, 'REFRESH: Removing old travel block');

    const failuresBefore = failedRequests;
    const created = createBlocksForPlan(targetCalendar, eventKey, plan);

    // Only remember the result when everything worked, so failures are retried next run.
    if (failedRequests === failuresBefore) {
      props.setProperty(stateKey, JSON.stringify({ hash, blocks: created }));
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
 */
function planTrip(sourceEvents, index) {
  const event = sourceEvents[index];
  const destination = event.resolvedLocation;
  if (!destination) return { destination: '' };

  // Evaluate special keyword rules (e.g. Flight / Vlucht / Vliegen)
  const ruleMatch = getMatchingRule(event.getTitle());
  const bufferMins = ruleMatch ? ruleMatch.arrivalBufferMinutes : CONFIG.ARRIVAL_BUFFER_MINUTES;
  const disableReturnHome = ruleMatch ? ruleMatch.disableReturnHome : false;
  const { origin, originSource } = determineOrigin(sourceEvents, index);
  const planReturn = !disableReturnHome && isLastEventOfDay(sourceEvents, index);

  return {
    destination,
    origin,
    originSource,
    ruleMatched: Boolean(ruleMatch),
    bufferMins,
    disableReturnHome,
    arrivalTime: event.getStartTime().getTime() - (bufferMins * 60 * 1000),
    returnStart: planReturn ? event.getEndTime().getTime() : null,
    home: planReturn ? getSetting('HOME_LOCATION') : null
  };
}

/**
 * Creates the outbound (and, if needed, return) travel block. Returns how many were created.
 */
function createBlocksForPlan(targetCalendar, eventKey, plan) {
  if (!plan.destination) {
    console.log(`  -> SKIP: No location specified or resolved from defaults.`);
    return 0;
  }

  if (plan.ruleMatched) {
    console.log(`  -> SPECIAL RULE MATCHED: Buffer set to ${plan.bufferMins} mins | Disable Return: ${plan.disableReturnHome}`);
  }

  let created = 0;
  const arrivalTime = new Date(plan.arrivalTime);
  const routes = calculateAllRoutes(plan.origin, plan.destination, arrivalTime, false);
  const selectedRoute = selectBestTravelMode(routes);

  // Create Outbound Travel Block
  if (isUsableRoute(selectedRoute, '')) {
    const ok = createTravelBlock({
      targetCalendar,
      eventKey,
      isReturn: false,
      origin: plan.origin,
      destination: plan.destination,
      originSource: plan.originSource,
      selectedRoute,
      routes,
      bufferMins: plan.bufferMins
    });
    if (ok) created++;
  }

  // Handle Return Travel Block if last event of the day AND return is not disabled by a rule
  if (plan.disableReturnHome) {
    console.log(`  -> SKIP RETURN: Return travel disabled by special rule.`);
  } else if (plan.returnStart && handleReturnTravel(targetCalendar, eventKey, plan)) {
    created++;
  }
  return created;
}

/**
 * Handles generating a return travel block back home for the last event of the day
 */
function handleReturnTravel(targetCalendar, eventKey, plan) {
  const endTime = new Date(plan.returnStart);

  console.log(`  -> CHECKING RETURN: Last event of day. Processing return home...`);

  const returnRoutes = calculateAllRoutes(plan.destination, plan.home, endTime, true);
  const selectedRoute = selectBestTravelMode(returnRoutes);

  if (!isUsableRoute(selectedRoute, ' (Return)')) return false;

  return createTravelBlock({
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
    ALTERNATIVE_WINDOW_MIN, NS_TRIPS_URL, NS_TIME_ZONE, SOURCE_TAG];
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
 * Events that never get travel blocks and don't count as a "previous location".
 */
function isIgnoredEvent(event) {
  if (event.getTag(SOURCE_TAG)) return true;   // One of our own travel blocks
  if (event.isAllDayEvent()) return true;
  if (CONFIG.SKIP_DECLINED_EVENTS && event.getMyStatus() === CalendarApp.GuestStatus.NO) return true;
  return false;
}

function fetchAndMergeSourceEvents(calendarConfigs, start, end) {
  let allEvents = [];

  calendarConfigs.forEach(cfg => {
    const cal = CalendarApp.getCalendarById(cfg.id);
    if (!cal) {
      console.warn(`Could not access source calendar: ${cfg.id}`);
      return;
    }

    cal.getEvents(start, end).forEach(event => {
      if (isIgnoredEvent(event)) return;

      const rawLocation = event.getLocation() ? event.getLocation().trim() : '';
      let finalLocation = '';

      if (rawLocation) {
        finalLocation = (cfg.locationPrefix || '') + rawLocation;
      } else if (cfg.defaultLocation) {
        finalLocation = cfg.defaultLocation;
      }

      event.resolvedLocation = finalLocation;
      allEvents.push(event);
    });
  });

  return allEvents.sort((a, b) => a.getStartTime() - b.getStartTime());
}

function determineOrigin(events, currentIndex) {
  let origin = getSetting('HOME_LOCATION');
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

function createTravelBlock({ targetCalendar, eventKey, isReturn, origin, destination, originSource, selectedRoute, routes, bufferMins }) {
  // The block covers the actual travel: for public transport that's from leaving
  // until arriving, which can be earlier than the arrival buffer.
  const start = selectedRoute.departureTime;
  const end = selectedRoute.arrivalTime;
  const leaveAt = formatTime(start);
  const mode = TRAVEL_MODES[selectedRoute.key];
  const eventTitle = `${mode.emoji} Leave ${leaveAt} · ${mode.label}${isReturn ? ' home' : ''}`;

  const htmlDescription = [
    `📍 <a href="${selectedRoute.url}"><b>Open ${selectedRoute.key === 'NS' ? 'NS Journey Planner' : 'Google Maps Directions'}</b></a>`,
    `<br><b>Mode:</b> ${mode.label}${isReturn ? ' (Return)' : ''}`,
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
  const lines = ['<b>📊 Travel Options:</b>'];

  ROUTE_DISPLAY_ORDER.forEach(key => {
    const mode = TRAVEL_MODES[key];
    const r = routes[key];
    if (!r) {
      // Without an NS key the NS option is simply left out.
      if (key !== 'NS' || getSetting('NS_API_KEY')) {
        lines.push(`• ${mode.emoji} ${mode.label}: <i>N/A</i>`);
      }
      return;
    }
    const transfers = r.transfers !== undefined ? ` · ${r.transfers} transfer(s)` : '';
    const fare = r.fareText ? ` · ${escapeHtml(r.fareText)}` : '';
    const marker = key === selectedKey ? ' ✅' : '';
    lines.push(`• <a href="${r.url}">${mode.emoji} ${mode.label}</a>: <b>${formatTimeSpan(r)}</b>${transfers}${fare}${marker}`);

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
