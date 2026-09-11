import { z } from 'zod';
import { jsonResult, fromThrown } from './_format.js';
import * as core from '../core/backtest.js';
import { equityCurve } from '../core/equity.js';

const windowSchema = z
  .object({
    from: z.coerce.number().describe('Window start, epoch milliseconds'),
    to: z.coerce.number().describe('Window end, epoch milliseconds'),
  })
  .describe('Explicit backtest window. Runs a server-side Deep Backtest over exactly these dates.');

export function registerBacktestTools(server) {
  server.tool(
    'backtest_run',
    'Run a backtest and return DISTRIBUTIONS, not the trade book. ' +
      'Without a window it reads the on-chart Strategy Tester report through the recompute barrier. ' +
      'With a window it runs a server-side Deep Backtest over exactly those dates, which does not touch the chart. ' +
      'The default payload is a few KB: performance, P&L, MAE/MFE/bars-held distributions, entry-tag splits, ' +
      'concentration measures, and an optional stop counterfactual. A full 105-trade book is ~77,000 characters, ' +
      'so raw rows are opt-in via include. ' +
      'Pass manifest to refuse the run unless the chart carries the configuration you meant; without it the result describes whatever the study happened to be set to. ' +
      'NOTE: TradingView SNAPS a requested window to available data — always read the returned window, never assume the requested one was used.',
    {
      entity_id: z.string().optional().describe('Study entity ID (from chart_get_state). On-chart reads only.'),
      window: windowSchema.optional(),
      include: z
        .array(z.enum(['trades', 'orders']))
        .optional()
        .describe('Add raw rows to the response. Omit unless you actually need per-row data.'),
      build: z
        .string()
        .optional()
        .describe('Build the manifest describes, e.g. "b14". Checked against the study title for equality; asserting one build against the manifest of another build is an error, not a mismatch report.'),
      manifest: z
        .record(z.any())
        .optional()
        .describe('Expected study configuration (from pine_inputs_snapshot with include ["manifest"]). Asserted BEFORE the run; a mismatch refuses to run rather than returning a result that describes the wrong build.'),
      stop_levels: z
        .array(z.coerce.number())
        .optional()
        .describe('Candidate fixed adverse-excursion stop levels, in the book\'s P&L units. Adds a counterfactual table plus a sensitivity sweep over MAE scale factors. Reported MAE is read off bar extremes and is a lower bound, so read the sensitivity, not just the base row.'),
      split_tokens: z
        .array(z.string())
        .optional()
        .describe('Entry-tag tokens to split the book on. Default ["ADD"].'),
      timeout_ms: z.coerce.number().optional().describe('Default 300000. A 7-day 45S deep window measured 13-20s.'),
    },
    async ({ entity_id, window, include, stop_levels, split_tokens, manifest, build, timeout_ms }) => {
      try {
        return jsonResult(
          await core.backtestRun({
            entityId: entity_id,
            window,
            include: include || [],
            stopLevels: stop_levels || null,
            splitTokens: split_tokens || ['ADD'],
            manifest: manifest || null,
            build: build || null,
            timeoutMs: timeout_ms,
          }),
        );
      } catch (err) {
        return jsonResult(fromThrown(err));
      }
    },
  );

  server.tool(
    'walk_forward',
    'Run backtest_run over several windows and return one aggregated row each, plus a pooled block. ' +
      'Sequential by necessity: there is one Strategy Tester and one deep-backtest slot, and overlapping requests would race for the same cached report. ' +
      'A window that fails is reported in place and the walk continues — a walk-forward with a hole in it is still evidence. ' +
      'Windows extending past the live edge will fail with window_mismatch; that is the guard working, not a bug. ' +
      'Each row reports the SNAPPED window, not the requested one. TradingView snaps to available data and two distinct requests can snap onto the SAME window — ' +
      'those rows are excluded from the pooled block and reported in duplicate_windows, because two rows describing identical data are one observation. ' +
      'Windows that merely overlap are flagged in overlapping_windows and still pooled.',
    {
      windows: z
        .array(windowSchema)
        .min(1)
        .describe('Windows to run, each { from, to } in epoch milliseconds.'),
      entity_id: z.string().optional().describe('Study entity ID. Omit to resolve the strategy on the chart; refuses if more than one matches.'),
      manifest: z
        .record(z.any())
        .optional()
        .describe('Expected study configuration. Asserted BEFORE each window; a mismatch refuses to run. Without it the whole walk describes whatever the study happened to be set to.'),
      build: z
        .string()
        .optional()
        .describe('Build the manifest describes, e.g. "b14". Checked against the study title for equality.'),
      stop_levels: z.array(z.coerce.number()).optional().describe('Candidate stop levels, applied identically to every window so the rows are comparable.'),
      split_tokens: z.array(z.string()).optional().describe('Entry-tag tokens to split on. Default ["ADD"].'),
      timeout_ms: z.coerce.number().optional().describe('Per-window timeout. Default 300000.'),
    },
    async ({ windows, entity_id, stop_levels, split_tokens, manifest, build, timeout_ms }) => {
      try {
        return jsonResult(
          await core.walkForward({
            windows,
            entityId: entity_id,
            stopLevels: stop_levels || null,
            splitTokens: split_tokens || ['ADD'],
            manifest: manifest || null,
            build: build || null,
            timeoutMs: timeout_ms,
          }),
        );
      } catch (err) {
        return jsonResult(fromThrown(err));
      }
    },
  );

  server.tool(
    'equity_curve',
    'Reconstruct the PER-BAR mark-to-market equity curve for the on-chart strategy and return risk statistics computed by a written-down method. ' +
      'TradingView exposes no per-bar account curve — only a per-closed-trade cumulative P&L, and Sharpe/Sortino/max-drawdown computed from a curve it does not publish. ' +
      'This builds the curve from the trade legs joined against price bars BY TIME, loading whatever price history the backtest window needs first. ' +
      'Every run validates itself by recomputing the MAE and MFE of every leg from the same bars and matching them against the report; read excursion_validation before using any number below it. ' +
      'Returns Sharpe and Sortino at several sampling intervals, because a Sharpe threshold is meaningless without one, plus max drawdown with its timing and the excursion-timing distribution (where in the life of a trade its worst point falls, split by outcome). ' +
      'Takes 15-20s on a first run because it extends loaded price history; a second run on the same window is about 1s. ' +
      'Also identifies what method produces the TradingView Sharpe and drawdown by testing candidates against the reconstruction, rather than reporting the difference as unexplained. ' +
      'NOTE: extending history moves the backtest window start, so the book is re-read afterwards and the returned window is the one the numbers describe.',
    {
      entity_id: z.string().optional().describe('Study entity ID (from chart_get_state). Defaults to the strategy with a computed report.'),
      include: z
        .array(z.enum(['curve', 'paths', 'tightening']))
        .optional()
        .describe('"curve" adds the equity curve downsampled to ~500 points; "paths" adds per-leg excursion rows; "tightening" sizes a give-back floor against this book at several arm levels. curve and paths are large — omit unless plotting or auditing.'),
      max_history_rounds: z.coerce.number().optional().describe('Cap on history-extension rounds. Default 8, which reached 21,675 bars in under 4s.'),
    },
    async ({ entity_id, include, max_history_rounds }) => {
      try {
        return jsonResult(
          await equityCurve({
            entityId: entity_id,
            include: include || [],
            ...(max_history_rounds && { maxHistoryRounds: max_history_rounds }),
          }),
        );
      } catch (err) {
        return jsonResult(fromThrown(err));
      }
    },
  );
}
