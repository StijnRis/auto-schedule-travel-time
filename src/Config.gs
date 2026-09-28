/**
 * Configuration for the Travel Time script.
 *
 * Personal values (TARGET_CALENDAR_ID, HOME_LOCATION, NS_API_KEY) are best stored
 * as Script Properties instead of in this file:
 *   Apps Script editor → Project Settings (⚙️) → Script Properties → Add property.
 * A Script Property with the same name always wins over the value below, so this
 * file can stay free of personal details (handy if you keep it in a public repo).
 */
const CONFIG = {
  // Read events from every calendar that is enabled (checked) in Google Calendar.
  // Enabling or disabling a calendar there is picked up automatically on the next run.
  // false = only read the calendars listed in SOURCE_CALENDARS.
  USE_ALL_ENABLED_CALENDARS: true,

  // Optional settings per calendar. Not needed unless a calendar needs one of these.
  SOURCE_CALENDARS: [
    // {
    //   id: 'primary',          // 'primary' or a calendar ID (Calendar settings → Integrate calendar)
    //   locationPrefix: '',     // Prepended to every location, e.g. 'My University, ' when events only list a room
    //   defaultLocation: ''     // Used when an event has no location at all ('' = skip those events)
    // }
  ],

  // Calendar the travel blocks are written to. Use a DEDICATED calendar: the script
  // deletes and recreates the travel blocks it created there.
  TARGET_CALENDAR_ID: 'your-travel-calendar-id@group.calendar.google.com', // Script Property: TARGET_CALENDAR_ID

  HOME_LOCATION: 'Your Street 1, Your City, Country', // Script Property: HOME_LOCATION

  // NS (Dutch Railways) API key from https://apiportal.ns.nl/ (product "Ns-App").
  // Trains are planned from the station nearest to you (biking or walking there).
  // Leave empty to disable the NS travel option.
  NS_API_KEY: '', // Script Property: NS_API_KEY

  TIME_ZONE: '',                        // '' = the script time zone (appsscript.json)
  SEARCH_RANGE_DAYS: 14,                // Lookahead window in days
  MAX_GAP_BEFORE_HOME_HOURS: 10,        // Max gap between events before assuming you went home in between
  ARRIVAL_BUFFER_MINUTES: 5,            // Default: arrive this many minutes before an event starts
  MIN_TRAVEL_DURATION_SEC: 180,         // Ignore trips shorter than 3 minutes
  API_DELAY_MS: 150,                    // Pause between Maps API calls to avoid rate limit errors
  SKIP_DECLINED_EVENTS: true,           // Don't plan travel for events you declined

  // An all-day event spanning several days with a location means you sleep there
  // (a hotel, staying with family). An event from Friday to Sunday: Friday you leave
  // from home and end the day there, Saturday you start and end there, Sunday you
  // start there and go home. Single-day all-day events are ignored.
  ALL_DAY_EVENT_IS_HOME: true,

  // Travel you plan yourself: an event you add to the travel calendar just before an
  // event (or just after the last event of the day) means no travel block is added.
  MANUAL_TRAVEL: {
    windowMinutes: 120                  // How far before (or after) an event your own travel event may be
  },

  // Your bike. The script keeps track of where it is: at home, where you biked to,
  // or at the stop/station where you parked it to take public transport. Leaving
  // from home, public transport starts with a bike ride to the stop or station;
  // at the end of the day you travel back to your bike and ride it home.
  BIKE: {
    parkMinutes: 5,                     // Parking your bike at a stop or station
    pickUpMinutes: 2,                   // Getting it again
    maxStationDistanceKm: 8             // Consider NS stations up to this far away when biking
  },

  // How the "best" travel mode is chosen.
  MODE_SELECTION: {
    walkIfUnderMinutes: 15,             // Walk when walking takes less than this
    bikeIfUnderMinutes: 40,             // Otherwise bike when biking takes less than this
    allowDriving: false                 // true = driving competes with public transport / bike on speed
  },

  // NS door-to-door journey planner (only used when an NS_API_KEY is set).
  NS: {
    preferOverGoogleTransit: true,      // Use the NS plan instead of Google's transit plan when both exist
    language: 'en'                      // 'nl' or 'en' for station/product names
  },

  // Keyword rules: when an event title contains one of the keywords, these settings apply.
  SPECIAL_RULES: [
    {
      keywords: ['flight', 'vlucht', 'vliegen'],
      arrivalBufferMinutes: 120,        // Arrive 2 hours early
      disableReturnHome: true           // Do not create a return-home travel block
    }
  ]
};
