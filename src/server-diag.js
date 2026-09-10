/**
 * Diagnostic entry point: the workflow profile plus the UI-driving surface.
 *
 * Use this for investigating the TradingView front end itself — locating
 * elements, driving panels, managing layouts and tabs. It is not the default
 * for the reason set out in profiles.js: this surface can reach any control on
 * the page, and the session in use has a live broker account attached.
 */
import { startServer } from './server-common.js';
import { registerDiagnosticTools, DIAGNOSTIC_TOOL_COUNT } from './profiles.js';

await startServer({
  profile: 'diagnostic',
  toolCount: DIAGNOSTIC_TOOL_COUNT,
  register: registerDiagnosticTools,
  extraNotes: `
DIAGNOSTIC PROFILE. This adds tools that synthesise clicks, keystrokes and
pointer events against the live TradingView UI. They can reach any control on
the page. The named trading-panel target has been deleted from the codebase,
but treat everything here as capable of touching whatever is on screen.
`,
});
