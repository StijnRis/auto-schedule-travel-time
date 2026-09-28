const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, testDay, MINUTE, HOUR } = require('./helpers/apps-script-env');

const day = testDay();
const at = (hours, minutes = 0) => day + hours * HOUR + minutes * MINUTE;

/** Two events on one day: a lecture and a meeting later on. */
function twoEventDay(options) {
  const env = createEnv(options);
  env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall, Delft');
  env.addEvent('meeting', at(13), at(14), 'Meeting', 'Office, The Hague');
  return env;
}

test.describe('change detection', () => {
  test('first run creates blocks, a second run does nothing', () => {
    const env = twoEventDay();
    const first = env.run();
    assert.equal(first.created, 3); // lecture, meeting, return home after meeting
    assert.ok(first.requests > 0);

    const second = env.run();
    assert.deepEqual(second, { requests: 0, nsRequests: 0, created: 0, deleted: 0 });
  });

  test('changing an event only refreshes the trips that depend on it', () => {
    const env = twoEventDay();
    env.run();
    env.removeEvent('meeting');
    env.addEvent('meeting', at(13), at(14), 'Meeting', 'Other Office, Rotterdam');

    const result = env.run();
    // The meeting's outbound + return are recalculated; the lecture is untouched.
    assert.equal(result.created, 2);
    assert.equal(result.deleted, 2);
    assert.equal(env.blocks().length, 3);
  });

  test('a travel block deleted by hand is recreated', () => {
    const env = twoEventDay();
    env.run();
    env.blocks()[0].deleteEvent();

    const result = env.run();
    assert.equal(result.created, 1);
    assert.equal(env.blocks().length, 3);
  });

  test('deleting an event removes its blocks and moves the return trip', () => {
    const env = twoEventDay();
    env.run();
    env.removeEvent('meeting');

    env.run();
    const titles = env.blocks().map(b => b.getTitle());
    assert.equal(titles.length, 2);
    assert.match(titles[1], /home$/); // the lecture is now the last event of the day
  });

  test('updating the script code refreshes all upcoming blocks once', () => {
    const env = twoEventDay();
    env.run();
    env.updateCode('function formatTime(date) { return Utilities.formatDate(date, getTimeZone(), "HH:mm"); } // v2');

    assert.equal(env.run().created, 3);
    assert.equal(env.run().created, 0);
    assert.ok(!env.state.logs.some(l => l.includes('Could not read the script source')));
  });

  test('changing the configuration refreshes all upcoming blocks', () => {
    const env = twoEventDay();
    env.run();
    env.exec('CONFIG.ARRIVAL_BUFFER_MINUTES = 10;');
    assert.equal(env.run().created, 3);
  });

  test('failed route requests are retried on the next run', () => {
    const env = createEnv();
    env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall, Delft');
    env.state.failNextRequests = 1;
    env.run();

    const retry = env.run();
    assert.ok(retry.requests > 0, 'expected the event to be recalculated');
    assert.equal(env.run().requests, 0);
  });
});

test.describe('which events get travel blocks', () => {
  test('skips all-day, declined and location-less events', () => {
    const env = createEnv();
    env.addEvent('allday', day, day + 24 * HOUR, 'Holiday', 'Beach', { allDay: true });
    env.addEvent('declined', at(9), at(10), 'Declined', 'Somewhere', { status: 'NO' });
    env.addEvent('nolocation', at(11), at(12), 'Call', '');
    assert.equal(env.run().created, 0);
  });

  test('keyword rules change the buffer and skip the trip home', () => {
    const env = createEnv({ durations: { WALKING: 10 } });
    env.addEvent('flight', at(12), at(14), 'Flight to Rome', 'Schiphol Airport');
    env.run();

    const blocks = env.blocks();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].getEndTime().getTime(), at(10)); // 120 minutes before departure
  });
});

