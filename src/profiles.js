/**
 * Tool profiles.
 *
 * The bridge exposes two surfaces, and which one is loaded is a deployment
 * decision rather than a runtime flag.
 *
 *   workflow     what Pine Script strategy development against a live chart
 *                actually needs. This is the default.
 *   diagnostic   workflow plus the generic UI-driving surface: synthesised
 *                clicks, keystrokes, pointer events, and the layout/tab/
 *                watchlist plumbing.
 *
 * Why the split is not cosmetic: the TradingView session this is used against
 * has a live IC Markets broker account attached. `ui_click`, `ui_mouse_click`,
 * `ui_type_text` and `ui_keyboard` can reach any control on the page, and the
 * order panel is a control on the page. The named 'trading' panel target has
 * been deleted outright (see core/ui.js), but generic input synthesis is a
 * general-purpose capability that cannot be narrowed by deletion without
 * removing the tool. Keeping it out of the default surface is the remaining
 * lever, and a smaller default surface is easier to reason about besides.
 *
 * `ui_evaluate` stays in the workflow profile. It is the route to the Pine
 * Logs and to historical bars beyond data_get_ohlcv's 500-bar reach, both of
 * which are load-bearing for strategy work — and it evaluates an expression
 * rather than synthesising a click, so it does not reach the order panel by
 * the same accident. It is a real capability and it is listed here so that is
 * a decision on the record rather than an oversight.
 */
import { registerHealthTools } from './tools/health.js';
import { registerChartTools } from './tools/chart.js';
import { registerPineTools } from './tools/pine.js';
import { registerDataTools } from './tools/data.js';
import { registerBacktestTools } from './tools/backtest.js';
import { registerForensicsTools } from './tools/forensics.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerDrawingTools } from './tools/drawing.js';
import { registerAlertTools } from './tools/alerts.js';
import { registerBatchTools } from './tools/batch.js';
import { registerReplayTools } from './tools/replay.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerWatchlistTools } from './tools/watchlist.js';
import { registerUiTools, registerUiEvaluateTool } from './tools/ui.js';
import { registerPaneTools } from './tools/pane.js';
import { registerTabTools } from './tools/tab.js';

/**
 * Count a profile by registering it against a stub.
 *
 * Derived, not written down. A hand-maintained table was tried first and was
 * wrong within the hour: it claimed 85 tools for a profile that registered 81,
 * because a whole group had been left out of the registration while its four
 * tools stayed in the table. A number that is computed from the thing it
 * describes cannot disagree with it.
 */
function countTools(register) {
  const names = [];
  register({ tool: (name) => names.push(name) });
  return names;
}

export const WORKFLOW_TOOL_NAMES = countTools(registerWorkflowTools);
export const DIAGNOSTIC_TOOL_NAMES = countTools(registerDiagnosticTools);
export const WORKFLOW_TOOL_COUNT = WORKFLOW_TOOL_NAMES.length;
export const DIAGNOSTIC_TOOL_COUNT = DIAGNOSTIC_TOOL_NAMES.length;

/** Everything strategy development needs, and nothing that drives the UI. */
export function registerWorkflowTools(server) {
  registerHealthTools(server);
  registerChartTools(server);
  registerPineTools(server);
  registerDataTools(server);
  registerBacktestTools(server);
  registerForensicsTools(server);
  registerCaptureTools(server);
  registerAlertTools(server);
  registerReplayTools(server);
  registerIndicatorTools(server);
  registerUiEvaluateTool(server);
}

/** The workflow surface plus the generic UI and window-management surface. */
export function registerDiagnosticTools(server) {
  registerWorkflowTools(server);
  registerUiTools(server);
  registerDrawingTools(server);
  registerBatchTools(server);
  registerPaneTools(server);
  registerTabTools(server);
  registerWatchlistTools(server);
}
