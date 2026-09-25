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
  // Calendars to read events from.
  SOURCE_CALENDARS: [
    {
      id: 'primary',          // 'primary' or a calendar ID (Calendar settings → Integrate calendar)
      locationPrefix: '',     // Prepended to every location, e.g. 'My University, ' when events only list a room
      defaultLocation: ''     // Used when an event has no location at all ('' = skip those events)
    }
  ],

  // Calendar the travel blocks are written to. Use a DEDICATED calendar: the script
  // deletes and recreates the travel blocks it created there.
  TARGET_CALENDAR_ID: 'your-travel-calendar-id@group.calendar.google.com', // Script Property: TARGET_CALENDAR_ID

  HOME_LOCATION: 'Your Street 1, Your City, Country', // Script Property: HOME_LOCATION

  // NS (Dutch Railways) API key from https://apiportal.ns.nl/ (product "Ns-App").
  // Leave empty to disable the NS travel option.
  NS_API_KEY: '', // Script Property: NS_API_KEY

  TIME_ZONE: '',                        // '' = the script time zone (appsscript.json)
  SEARCH_RANGE_DAYS: 7,                 // Lookahead window in days
  MAX_GAP_BEFORE_HOME_HOURS: 10,        // Max gap between events before assuming you went home in between
  ARRIVAL_BUFFER_MINUTES: 5,            // Default: arrive this many minutes before an event starts
  MIN_TRAVEL_DURATION_SEC: 180,         // Ignore trips shorter than 3 minutes
  API_DELAY_MS: 150,                    // Pause between Maps API calls to avoid rate limit errors
  SKIP_DECLINED_EVENTS: true,           // Don't plan travel for events you declined

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