test.describe('travel block content', () => {
  test('title says when to leave, location is the plain origin', () => {
    const env = createEnv({ durations: { WALKING: 10 } });
    env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall\nMain Street 1\nDelft');
    env.run();

    const outbound = env.blocks()[0];
    assert.equal(outbound.getTitle(), '🚶 Leave 08:45 · Walking');
    assert.equal(outbound.getLocation(), 'Home Street 1, Delft');
    assert.ok(!outbound.getLocation().startsWith('From:'));
  });

  test('description lists every option as "leave - arrive (H:MM)" with links', () => {
    const env = createEnv();
    env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall\nMain Street 1\nDelft');
    env.run();

    const description = env.blocks()[0].description;
    assert.ok(!description.includes('Leave at'));
    assert.ok(!description.includes('Comparison'));
    assert.match(description, /Route:<\/b> Home Street 1, Delft ➔ Lecture Hall, Main Street 1, Delft/);
    assert.match(description, /🚶 Walking<\/a>: <b>07:25 - 08:55 \(1:30\)<\/b>/);
    assert.match(description, /🚲 Biking<\/a>: <b>08:00 - 08:55 \(0:55\)<\/b>/);
    assert.match(description, /🚗 Driving<\/a>: <b>08:30 - 08:55 \(0:25\)<\/b>/);
    assert.ok(!description.includes('%0A'), 'links should not contain newlines');
  });

  test('Google Maps links open the mode with "arrive by" the right time', () => {
    const env = createEnv();
    env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall, Delft');
    env.run();

    const description = env.blocks()[0].description;
    const arriveBy = (at(8, 55)) / 1000; // test time zone is UTC, so wall clock = UTC
    assert.ok(description.includes(`!6e1!7e2!8j${arriveBy}!3e1`), 'biking link with arrive-by time');
    assert.ok(description.includes(`!6e1!7e2!8j${arriveBy}!3e0`), 'driving link with arrive-by time');
  });

  test('a public transport block covers only the time in transport', () => {
    // Bus every 15 minutes, 30 minute trip; walking and biking are slow.
    const env = createEnv({ timetable: [{ every: 15, offset: 0, duration: 30 }] });
    env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall, Delft');
    env.run();

    const outbound = env.blocks()[0];
    assert.match(outbound.getTitle(), /^🚌 Leave 08:15 · Transit$/);
    assert.equal(env.time(outbound.getStartTime()), '08:15');
    assert.equal(env.time(outbound.getEndTime()), '08:45'); // not stretched to 08:55
  });
});

test.describe('public transport connections', () => {
  // A bus every 15 minutes (40 min) and a train every hour at :05 (20 min).
  const timetable = [{ every: 15, offset: 0, duration: 40 }, { every: 60, offset: 5, duration: 20 }];

  test('picks the fastest connection that is on time, with real earlier/later arrivals', () => {
    const env = createEnv({ timetable });
    env.addEvent('lecture', at(19), at(20), 'Lecture', 'Lecture Hall, Delft');
    env.run();

    const outbound = env.blocks()[0];
    assert.equal(outbound.getTitle(), '🚌 Leave 18:05 · Transit'); // train, not the bus arriving 18:55
    const description = outbound.description;
    assert.match(description, /🚌 Transit<\/a>: <b>18:05 - 18:25 \(0:20\)<\/b> ✅/);
    assert.match(description, /Arrive earlier<\/a>: 17:05 - 17:25 \(0:20\)/);
    assert.match(description, /Arrive later<\/a>: 18:15 - 18:55 \(0:40\)/);
  });

  test('going home picks the earliest arrival after the event', () => {
    const env = createEnv({ timetable });
    env.addEvent('lecture', at(19), at(20), 'Lecture', 'Lecture Hall, Delft');
    env.run();

    const home = env.blocks().find(b => b.getTitle().endsWith('home'));
    assert.equal(home.getTitle(), '🚌 Leave 20:05 · Transit home');
    assert.ok(!home.description.includes('Arrive earlier'));
  });
});

