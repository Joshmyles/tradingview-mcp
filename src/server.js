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
Run server-diag.js if you need them.

No tool in this profile submits, modifies or cancels an order. As of
2026-09-12 that is enforced rather than asserted: tests/no-order-path.test.js
walks the import graph of both profiles and fails on any reachable call that
could emit one. Position and P&L are still READ (replay_status), which is not
the same capability.

CORRECTION, on the record because this text previously claimed otherwise:
until 2026-09-12 this note said the order path had been "removed, not
disabled", and that was false. `replay_trade` was registered in THIS profile
and drove the replay API's buy / sell / close-position methods. It was inert
only by accident of this TradingView build, and it answered success while
submitting nothing. It is now deleted; see the tombstone in core/replay.js.
`,
});
