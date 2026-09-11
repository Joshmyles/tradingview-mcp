import { z } from 'zod';
import { jsonResult, fromThrown } from './_format.js';
import * as core from '../core/replay.js';

export function registerReplayTools(server) {
  server.tool('replay_start', 'Start bar replay mode, optionally at a specific date', {
    date: z.string().optional().describe('Date to start replay from (YYYY-MM-DD format). If omitted, selects first available date.'),
  }, async ({ date }) => {
    try { return jsonResult(await core.start({ date })); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('replay_step', 'Advance one bar in replay mode', {}, async () => {
    try { return jsonResult(await core.step()); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('replay_autoplay', 'Toggle autoplay in replay mode, optionally set speed', {
    speed: z.coerce.number().optional().describe('Autoplay delay in ms (lower = faster). Valid values: 100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000. Leave empty to just toggle.'),
  }, async ({ speed }) => {
    try { return jsonResult(await core.autoplay({ speed })); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('replay_stop', 'Stop replay and return to realtime', {}, async () => {
    try { return jsonResult(await core.stop()); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('replay_trade', 'Execute a trade action in replay mode (buy, sell, or close position)', {
    action: z.string().describe('Trade action: buy, sell, or close'),
  }, async ({ action }) => {
    try { return jsonResult(await core.trade({ action })); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('replay_status', 'Get current replay mode status', {}, async () => {
    try { return jsonResult(await core.status()); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool(
    'replay_step_until',
    'Advance bar replay until a predicate holds, returning ONLY the stopping state. ' +
    'The stepping loop runs inside the page, so 500 bars cost one call rather than 500 round trips, ' +
    'and no per-bar trace comes back \u2014 skipping the bars is the point. ' +
    'Predicate fields split in two: the SERIES tier (time, open, high, low, close, volume, position, realized_pl, log_count) ' +
    'moves with the step and is safe per bar; the REPORT tier (trades) lags a full study recompute of 13-21s per bar, ' +
    'so it is REFUSED unless settle_each_step is set rather than being served stale. ' +
    'Times are epoch MILLISECONDS, like everywhere else in this bridge \u2014 TradingView\u2019s own replay cursor is in seconds and is converted at the boundary. ' +
    'Replay is left AT the stopping bar deliberately; call replay_stop to return to realtime.',
    {
      predicate: z
        .record(z.string(), z.any())
        .describe('One clause { field, op, value }, or { all: [...] } / { any: [...] }. op is gt, gte, lt, lte, eq, ne, or changed (which compares against the value at the first bar and takes no value).'),
      max_bars: z.coerce.number().optional().describe('Upper bound on bars advanced. Default 500. Reaching it is an answer, not a failure.'),
      entity_id: z.string().optional().describe('Study for log_count / trades. Resolved explicitly; refuses when more than one study matches.'),
      settle_each_step: z.coerce.boolean().optional().describe('Wait for the study to finish recomputing after every bar. Required for report-tier fields. Turns a ~300ms step into a ~20s one.'),
      step_timeout_ms: z.coerce.number().optional().describe('Per-step ceiling on waiting for the replay cursor to move. Default 30000; measured steps ranged 283-7711ms, so this is deliberately generous.'),
      deadline_ms: z.coerce.number().optional().describe('Wall-clock budget for the whole run. Default 240000.'),
    },
    async ({ predicate, max_bars, entity_id, settle_each_step, step_timeout_ms, deadline_ms }) => {
      try {
        return jsonResult(
          await core.stepUntil({
            predicate,
            maxBars: max_bars ?? undefined,
            entityId: entity_id || null,
            settleEachStep: settle_each_step === true,
            stepTimeoutMs: step_timeout_ms ?? undefined,
            deadlineMs: deadline_ms ?? undefined,
          }),
        );
      } catch (err) {
        return jsonResult(fromThrown(err));
      }
    },
  );
}
