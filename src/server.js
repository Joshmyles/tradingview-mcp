/**
 * Default entry point: the workflow profile.
 *
 * Pine Script strategy development against a live chart. The generic
 * UI-driving surface is NOT here — see profiles.js for why, and
 * server-diag.js if you need it.
 */
import { startServer } from './server-common.js';
import { registerWorkflowTools, WORKFLOW_TOOL_COUNT } from './profiles.js';

await startServer({
  profile: 'workflow',
  toolCount: WORKFLOW_TOOL_COUNT,
  register: registerWorkflowTools,
  extraNotes: `
This profile deliberately excludes the tools that synthesise clicks and
keystrokes, along with layout, tab, pane, drawing and watchlist management.
Run server-diag.js if you need them. No tool in this bridge can place an
order or touch broker state; that path was removed, not disabled.
`,
});
