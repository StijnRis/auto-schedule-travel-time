/**
 * A fake Google Apps Script environment for running the real src/*.gs files in Node.
 *
 * The .gs files are loaded into a fresh V8 context, the same way Apps Script loads
 * them: all files share one global scope. Google services (CalendarApp, Maps,
 * UrlFetchApp, ...) are replaced by in-memory fakes that record what the script does.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');
const SOURCE_FILES = ['Config.gs', 'Code.gs', 'Routes.gs', 'NsApi.gs'];

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A midnight (UTC) two days from now, so test events fall inside the scan window. */
function testDay() {
  const day = 24 * HOUR;
  return Math.ceil(Date.now() / day) * day + day;
}

/** Formats a Date like Utilities.formatDate, for the patterns the script uses. */
function formatDate(date, timeZone, pattern) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).forEach(p => { parts[p.type] = p.value; });

  const wallClock = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMin = Math.round((wallClock - Math.floor(date.getTime() / 1000) * 1000) / MINUTE);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;

  return pattern
    .replace(/'([^']*)'/g, (m, literal) => `\u0000${literal}\u0000`)
    .replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second)
    .replace(/Z(?![^\u0000]*\u0000)/, offset)
    .replace(/\u0000/g, '');
}

/**
 * Creates a fake environment.
 * @param {Object} options
 *   events:     source calendar events (see makeEvent)
 *   durations:  minutes per mode for WALKING / BICYCLING / DRIVING
 *   timetable:  transit lines [{ every, offset, duration }] in minutes
 *   nsTrips:    NS trips [{ dep, arr, transfers }] as timestamps (ms); omit to disable NS
 *   config:     overrides for CONFIG
 */
