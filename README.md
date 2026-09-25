# Auto Schedule Travel Time

A Google Apps Script that reads your Google Calendar and automatically adds **travel blocks** before your events, telling you **when to leave** and **how to get there**.

🌐 **Website:** https://stijnris.github.io/auto-schedule-travel-time/

## Features

- Adds a travel event before every event with a location, titled like `🚲 Leave 08:42 · Biking`.
- Compares walking, biking, public transport (Google Maps), **NS door-to-door journeys** (Dutch Railways) and driving, and picks the best one.
- Every option in the event description is a link that opens that exact travel mode, with **"arrive by"** preset to your event time (so traffic and timetables are right).
- Plans from your previous event's location when events are close together, otherwise from home.
- Adds a return trip home after the last event of the day.
- Keyword rules, e.g. arrive 2 hours early for anything titled "flight".
- Keeps itself up to date: when an event's trip changes (time, location, where you come from, or your settings), its travel blocks are recalculated; deleted events get theirs removed. Unchanged events are left alone.

## Setup

1. Create a new calendar in Google Calendar, e.g. "Travel". Copy its **Calendar ID** (Settings → Integrate calendar).
2. Go to [script.google.com](https://script.google.com/) and create a new project.
3. Copy every file from [`src/`](src/) into the project (`Config.gs`, `Code.gs`, `Routes.gs`, `NsApi.gs`), keeping the file names. Optionally replace `appsscript.json` (Project Settings → Show "appsscript.json" manifest file) to set your time zone.
4. Configure it: either edit `Config.gs`, or (recommended) add these **Script Properties** under Project Settings → Script Properties:

   | Property             | Example                                        |
   | -------------------- | ---------------------------------------------- |
   | `TARGET_CALENDAR_ID` | `abc123…@group.calendar.google.com`            |
   | `HOME_LOCATION`      | `Stationsplein 1, Utrecht, Netherlands`        |
   | `NS_API_KEY`         | *(optional)* key from https://apiportal.ns.nl/ |

5. Run `processTravelBlocks` once and grant the permissions.
6. Run `installTriggers` once. This re-runs the script whenever your calendar changes, and once per day.

### NS API key (optional)

Sign up at [apiportal.ns.nl](https://apiportal.ns.nl/), subscribe to the **Ns-App** product and copy the primary key into the `NS_API_KEY` Script Property. Run `testNsRoute` to check it works. Without a key the NS option is simply left out.

## Configuration

All options live in [`src/Config.gs`](src/Config.gs) and are documented inline: source calendars, arrival buffer, when to walk or bike, whether driving is allowed, NS preferences and keyword rules.

### Keeping your personal config in a local clone

Copy [`Config.local.example.gs`](Config.local.example.gs) to `src/Config.local.gs` and fill in your details. That file is git-ignored, so it never ends up on GitHub. Add it to your Apps Script project as an extra file named `Config.local`; its values override `Config.gs`.

## Testing

The tests run the real `src/*.gs` files in Node.js against fake Google services (Calendar, Maps, NS API, Script Properties), in a shared global scope just like Apps Script. They cover change detection, which events get blocks, the event title/description and how public transport connections are picked.

```sh
npm test        # or: pnpm test  (Node.js 22+, no dependencies)
```

The tests run on every push via GitHub Actions. They prove the script's logic, not the behaviour of the real Google and NS services, so do a real run in Apps Script after bigger changes.

## Notes

- Google Apps Script has daily quotas for Maps requests. Only new or changed events are recalculated (about 5–6 requests each), so after the first run usage stays low. Run `forceRefreshAll` to recalculate everything, e.g. for fresh traffic or timetable data.
- The "arrive by" time in Google Maps links uses Google's undocumented URL format; if Google changes it, the link still opens the right route, just without the time.

## License

[MIT](LICENSE)
