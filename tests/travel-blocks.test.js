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

  test('NS: fastest on-time trip, alternatives and trip links', () => {
    const nsTrips = [
      { dep: at(17, 50), arr: at(18, 30), transfers: 1 },  // earlier, slow
      { dep: at(18, 10), arr: at(18, 35) },                // earlier, fast
      { dep: at(18, 20), arr: at(18, 50), transfers: 1 },  // on time, 30 min
      { dep: at(18, 30), arr: at(18, 52) },                // on time, 22 min  <- fastest
      { dep: at(18, 40), arr: at(19, 10) }                 // later
    ];
    const env = createEnv({ nsTrips, config: { NS: { preferOverGoogleTransit: true, language: 'en' } } });
    env.addEvent('lecture', at(19), at(20), 'Lecture', 'Lecture Hall, Delft');
    env.run();

    const outbound = env.blocks()[0];
    assert.equal(outbound.getTitle(), '🚆 Leave 18:30 · NS');
    assert.equal(env.time(outbound.getEndTime()), '18:52');
    const description = outbound.description;
    assert.match(description, /href="https:\/\/www.ns.nl\/rpx\?ctx=trip-3"><b>Open NS Journey Planner/);
    assert.match(description, /🚆 NS<\/a>: <b>18:30 - 18:52 \(0:22\)<\/b> · 0 transfer\(s\) ✅/);
    assert.match(description, /<a href="https:\/\/www.ns.nl\/rpx\?ctx=trip-1">Arrive earlier<\/a>: 18:10 - 18:35 \(0:25\)/);
    assert.match(description, /<a href="https:\/\/www.ns.nl\/rpx\?ctx=trip-4">Arrive later<\/a>: 18:40 - 19:10 \(0:30\)/);
  });

  test('NS: request uses coordinates, arrival search and Amsterdam time', () => {
    const env = createEnv({ nsTrips: [] });
    env.addEvent('lecture', at(19), at(20), 'Lecture', 'Lecture Hall, Delft');
    env.run();

    const url = decodeURIComponent(env.state.nsRequests[0]);
    assert.match(url, /originLat=52&originLng=4.36/);
    assert.match(url, /searchForArrival=true/);
    assert.match(url, /previousAdvices=3&nextAdvices=3/);
    // 18:55 UTC in Amsterdam time, with a colon in the offset
    assert.match(url, /dateTime=\d{4}-\d{2}-\d{2}T(19|20):55:00\+0[12]:00/);
  });
});