function createEnv(options = {}) {
  const state = {
    requests: [],        // every Directions request: { mode, arrive, depart }
    nsRequests: [],      // every NS API URL
    created: [],         // travel blocks created
    deleted: 0,
    failNextRequests: 0, // make the next N Directions requests throw
    events: options.events || [],
    target: [],
    props: new Map(),
    logs: []
  };

  const durations = Object.assign({ WALKING: 90, BICYCLING: 55, DRIVING: 25 }, options.durations);
  const timetable = options.timetable || [{ every: 15, offset: 0, duration: 30 }];

  function makeCalendarEvent(id, start, end, title, location, extra = {}) {
    const tags = {};
    const event = {
      getId: () => id,
      getTitle: () => title,
      getLocation: () => location,
      getStartTime: () => new Date(start),
      getEndTime: () => new Date(end),
      isAllDayEvent: () => Boolean(extra.allDay),
      getMyStatus: () => extra.status || 'YES',
      getTag: key => tags[key] || null,
      setTag: (key, value) => { tags[key] = value; },
      deleteEvent: () => {
        state.deleted++;
        state.target = state.target.filter(e => e !== event);
      }
    };
    return event;
  }

  const overlaps = (e, from, to) => e.getStartTime() < to && e.getEndTime() > from;

  const CalendarApp = {
    GuestStatus: { NO: 'NO', YES: 'YES' },
    getCalendarById: id => {
      if (id === 'primary') {
        return { getEvents: (from, to) => state.events.filter(e => overlaps(e, from, to)) };
      }
      if (id !== 'travel-calendar') return null;
      return {
        getEvents: (from, to) => state.target.filter(e => overlaps(e, from, to)),
        createEvent: (title, start, end, opts) => {
          const event = makeCalendarEvent(`travel-${state.created.length}`, start.getTime(), end.getTime(), title, opts.location);
          event.description = opts.description;
          state.target.push(event);
          state.created.push(event);
          return event;
        }
      };
    }
  };

  function transitRoutes(finder) {
    return timetable.map(line => {
      const every = line.every * MINUTE;
      const offset = (line.offset || 0) * MINUTE;
      const duration = line.duration * MINUTE;
      const departure = finder.depart !== undefined
        ? Math.ceil((finder.depart - offset) / every) * every + offset
        : Math.floor((finder.arrive - duration - offset) / every) * every + offset;
      return {
        legs: [{
          duration: { value: duration / 1000, text: `${line.duration} mins` },
          departure_time: { value: departure / 1000, text: formatDate(new Date(departure), 'UTC', 'HH:mm') },
          arrival_time: { value: (departure + duration) / 1000, text: formatDate(new Date(departure + duration), 'UTC', 'HH:mm') },
          steps: []
        }]
      };
    });
  }

  const Maps = {
    DirectionFinder: { Mode: { WALKING: 'WALKING', BICYCLING: 'BICYCLING', TRANSIT: 'TRANSIT', DRIVING: 'DRIVING' } },
    newDirectionFinder: () => {
      const finder = {
        setOrigin: v => { finder.origin = v; return finder; },
        setDestination: v => { finder.destination = v; return finder; },
        setMode: v => { finder.mode = v; return finder; },
        setAlternatives: () => finder,
        setArrive: t => { finder.arrive = t.getTime(); return finder; },
        setDepart: t => { finder.depart = t.getTime(); return finder; },
        getDirections: () => {
          state.requests.push({ mode: finder.mode, arrive: finder.arrive, depart: finder.depart });
          if (state.failNextRequests > 0) {
            state.failNextRequests--;
            throw new Error('Service invoked too many times for one day: route.');
          }
          if (finder.mode === 'TRANSIT') return { routes: transitRoutes(finder) };
          const minutes = durations[finder.mode];
          return { routes: [{ legs: [{ duration: { value: minutes * 60, text: `${minutes} mins` }, steps: [] }] }] };
        }
      };
      return finder;
    },
    newGeocoder: () => ({ geocode: () => ({ results: [{ geometry: { location: { lat: 52.0, lng: 4.36 } } }] }) })
  };

  const nsTime = ms => formatDate(new Date(ms), 'Europe/Amsterdam', "yyyy-MM-dd'T'HH:mm:ssZ");
  const UrlFetchApp = {
    fetch: url => {
      state.nsRequests.push(url);
      const trips = (options.nsTrips || []).map((t, i) => ({
        idx: i,
        status: 'NORMAL',
        transfers: t.transfers || 0,
        plannedDurationInMinutes: Math.round((t.arr - t.dep) / MINUTE),
        shareUrl: { uri: `https://www.ns.nl/rpx?ctx=trip-${i}` },
        legs: [{
          travelType: 'PUBLIC_TRANSIT',
          direction: 'Rotterdam Centraal',
          product: { displayName: 'NS Intercity' },
          origin: { name: 'Delft', plannedDateTime: nsTime(t.dep), plannedTrack: '1' },
          destination: { name: 'Den Haag HS', plannedDateTime: nsTime(t.arr) }
        }]
      }));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ trips }) };
    }
  };

  const cache = new Map();
  const globals = {
    console: {
      log: (...a) => state.logs.push(a.join(' ')),
      warn: (...a) => state.logs.push('WARN ' + a.join(' ')),
      error: (...a) => state.logs.push('ERROR ' + a.join(' '))
    },
    CalendarApp,
    Maps,
    UrlFetchApp,
    Session: { getScriptTimeZone: () => 'UTC', getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (state.props.has(k) ? state.props.get(k) : null),
        setProperty: (k, v) => { state.props.set(k, String(v)); },
        deleteProperty: k => { state.props.delete(k); },
        getKeys: () => [...state.props.keys()]
      })
    },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k) || null, put: (k, v) => cache.set(k, v) }) },
    ScriptApp: { getProjectTriggers: () => [] },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, text) => [...crypto.createHash(algorithm).update(text, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: bytes => Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b))).toString('base64url'),
      formatDate,
      sleep: () => {}
    }
  };

  const context = vm.createContext(globals);
  const code = SOURCE_FILES.map(f => fs.readFileSync(path.join(SRC_DIR, f), 'utf8')).join('\n');
  vm.runInContext(code, context, { filename: 'src.gs' });

  const config = Object.assign({
    TARGET_CALENDAR_ID: 'travel-calendar',
    HOME_LOCATION: 'Home Street 1, Delft',
    NS_API_KEY: options.nsTrips ? 'test-key' : '',
    API_DELAY_MS: 0
  }, options.config);
  context.__config = config;
  vm.runInContext('Object.assign(CONFIG, __config);', context);

  return {
    state,
    context,
    /** Adds a source event; times are timestamps (ms). */
    addEvent(id, start, end, title, location, extra) {
      const event = makeCalendarEvent(id, start, end, title, location, extra);
      state.events.push(event);
      return event;
    },
    removeEvent(id) {
      state.events = state.events.filter(e => e.getId() !== id);
    },
    /** Runs a scan and returns what happened during it. */
    run() {
      const before = { requests: state.requests.length, ns: state.nsRequests.length, created: state.created.length, deleted: state.deleted };
      context.processTravelBlocks();
      return {
        requests: state.requests.length - before.requests,
        nsRequests: state.nsRequests.length - before.ns,
        created: state.created.length - before.created,
        deleted: state.deleted - before.deleted
      };
    },
    /** Runs code inside the script's scope, e.g. 'CONFIG.X = 1' (const globals aren't on `context`). */
    exec(source) {
      return vm.runInContext(source, context);
    },
    /** Simulates pasting in an updated version of the script. */
    updateCode(extraSource) {
      vm.runInContext(extraSource, context);
    },
    blocks: () => state.target.slice().sort((a, b) => a.getStartTime() - b.getStartTime()),
    time: date => formatDate(date, 'UTC', 'HH:mm')
  };
}

module.exports = { createEnv, testDay, formatDate, MINUTE, HOUR };
