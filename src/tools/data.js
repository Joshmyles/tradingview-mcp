import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/data.js';

export function registerDataTools(server) {
  server.tool('data_get_ohlcv', 'Get OHLCV bar data from the chart. Waits for the price series to finish loading before reading. Use summary=true for compact stats instead of all bars (saves context).', {
    count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
    wait: z.coerce.boolean().optional().describe('Default true: waits for the chart to finish recomputing before reading, so the result cannot describe the previous chart state. Set false only when you deliberately want whatever is on screen right now; the result is marked settled:false when you do.'),
  }, async ({ count, summary, wait }) => {
    try { return jsonResult(await core.getOhlcv({ count, summary, wait })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_indicator', 'Get indicator/study info and input values', {
    entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getIndicator({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_strategy_results', 'Get strategy performance metrics from the Strategy Tester report. Waits for the report to be rebuilt before reading, so the numbers cannot be the previous window\'s book; fails with a reason rather than returning a stale one. Auto-opens the panel and auto-unhides a hidden strategy (TradingView never computes reports for hidden strategies); result includes unhidden_strategies when that happened. The provenance field carries the report generation, how long the wait took, the window covered, and a reconciliation of trade rows against fills.', {}, async () => {
    try { return jsonResult(await core.getStrategyResults()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_trades', 'Get the FILLED ORDER list from the Strategy Tester (one row per fill, not one per round-trip trade — a multi-leg close is several rows). Waits for the report to be rebuilt before reading. Auto-opens the panel and auto-unhides a hidden strategy. Each row carries its order tag, which is where Pine-side metadata comes back.', {
    max_trades: z.coerce.number().optional().describe('Maximum orders to return, counted from the most recent (max 20)'),
  }, async ({ max_trades }) => {
    try { return jsonResult(await core.getTrades({ max_trades })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_equity', 'Get the equity curve: cumulative P&L after each closed trade, with the buy-and-hold baseline alongside it. This is per closed trade, NOT per bar — TradingView does not expose a per-bar account curve through this channel. Waits for the report to be rebuilt before reading.', {}, async () => {
    try { return jsonResult(await core.getEquity()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('quote_get', 'Get real-time quote data for a symbol (price, OHLC, volume). If symbol is provided and differs from the current chart, the chart is briefly switched to fetch the quote and then restored — adds ~1-2s and serializes parallel calls.', {
    symbol: z.string().optional().describe('Symbol to quote (blank = current chart symbol). Non-blank values cause a chart switch + restore.'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getQuote({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('depth_get', 'Get order book / DOM (Depth of Market) data from the chart', {}, async () => {
    try { return jsonResult(await core.getDepth()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Open the DOM panel in TradingView before using this tool.' }, true); }
  });

  server.tool('data_get_pine_lines', 'Read horizontal price levels drawn by Pine Script indicators (line.new). Returns deduplicated price levels per study. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw line data with IDs, coordinates, colors (default false — returns only unique price levels)'),
    wait: z.coerce.boolean().optional().describe('Default true: waits for the chart to finish recomputing before reading, so the result cannot describe the previous chart state. Set false only when you deliberately want whatever is on screen right now; the result is marked settled:false when you do.'),
  }, async ({ study_filter, verbose, wait }) => {
    try { return jsonResult(await core.getPineLines({ study_filter, verbose, wait })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_labels', 'Read text labels drawn by Pine Script indicators (label.new). Returns text and price pairs. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    max_labels: z.coerce.number().optional().describe('Max labels per study (default 50). Set higher if you need all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw label data with IDs, colors, positions (default false — returns only text + price)'),
    wait: z.coerce.boolean().optional().describe('Default true: waits for the chart to finish recomputing before reading, so the result cannot describe the previous chart state. Set false only when you deliberately want whatever is on screen right now; the result is marked settled:false when you do.'),
  }, async ({ study_filter, max_labels, verbose, wait }) => {
    try { return jsonResult(await core.getPineLabels({ study_filter, max_labels, verbose, wait })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_tables', 'Read table data drawn by Pine Script indicators (table.new). Returns formatted text rows per table. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    wait: z.coerce.boolean().optional().describe('Default true: waits for the chart to finish recomputing before reading, so the result cannot describe the previous chart state. Set false only when you deliberately want whatever is on screen right now; the result is marked settled:false when you do.'),
  }, async ({ study_filter, wait }) => {
    try { return jsonResult(await core.getPineTables({ study_filter, wait })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_boxes', 'Read box/zone boundaries drawn by Pine Script indicators (box.new). Returns deduplicated {high, low} price zones. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return all boxes with IDs and coordinates (default false — returns unique price zones)'),
    wait: z.coerce.boolean().optional().describe('Default true: waits for the chart to finish recomputing before reading, so the result cannot describe the previous chart state. Set false only when you deliberately want whatever is on screen right now; the result is marked settled:false when you do.'),
  }, async ({ study_filter, verbose, wait }) => {
    try { return jsonResult(await core.getPineBoxes({ study_filter, verbose, wait })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_study_values', 'Get current indicator values from the data window for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()).', {
    wait: z.coerce.boolean().optional().describe('Default true: waits for the chart to finish recomputing before reading, so the result cannot describe the previous chart state. Set false only when you deliberately want whatever is on screen right now; the result is marked settled:false when you do.'),
  }, async ({ wait }) => {
    try { return jsonResult(await core.getStudyValues({ wait })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
