import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/chart.js';
import { awaitSettled } from '../settle.js';

export function registerChartTools(server) {
  server.tool('chart_get_state', 'Get current chart state (symbol, timeframe, chart type, indicators)', {}, async () => {
    try { return jsonResult(await core.getState()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_await_settled', 'Wait until the chart has finished recomputing, and report what happened. Mutating tools return immediately without waiting, and reads wait for themselves, so this is for the case in between: you changed something and want to know the chart has caught up before acting on it. Never returns a bare boolean — the outcome distinguishes "still loading" from "will never load".', {
    entity_id: z.string().optional().describe('Wait on one specific study. Omit to use scope.'),
    scope: z.enum(['target', 'strategies', 'all']).optional().describe('target = the entity_id only; strategies = every strategy on the chart (default); all = every visible study. TradingView housekeeping sources (dividends, splits, earnings, rolldates) are never waited on — they sit at status 1 forever on symbols with no corporate actions.'),
    require_series: z.coerce.boolean().optional().describe('Also wait for the price series itself. Needed when the next thing you do reads bars.'),
    timeout_ms: z.coerce.number().optional().describe('Default 90000. A 45S->30S change on a six-module strategy measured 19-28s on this hardware.'),
  }, async ({ entity_id, scope, require_series, timeout_ms }) => {
    try {
      const r = await awaitSettled({
        ...(entity_id && { entityId: entity_id }),
        ...(scope && { scope }),
        ...(require_series && { requireSeries: require_series }),
        ...(timeout_ms && { timeoutMs: timeout_ms }),
      });
      // The full study snapshot is diagnostic bulk; keep the outcome legible.
      const { studies, ...rest } = r;
      return jsonResult({
        success: r.outcome === 'settled',
        ...rest,
        study_count: studies?.length ?? 0,
      });
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_symbol', 'Change the chart symbol. Returns as soon as the change is issued — it does NOT wait for the chart to recompute, and does not claim to. Reads gate themselves, so a following data_* call already waits; use chart_await_settled only if you need the chart caught up before doing something that is not a read.', {
    symbol: z.string().describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.setSymbol({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_timeframe', 'Change the chart timeframe/resolution. Returns as soon as the change is issued — it does NOT wait for the chart to recompute. Reads gate themselves; use chart_await_settled if you need the chart caught up before a non-read action.', {
    timeframe: z.string().describe('Timeframe. Minutes as a bare number (1, 5, 15, 60), seconds with an S suffix (1S, 15S, 45S), then D, W, M. Seconds resolutions are NOT validated on the way in and are not available on every symbol or plan — an unsupported one leaves the chart loading indefinitely; chart_await_settled reports that as errored rather than waiting forever.'),
  }, async ({ timeframe }) => {
    try { return jsonResult(await core.setTimeframe({ timeframe })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_type', 'Change chart type', {
    chart_type: z.string().describe('Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — pass name or number'),
  }, async ({ chart_type }) => {
    try { return jsonResult(await core.setType({ chart_type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_manage_indicator', 'Add or remove an indicator/study on the chart', {
    action: z.enum(['add', 'remove']).describe('Action: add or remove'),
    indicator: z.string().optional().describe('Full indicator name (required for add): "Relative Strength Index", "MACD", "Volume", "Moving Average", "Bollinger Bands", "Moving Average Exponential". Short names like RSI/EMA do NOT work. Not needed for remove.'),
    entity_id: z.string().optional().describe('Entity ID (from chart_get_state). Required for remove.'),
    inputs: z.string().optional().describe('JSON string of input overrides for the indicator (e.g., \'{"length": 20}\')'),
  }, async ({ action, indicator, entity_id, inputs }) => {
    try {
      if (action === 'add' && !indicator) throw new Error('indicator name is required for add action.');
      return jsonResult(await core.manageIndicator({ action, indicator, entity_id, inputs }));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_get_visible_range', 'Get the visible date range (unix timestamps) and bars range on the chart', {}, async () => {
    try { return jsonResult(await core.getVisibleRange()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_visible_range', 'Zoom the chart to a specific date range (unix timestamps)', {
    from: z.coerce.number().describe('Start of range (unix timestamp in seconds)'),
    to: z.coerce.number().describe('End of range (unix timestamp in seconds)'),
  }, async ({ from, to }) => {
    try { return jsonResult(await core.setVisibleRange({ from, to })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_scroll_to_date', 'Jump the chart view to center on a specific date', {
    date: z.string().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string'),
  }, async ({ date }) => {
    try { return jsonResult(await core.scrollToDate({ date })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('symbol_info', 'Get detailed metadata about the current symbol (name, exchange, type, description)', {}, async () => {
    try { return jsonResult(await core.symbolInfo()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('symbol_search', 'Search for symbols by name or keyword', {
    query: z.string().describe('Search query (e.g., "AAPL", "crude oil", "ES")'),
    type: z.string().optional().describe('Filter by type (e.g., "stock", "futures", "crypto", "forex")'),
  }, async ({ query, type }) => {
    try { return jsonResult(await core.symbolSearch({ query, type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
