/**
 * Shared server construction for both profiles.
 *
 * The two entry points differ only in which tools they register and what they
 * tell the caller they are. Everything else lives here so the profiles cannot
 * drift apart in ways nobody intended.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const GUIDE = `TOOL SELECTION GUIDE — use this to pick the right tool:

READING COMPUTED DATA — these gate themselves:
- data_get_strategy_results → performance metrics from the strategy report
- data_get_trades → filled orders (entries and exits), each with its tag
- data_get_equity → cumulative P&L per CLOSED TRADE (TradingView exposes no
  per-bar account curve; anything presented as one is inferred)
- data_get_study_values → current numeric values from all visible indicators
- data_get_ohlcv → price bars. ALWAYS pass summary=true unless you need bars
- quote_get → real-time price snapshot

These wait for the chart to finish recomputing before answering, and FAIL
rather than return a book from the previous chart state. The wait is however
long the recompute genuinely takes — roughly 300ms on a settled chart, and
15-20s after a symbol or timeframe change on a seconds chart. Pass wait=false
only when you would rather have the previous state than wait for this one.

CHANGING THE CHART — these do NOT wait:
- chart_set_symbol, chart_set_timeframe → return { applied: true,
  settled: false, fence }. The chart has been told; it has not finished.
- chart_await_settled → block until the recompute finishes, if you need to
  wait explicitly rather than letting the next read do it
- chart_manage_indicator → add/remove studies. USE FULL NAMES
- indicator_set_inputs → change indicator settings

Reading custom Pine drawings (line.new/label.new/table.new/box.new):
- data_get_pine_lines / _labels / _tables / _boxes
- ALWAYS pass study_filter to target one indicator by name
- the indicator must be VISIBLE on the chart

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ — avoid unless editing

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Alerts: alert_create, alert_list, alert_delete
Launch: tv_launch → auto-detect and start TradingView with CDP

CONTEXT MANAGEMENT:
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- responses are capped and report exactly what was dropped when they are
- call chart_get_state ONCE at start, reuse entity IDs`;

export async function startServer({ profile, toolCount, register, extraNotes = '' }) {
  const server = new McpServer(
    {
      name: profile === 'diagnostic' ? 'tradingview-diag' : 'tradingview',
      version: '2.0.0',
      description:
        'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
    },
    {
      instructions: `TradingView MCP — ${toolCount} tools (${profile} profile) for reading and controlling a live TradingView Desktop chart.
${extraNotes}
${GUIDE}`,
    },
  );

  register(server);

  process.stderr.write(
    `⚠  tradingview-mcp  |  ${profile} profile, ${toolCount} tools  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n`,
  );
  process.stderr.write("   Ensure your usage complies with TradingView's Terms of Use.\n\n");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
