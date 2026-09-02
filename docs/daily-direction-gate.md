# Daily Dynamics direction gate

- The selection applies to Gamma 1.0, 2.0, 3.0 and Delta new parent/child
  admissions. Existing legs continue to be marked; primary options are unchanged.
- LONG ONLY, SHORT ONLY and RESET BOTH are explicit user choices. A browser
  refresh, network reconnect, engine stop or Render restart does not reset them.
- The backend stores the preference and expiry in the existing `configurations`
  table under version `runtime:dynamics-direction-gate` (inactive, not a strategy
  version). No new Supabase table or migration is required.
- The gate expires at the scheduled 18:00 America/New_York stream close, including
  daylight-saving changes. A choice made after close or on a weekend applies to
  the next weekday stream. This follows the app's existing weekday scheduler.
- The backend reloads the setting on startup, every live bar, and status requests.
  If persistence cannot be checked, the live bar is not admitted; a failed save
  does not acknowledge a selection. An expired persisted preference reads as BOTH.
- The top bar reports the verified setting. Pending/stale API responses cannot
  overwrite a newly acknowledged choice in the browser.
- Deploy Render and Vercel; select the desired direction once after this first
  deployment, since choices made by the previous in-memory version were not saved.
