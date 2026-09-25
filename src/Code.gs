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
  // Calendar triggers can fire in quick succession; never run two scans at once.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(4 * 60 * 1000)) {
    console.log('Another scan is still running; skipping this one.');
    return;
  }
  try {
    runScan();
  } finally {
    lock.releaseLock();
  }
}

function runScan() {
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

  for (let i = 0; i < sourceEvents.length; i++) {
    const currentEvent = sourceEvents[i];
    const eventKey = getEventKey(currentEvent);
    const title = currentEvent.getTitle();
    const location = currentEvent.resolvedLocation;
    const startTime = currentEvent.getStartTime();

    console.log(`\n[Processing] "${title}" (${startTime.toLocaleString()})`);
    console.log(`  -> Resolved Location: "${location || 'None'}"`);

    // Remove existing travel blocks for this event so they get recalculated cleanly
    deleteBlocks(existingBlocks.get(eventKey), `REFRESH: Removing old travel block for "${title}"`);

    if (!location) {
      console.log(`  -> SKIP: No location specified or resolved from defaults.`);
      continue;
    }

    // Evaluate special keyword rules (e.g. Flight / Vlucht / Vliegen)
    const ruleMatch = getMatchingRule(title);
    const arrivalBufferMins = ruleMatch ? ruleMatch.arrivalBufferMinutes : CONFIG.ARRIVAL_BUFFER_MINUTES;
    const disableReturnHome = ruleMatch ? ruleMatch.disableReturnHome : false;

    if (ruleMatch) {
      console.log(`  -> SPECIAL RULE MATCHED: Buffer set to ${arrivalBufferMins} mins | Disable Return: ${disableReturnHome}`);
    }

    const { origin, originSource } = determineOrigin(sourceEvents, i);
    const arrivalTime = new Date(startTime.getTime() - (arrivalBufferMins * 60 * 1000));

    const routes = calculateAllRoutes(origin, location, arrivalTime, false);
    const selectedRoute = selectBestTravelMode(routes);

    if (!isUsableRoute(selectedRoute, '')) continue;

    // Create Outbound Travel Block
    createTravelBlock({
      targetCalendar,
      eventKey,
      isReturn: false,
      origin,
      destination: location,
      originSource,
      start: selectedRoute.departureTime || new Date(arrivalTime.getTime() - (selectedRoute.durationSec * 1000)),
      end: arrivalTime,
      selectedRoute,
      routes,
      bufferMins: arrivalBufferMins
    });

    // Handle Return Travel Block if last event of the day AND return is not disabled by a rule
    if (disableReturnHome) {
      console.log(`  -> SKIP RETURN: Return travel disabled by special rule for "${title}".`);
    } else if (isLastEventOfDay(sourceEvents, i)) {
      handleReturnTravel(targetCalendar, currentEvent);
    }
  }

  console.log(`\n=== END SCAN ===`);
}

/**
 * Handles generating a return travel block back home for the last event of the day
 */
function handleReturnTravel(targetCalendar, currentEvent) {
  const location = currentEvent.resolvedLocation;
  const endTime = currentEvent.getEndTime();
  const home = getSetting('HOME_LOCATION');

  console.log(`  -> CHECKING RETURN: Last event of day. Processing return home...`);

  const returnRoutes = calculateAllRoutes(location, home, endTime, true);
  const selectedRoute = selectBestTravelMode(returnRoutes);

  if (!isUsableRoute(selectedRoute, ' (Return)')) return;

  createTravelBlock({
    targetCalendar,
    eventKey: getEventKey(currentEvent),
    isReturn: true,
    origin: location,
    destination: home,
    originSource: 'Last Event Location',
    start: endTime,
    end: selectedRoute.arrivalTime || new Date(endTime.getTime() + (selectedRoute.durationSec * 1000)),
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
  const searchEnd = new Date(windowEnd.getTime() + (24 * 60 * 60 * 1000));
  const index = new Map();

  targetCalendar.getEvents(windowStart, searchEnd).forEach(evt => {
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

// --- HELPER FUNCTIONS ---

/**
 * Reads a setting from Script Properties, falling back to CONFIG.
 */
function getSetting(name) {
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

function createTravelBlock({ targetCalendar, eventKey, isReturn, origin, destination, originSource, start, end, selectedRoute, routes, bufferMins }) {
  const leaveAt = formatTime(selectedRoute.departureTime || start);
  const mode = TRAVEL_MODES[selectedRoute.key];
  const eventTitle = `${mode.emoji} Leave ${leaveAt} · ${mode.label}${isReturn ? ' home' : ''}`;

  const htmlDescription = [
    `📍 <a href="${selectedRoute.url}"><b>Open ${selectedRoute.key === 'NS' ? 'NS Journey Planner' : 'Google Maps Directions'}</b></a>`,
    `<br><b>Leave at:</b> ${leaveAt}`,
    `<b>Mode:</b> ${mode.label}${isReturn ? ' (Return)' : ''}`,
    `<b>Route:</b> ${escapeHtml(origin)} ➔ ${escapeHtml(destination)}`,
    `<b>Origin Source:</b> ${escapeHtml(originSource)}`,
    `<b>Duration:</b> ${selectedRoute.durationText}`,
    `<b>Buffer:</b> ${bufferMins} mins before event`,
    `<br>${formatAllRouteSummaryHtml(routes, selectedRoute.key)}`,
    `<br>${selectedRoute.stepsHtml}`
  ].join('<br>');

  try {
    const newEvent = targetCalendar.createEvent(eventTitle, start, end, {
      description: htmlDescription,
      location: `From: ${origin}`
    });

    newEvent.setTag(SOURCE_TAG, eventKey);

    console.log(`  -> CREATED: "${eventTitle}" [${start.toLocaleTimeString()} - ${end.toLocaleTimeString()}]`);
  } catch (e) {
    console.error(`  -> ERROR: Failed to create event: ${e}`);
  }
}

/**
 * Lists every travel mode as a clickable link that opens that specific mode.
 */
function formatAllRouteSummaryHtml(routes, selectedKey) {
  const lines = ['<b>📊 Travel Options Comparison:</b>'];

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
    const fare = r.fareText ? ` (${escapeHtml(r.fareText)})` : '';
    const leave = r.departureTime ? `, leave ${formatTime(r.departureTime)}` : '';
    const marker = key === selectedKey ? ' ✅' : '';
    lines.push(`• <a href="${r.url}">${mode.emoji} ${mode.label}</a>: <b>${r.durationText}</b>${leave}${fare}${marker}`);
  });

  return lines.join('<br>');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