/** Addresses as "lat,lng" are stations or stops; getting there takes `near` minutes. */
const isPlace = text => /^\d/.test(text);
const nearStops = (near, far) => (origin, destination) => (isPlace(origin) || isPlace(destination) ? near : far);

test.describe('NS trains', () => {
  // Trains between the stations nearest to home and to the event.
  const nsTrips = [
    { dep: at(17, 50), arr: at(18, 30), transfers: 1 },  // earlier, slow
    { dep: at(18, 5), arr: at(18, 35) },                 // earlier, fast
    { dep: at(18, 15), arr: at(18, 45), transfers: 1 },  // on time, 30 min
    { dep: at(18, 25), arr: at(18, 47) },                // on time, 22 min  <- fastest
    { dep: at(18, 40), arr: at(19, 10) }                 // later
  ];
  const durations = { WALKING: nearStops(5, 90), BICYCLING: nearStops(8, 55) };

  test('from home you bike to the station and park, then take the fastest train', () => {
    const env = createEnv({ nsTrips, durations });
    env.addEvent('lecture', at(19), at(20), 'Lecture', 'Lecture Hall, Den Haag');
    env.run();

    const outbound = env.blocks()[0];
    // 8 min biking + 5 min parking before the 18:25 train, 5 min walk after it.
    assert.equal(outbound.getTitle(), '🚲🚆 Leave 18:12 · Bike + NS');
    assert.equal(env.time(outbound.getEndTime()), '18:52');
    const description = outbound.description;
    assert.match(description, /href="https:\/\/www.ns.nl\/rpx\?ctx=trip-3"><b>Open NS Journey Planner/);
    assert.match(description, /🚲🚆 Bike \+ NS<\/a>: <b>18:12 - 18:52 \(0:40\)<\/b> · 0 transfer\(s\) ✅/);
    assert.match(description, /<a href="https:\/\/www.ns.nl\/rpx\?ctx=trip-2">Arrive earlier<\/a>: 18:02 - 18:50 \(0:48\)/);
    assert.match(description, /🚲 Bike to the station \(8 mins\) and park your bike \(5 mins\)/);
    assert.match(description, /🚶 Walk 5 mins/);
  });

  test('trips are planned between stations, arriving in time for the last bit', () => {
    const env = createEnv({ nsTrips: [], durations });
    env.addEvent('lecture', at(19), at(20), 'Lecture', 'Lecture Hall, Den Haag');
    env.run();

    const url = decodeURIComponent(env.state.nsRequests[0]);
    assert.match(url, /\/v3\/trips\?fromStation=ST\d+&toStation=ST\d+/);
    assert.match(url, /searchForArrival=true/);
    // 18:55 minus the 5 minute walk from the station, in Amsterdam time.
    assert.match(url, /dateTime=\d{4}-\d{2}-\d{2}T(19|20):50:00\+0[12]:00/);
    assert.ok(!url.includes('originLat'), 'no door-to-door request');
  });

  test('your bike stays at the station; later you walk there, and ride home at the end of the day', () => {
    const morningTrain = { dep: at(8, 20), arr: at(8, 42) };
    const env = createEnv({ nsTrips: [morningTrain, ...nsTrips], durations });
    env.addEvent('work', at(9), at(17), 'Work', 'Office, Den Haag');
    env.addEvent('lecture', at(19), at(20), 'Lecture', 'Lecture Hall, Den Haag');
    env.run();

    const titles = env.blocks().map(b => b.getTitle());
    assert.equal(titles[0], '🚲🚆 Leave 08:07 · Bike + NS');
    // Work -> lecture: your bike is at the station near home, so no bike this time.
    assert.equal(titles[1], '🚆 Leave 18:20 · NS');
    assert.match(env.blocks()[1].description, /Biking: <i>your bike is at Station \d+ station<\/i>/);
    // Going home you travel back to your bike and ride it home.
    assert.match(titles[2], /\+ bike home$/);
    assert.match(env.blocks()[2].description, /Pick up your bike at <i>Station \d+ station<\/i> \(2 min\) and bike home: 8 mins/);
  });
});

test.describe('Google transit with your bike', () => {
  // A bus every 15 minutes; the stop is a 10 minute walk but a 3 minute bike ride.
  const timetable = [{ every: 15, offset: 0, duration: 30, walk: 10, stop: 'Bus Station' }];
  const durations = { BICYCLING: nearStops(3, 55) };

  test('bikes to the stop instead of walking, and parks there', () => {
    const env = createEnv({ timetable, durations });
    env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall, Delft');
    env.run();

    const outbound = env.blocks()[0];
    // The bus leaves the stop at 08:25: bike 3 min + park 5 min.
    assert.equal(outbound.getTitle(), '🚲🚌 Leave 08:17 · Bike + Transit');
    assert.match(outbound.description, /1\. 🚲 Bike to <i>Bus Station<\/i> \(3 mins\) and park your bike \(5 mins\)<br>2\. <b>\[08:25\] Board Bus 1/);
    assert.ok(!outbound.description.includes('Walk to Bus Stop'));
  });

  test('going home you take the bus back to your bike and ride home', () => {
    const env = createEnv({ timetable, durations });
    env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall, Delft');
    env.run();

    const home = env.blocks()[1];
    assert.equal(home.getTitle(), '🚌🚲 Leave 10:00 · Transit + bike home');
    // Bus 10:00-10:30, pick up the bike (2 min), ride 3 min.
    assert.equal(env.time(home.getEndTime()), '10:35');
    assert.match(home.description, /Travel Options to your bike at Bus Station/);
  });

  test('walking to the stop stays when the bike is no faster', () => {
    const env = createEnv({ timetable: [{ every: 15, duration: 30, walk: 2 }], durations });
    env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall, Delft');
    env.run();
    assert.equal(env.blocks()[0].getTitle(), '🚌 Leave 08:15 · Transit');
  });
});

test.describe('all-day events: where you sleep', () => {
  function stay(firstDay, days) {
    const env = createEnv({ durations: { WALKING: 10 } });
    env.addEvent('hotel', day + firstDay * 24 * HOUR, day + (firstDay + days) * 24 * HOUR, 'Hotel', 'Hotel Street 5, Rotterdam', { allDay: true });
    [0, 1, 2, 3].forEach(d => env.addEvent(`lecture${d}`, at(24 * d + 9), at(24 * d + 10), 'Lecture', 'Lecture Hall, Delft'));
    env.run();
    // [from, to] for each day's trip there and trip back
    return env.blocks().map(b => (b.getTitle().endsWith('home') ? b.description.match(/➔ ([^<]*)/)[1] : b.getLocation()));
  }

  test('a stay from Friday to Sunday: leave from home Friday, go home Sunday', () => {
    assert.deepEqual(stay(0, 3), [
      'Home Street 1, Delft', 'Hotel Street 5, Rotterdam',        // day 1: from home, sleep at the hotel
      'Hotel Street 5, Rotterdam', 'Hotel Street 5, Rotterdam',   // day 2
      'Hotel Street 5, Rotterdam', 'Home Street 1, Delft',        // day 3: from the hotel, back home
      'Home Street 1, Delft', 'Home Street 1, Delft'              // day 4
    ]);
  });

  test('a single-day event is not a stay: you sleep at home', () => {
    assert.deepEqual(stay(1, 1), [
      'Home Street 1, Delft', 'Home Street 1, Delft',
      'Home Street 1, Delft', 'Home Street 1, Delft',
      'Home Street 1, Delft', 'Home Street 1, Delft',
      'Home Street 1, Delft', 'Home Street 1, Delft'
    ]);
  });
});

test.describe('travel you planned yourself', () => {
  test('an event you added to the travel calendar replaces the travel block', () => {
    const env = createEnv({ durations: { WALKING: 10 } });
    env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall, Delft');
    env.run();
    assert.equal(env.blocks().length, 2);

    env.addManualTravel(at(8, 20), at(8, 50), 'Lift from Anna');
    env.run();
    const titles = env.blocks().map(b => b.getTitle());
    assert.deepEqual(titles, ['Lift from Anna', '🚶 Leave 10:00 · Walking home']);
  });

  test('travel-like events in your other calendars are normal events', () => {
    const env = createEnv({ durations: { WALKING: 10 } });
    env.addEvent('train', at(8), at(8, 50), 'Train to Delft', 'Den Haag Centraal');
    env.run();
    assert.equal(env.blocks().length, 2);
  });
});

test.describe('not enough time between events', () => {
  function tightDay(nextStartMinutes) {
    const env = createEnv({ durations: { WALKING: 10 } });
    env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall, Delft');
    env.addEvent('meeting', at(10, nextStartMinutes), at(11), 'Meeting', 'Office, Delft');
    env.run();
    return env;
  }

  test('creates one ❗ block that leaves when the previous event ends, with all the info', () => {
    const env = tightDay(0);
    const titles = env.blocks().map(b => b.getTitle());
    assert.deepEqual(titles, [
      '🚶 Leave 08:45 · Walking',
      '❗ 🚶 Leave 10:00 · Walking · 10 min late',
      '🚶 Leave 11:00 · Walking home'
    ]);
    const description = env.blocks()[1].description;
    assert.match(description, /Not enough time: "Lecture" ends at 10:00/);
    assert.match(description, /you arrive 10:10, 10 min after the start/);
    assert.match(description, /To arrive on time you'd have to leave at 09:45/);
  });

  test('when leaving right after still gets you there before the start, one block', () => {
    const env = tightDay(12);
    const titles = env.blocks().map(b => b.getTitle());
    assert.equal(titles[1], '🚶 Leave 10:00 · Walking');
    assert.equal(titles.length, 3);
  });

  test('a second run leaves the conflict blocks alone', () => {
    const env = tightDay(0);
    assert.deepEqual(env.run(), { requests: 0, nsRequests: 0, created: 0, deleted: 0 });
  });
});

test.describe('calendars', () => {
  test('reads every enabled calendar, skips disabled ones and the travel calendar', () => {
    const env = createEnv({ durations: { WALKING: 10 } });
    env.addCalendar('work', { selected: true });
    env.addCalendar('old', { selected: false });
    env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall, Delft', { calendar: 'work' });
    env.addEvent('hidden', at(15), at(16), 'Old', 'Somewhere, Delft', { calendar: 'old' });
    env.run();

    assert.equal(env.blocks().length, 2);
    assert.deepEqual(env.calendarTriggers(), ['me@example.com', 'work']);
  });

  test('enabling a calendar later adds its trigger; disabling removes it', () => {
    const env = createEnv();
    env.run();
    env.addCalendar('work', { selected: true });
    env.run();
    assert.deepEqual(env.calendarTriggers(), ['me@example.com', 'work']);

    env.state.calendars.set('work', { selected: false });
    env.run();
    assert.deepEqual(env.calendarTriggers(), ['me@example.com']);
  });

  test('installs a daily trigger once and replaces triggers from older versions', () => {
    const env = createEnv();
    env.state.triggers.push({ getHandlerFunction: () => 'onCalendarChange', getEventType: () => 'CLOCK', getTriggerSourceId: () => null });
    env.run();
    env.run();
    const triggers = env.state.triggers.map(t => `${t.getHandlerFunction()} ${t.getEventType()}`).sort();
    assert.deepEqual(triggers, ['syncTravel CLOCK', 'syncTravel ON_EVENT_UPDATED']);
  });

  test('locations are rewritten per calendar with regular expressions, then prefixed', () => {
    const env = createEnv({ durations: { WALKING: 10 } });
    env.addCalendar('timetable', { selected: true });
    env.exec(`CONFIG.SOURCE_CALENDARS = [{ id: 'timetable', locationReplace: [{ find: /\s*(-|Hall).*$/, replace: '' }], locationPrefix: 'TU Delft, ' }]`);
    env.addEvent('a', at(9), at(10), 'Lecture', 'Aula - Room A', { calendar: 'timetable' });
    env.addEvent('b', at(11), at(12), 'Lab', 'EEMCS Hall Chip', { calendar: 'timetable' });
    env.addEvent('c', at(13), at(14), 'Lunch', 'Cafe - Delft');
    env.run();
    const destinations = env.blocks().filter(b => !b.getTitle().endsWith('home')).map(b => b.description.match(/➔ ([^<]*)/)[1]);
    assert.deepEqual(destinations, ['TU Delft, Aula', 'TU Delft, EEMCS', 'Cafe - Delft']);
  });

  test('an event shown in two calendars gets one set of blocks', () => {
    const env = createEnv({ durations: { WALKING: 10 } });
    env.addCalendar('family', { selected: true });
    env.addEvent('dinner', at(18), at(20), 'Dinner', 'Restaurant, Delft');
    env.addEvent('dinner', at(18), at(20), 'Dinner', 'Restaurant, Delft', { calendar: 'family' });
    env.run();
    assert.equal(env.blocks().length, 2);
  });
});

test('the description has no 9292 link', () => {
  const env = createEnv();
  env.addEvent('lecture', at(9), at(10), 'Lecture', 'Lecture Hall, Delft');
  env.run();
  assert.ok(!env.blocks()[0].description.includes('9292'));
});

test.describe('bike tracking and change detection', () => {
  const walking = (origin, destination) => ([origin, destination].some(p => p.includes('Neighbour')) ? 10 : nearStops(5, 90)(origin, destination));
  const durations = { WALKING: walking, BICYCLING: nearStops(8, 55) };
  const nsTrips = [{ dep: at(8, 20), arr: at(8, 42) }, { dep: at(18, 25), arr: at(18, 47) }];

  test('a second run changes nothing', () => {
    const env = createEnv({ nsTrips, durations });
    env.addEvent('work', at(9), at(17), 'Work', 'Office, Den Haag');
    env.addEvent('lecture', at(19), at(20), 'Lecture', 'Lecture Hall, Den Haag');
    env.run();
    assert.deepEqual(env.run(), { requests: 0, nsRequests: 0, created: 0, deleted: 0 });
  });

  test('when the first trip no longer uses the bike, the later trips are recalculated', () => {
    const env = createEnv({ nsTrips, durations });
    env.addEvent('work', at(9), at(17), 'Work', 'Office, Den Haag');
    env.addEvent('lecture', at(19), at(20), 'Lecture', 'Lecture Hall, Den Haag');
    env.run();
    assert.match(env.blocks()[2].getTitle(), /\+ bike home$/);

    // Work moves next door: you walk there and your bike stays at home.
    env.removeEvent('work');
    env.addEvent('work', at(9), at(17), 'Work', 'Neighbour, Delft');
    const result = env.run();
    assert.equal(result.created, 3); // work, lecture and the trip home: all changed
    assert.ok(!env.blocks().some(b => b.getTitle().includes('+ bike')));
  });
});

test('coordinates (e.g. where your bike is parked) are used as they are, not geocoded', () => {
  const env = createEnv();
  assert.equal(JSON.stringify(env.exec('geocodeAddress("52.0067,4.3564")')), '{"lat":52.0067,"lng":4.3564}');
});

test.describe('very long trips', () => {
  test('no travel block when the trip takes more than MAX_TRAVEL_HOURS, with a warning', () => {
    const env = createEnv({
      durations: { WALKING: 900, BICYCLING: 600, DRIVING: 300 },
      timetable: [{ every: 15, offset: 0, duration: 290 }]
    });
    env.addEvent('far', at(12), at(13), 'Conference', 'Far Away, Germany');
    env.run();
    assert.equal(env.blocks().length, 0);
    assert.ok(env.state.logs.some(line => line.startsWith('WARN') && line.includes('more than 4')));
  });
});
