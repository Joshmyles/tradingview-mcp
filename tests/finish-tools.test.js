/**
 * Unit tests for the four finishing tools and the pieces they rest on.
 * No live chart: every page interaction is a stub.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeCursor,
  encodeCursor,
  levelMaskValue,
  levelWord,
  resolveCursor,
  rowFingerprint,
} from '../src/internals/pine-logs.js';
import { pineConsoleRead } from '../src/core/pine-console.js';
import { CLEAR_REPLAY_SESSION_JS, summariseSteps, validatePredicate } from '../src/internals/replay.js';
import { stepUntil, stop } from '../src/core/replay.js';
import { strategyAlertConfigs } from '../src/internals/alert-config.js';
import { preflight } from '../src/core/preflight.js';
import { resolutionSeconds } from '../src/core/chart.js';
import { AS_FOUND, compareAsFound, lossAutopsy } from '../src/core/autopsy.js';
import { MAX_RESPONSE_CHARS } from '../src/tools/_format.js';

/** A page stub that answers resolveEntity's listing and then `rest`. */
function pageStub(studies, rest = () => null) {
  return async (expr) => {
    if (expr.includes('is_strategy') && expr.includes('report_present')) {
      return { ok: true, symbol: 'ICMARKETS:XAUUSD', resolution: '45S', studies };
    }
    return rest(expr);
  };
}
const B14 = { entity_id: 'xVbiv5', title: 'B14', is_strategy: true, report_present: true };
const rows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    time: 1000 + i, bar_time: 1000 + i, level: 4, line: 10, column: 1,
    message: i % 3 === 0 ? `CFG|${i}` : `CENSUS|${i}`,
  }));

describe('pine logs internals', () => {
  it('decodes level bits and packs masks the way setLogLevelMask does', () => {
    assert.equal(levelWord(1), 'error');
    assert.equal(levelWord(4), 'info');
    assert.equal(levelWord(8), 'unknown_8');
    assert.equal(levelMaskValue({ error: true, warning: true, info: true }), 7);
    assert.equal(levelMaskValue({ info: true }), 4);
  });

  it('round-trips a cursor and rejects one it did not issue', () => {
    const c = encodeCursor({ n: 3, head: 'a', prev: 'b' });
    assert.deepEqual(decodeCursor(c), { n: 3, head: 'a', prev: 'b' });
    assert.deepEqual(decodeCursor('not-a-cursor'), { invalid: true });
  });

  it('refuses a stale cursor instead of returning a different slice', () => {
    const r = rows(10);
    const good = encodeCursor({ n: 4, head: rowFingerprint(r[0]), prev: rowFingerprint(r[3]) });
    assert.deepEqual(resolveCursor(good, r), { ok: true, from: 4, fresh: false });

    assert.equal(resolveCursor(encodeCursor({ n: 4, head: 'deadbeef', prev: null }), r).reason, 'cursor_stale');
    assert.equal(resolveCursor(encodeCursor({ n: 99, head: null, prev: null }), r).reason, 'cursor_stale');
    const changed = r.map((x, i) => (i === 3 ? { ...x, message: 'different' } : x));
    assert.equal(resolveCursor(good, changed).reason, 'cursor_stale');
  });
});

describe('pine_console_read', () => {
  const deps = (logs) => ({ evaluate: pageStub([B14], () => logs) });

  it('says why an empty read is empty: disabled is not absent', async () => {
    const off = await pineConsoleRead({
      wait: false,
      _deps: deps({ ok: true, entity_id: 'xVbiv5', title: 'B14', collection: 'disabled', mask: { error: false, warning: false, info: false }, total: 0, rows: [] }),
    });
    assert.equal(off.collection, 'disabled');
    assert.match(off.note, /OFF/);
    const none = await pineConsoleRead({
      wait: false,
      _deps: deps({ ok: true, entity_id: 'xVbiv5', title: 'B14', collection: 'absent', mask: null, total: 0, rows: [] }),
    });
    assert.equal(none.collection, 'absent');
    assert.match(none.note, /no log\.\* calls/);
  });

  it('pages the whole log with no gap and no overlap, filter independent of cursor', async () => {
    const all = rows(25);
    const logs = { ok: true, entity_id: 'xVbiv5', title: 'B14', collection: 'present', mask: { info: true }, total: all.length, rows: all };
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 10; i++) {
      const p = await pineConsoleRead({ wait: false, limit: 7, sinceCursor: cursor, _deps: deps(logs) });
      assert.equal(p.ok, true);
      seen.push(...p.rows.map((r) => r.time));
      cursor = p.next_cursor;
      if (!p.truncation.applied) break;
    }
    assert.deepEqual(seen, all.map((r) => r.time));

    const cfg = await pineConsoleRead({ wait: false, prefix: 'CFG|', _deps: deps(logs) });
    assert.equal(cfg.matched, 9);
    assert.ok(cfg.rows.every((r) => r.message.startsWith('CFG|')));
  });

  it('refuses ambiguity and bad arguments before reading', async () => {
    const two = [B14, { entity_id: 'q2', title: 'B14 copy', is_strategy: true, report_present: true }];
    const amb = await pineConsoleRead({ entityId: 'B1', wait: false, _deps: { evaluate: pageStub(two) } });
    assert.equal(amb.reason, 'ambiguous_entity');
    const bad = await pineConsoleRead({ level: 'verbose', _deps: deps(null) });
    assert.equal(bad.reason, 'invalid_argument');
  });

  it('caps a page by size and resumes at the first row it did not return', async () => {
    const long = Array.from({ length: 40 }, (_, i) => ({
      time: 5000 + i, bar_time: 5000 + i, level: 4, line: 1, column: 1, message: `CENSUS|${i}|` + 'x'.repeat(4000),
    }));
    const logs = { ok: true, entity_id: 'xVbiv5', title: 'B14', collection: 'present', mask: { info: true }, total: 40, rows: long };
    const seen = [];
    let cursor = null;
    let sizeCut = false;
    for (let i = 0; i < 20; i++) {
      const p = await pineConsoleRead({ wait: false, limit: 2000, sinceCursor: cursor, _deps: deps(logs) });
      assert.equal(p.ok, true);
      // Measured as the client receives it — pretty-printed — against the
      // budget the global trim would apply. Under it, the trim never fires.
      const pretty = JSON.stringify(p, null, 2).length;
      assert.ok(pretty < MAX_RESPONSE_CHARS, `page of ${pretty} chars would hit the global trim`);
      if (p.truncation.applied) sizeCut ||= p.truncation.reason === 'size';
      seen.push(...p.rows.map((r) => r.time));
      cursor = p.next_cursor;
      if (!p.truncation.applied) break;
    }
    assert.equal(sizeCut, true);
    assert.deepEqual(seen, long.map((r) => r.time));
  });

  it('refuses a cursor it never issued even when the collection is disabled', async () => {
    const r = await pineConsoleRead({
      wait: false,
      sinceCursor: 'not-a-cursor',
      _deps: deps({ ok: true, entity_id: 'xVbiv5', title: 'B14', collection: 'disabled', mask: {}, total: 0, rows: [] }),
    });
    assert.equal(r.reason, 'invalid_cursor');
  });
});

describe('replay_step_until', () => {
  it('validates predicates up front', () => {
    assert.equal(validatePredicate({ field: 'close', op: 'gt', value: 1 }).ok, true);
    assert.equal(validatePredicate({ any: [{ field: 'close', op: 'changed' }] }).ok, true);
    assert.match(validatePredicate({ field: 'rsi', op: 'gt', value: 1 }).error, /Unknown predicate field/);
    assert.match(validatePredicate({ field: 'close', op: 'gt', value: '1' }).error, /must be a number/);
    assert.match(validatePredicate({ field: 'trades', op: 'gt', value: 0 }).error, /lags a replay step/);
    assert.equal(validatePredicate({ field: 'trades', op: 'gt', value: 0 }, { settleEachStep: true }).ok, true);
  });

  it('returns only the stopping state from the page loop', async () => {
    const out = await stepUntil({
      predicate: { field: 'close', op: 'gte', value: 5 },
      maxBars: 10,
      _deps: {
        evaluateAsync: async () => ({
          ok: true, stopped_on: 'predicate', bars_advanced: 3, elapsed_ms: 900,
          start_state: { close: 1 }, state: { close: 5 },
          clause_results: [{ field: 'close', op: 'gte', value: 5, observed: 5, held: true }],
          step_ms: [300, 300, 300],
        }),
      },
    });
    assert.equal(out.matched, true);
    assert.equal(out.bars_advanced, 3);
    assert.equal(out.step_latency.median_ms, 300);
    assert.equal('step_ms' in out, false);
  });

  it('summarises latency without a per-bar list', () => {
    assert.deepEqual(summariseSteps([283, 7711, 599]), {
      steps: 3, min_ms: 283, median_ms: 599, p90_ms: 7711, max_ms: 7711, total_ms: 8593,
    });
  });
});

describe('replay_stop clears the saved replay session', () => {
  it('clears after stopping, so TradingView does not ask to continue the last replay', async () => {
    const calls = [];
    const r = await stop({
      _deps: {
        getReplayApi: async () => 'RP',
        evaluate: async (expr) => {
          calls.push(expr);
          if (expr.includes('isReplayStarted')) return true;
          if (expr === CLEAR_REPLAY_SESSION_JS) return { ok: true, had_saved_session: true, cleared: true };
          return null;
        },
      },
    });
    assert.equal(r.action, 'replay_stopped');
    assert.equal(r.saved_session.cleared, true);
    const stopAt = calls.findIndex((c) => c.includes('stopReplay'));
    assert.ok(stopAt >= 0 && calls.indexOf(CLEAR_REPLAY_SESSION_JS) > stopAt);
  });

  it('reports failure rather than claiming a clean stop', async () => {
    const r = await stop({
      _deps: {
        getReplayApi: async () => 'RP',
        evaluate: async (expr) => (expr.includes('isReplayStarted') ? true : expr === CLEAR_REPLAY_SESSION_JS ? { ok: false } : null),
      },
    });
    assert.equal(r.success, false);
    assert.match(r.error, /Continue your last replay/);
  });
});

describe('resolutionSeconds', () => {
  it('reads S as seconds, not minutes', () => {
    assert.equal(resolutionSeconds('45S'), 45);
    assert.equal(resolutionSeconds('30S'), 30);
    assert.equal(resolutionSeconds('5S'), 5);
    assert.equal(resolutionSeconds('1S'), 1);
    assert.equal(resolutionSeconds('5'), 300);
    assert.equal(resolutionSeconds('D'), 86400);
    assert.equal(resolutionSeconds('bogus'), null);
  });
});

describe('loss_autopsy', () => {
  it('refuses a layout that does not exist instead of using the current one', async () => {
    const r = await lossAutopsy({
      tradeIndex: 0,
      layout: 'Forensics',
      _deps: {
        evaluate: pageStub([B14], (expr) =>
          expr.includes('getSavedCharts') ? [{ id: 1, name: 'Trial Ground' }] : { symbol: 'X', resolution: '45S', layout: 'Trial Ground' },
        ),
      },
    });
    assert.equal(r.reason, 'layout_not_found');
    assert.deepEqual(r.available_layouts, ['Trial Ground']);
  });

  it('rejects bad arguments before touching the chart', async () => {
    assert.equal((await lossAutopsy({ tradeIndex: -1 })).reason, 'invalid_argument');
    assert.equal((await lossAutopsy({ tradeIndex: 0, timeframes: ['7X'] })).reason, 'invalid_argument');
  });

  it('"as found" is an explicit list, and the view is on it', () => {
    // The restore once compared everything but the visible range and reported
    // matches_as_found with the chart two weeks displaced. The list is the fix.
    assert.deepEqual(AS_FOUND.map((f) => f.what), ['layout', 'symbol', 'resolution', 'visible_range']);

    const before = { layout: 'Trial Ground', symbol: 'ICMARKETS:XAUUSD', resolution: '45S', time_range: { from: 1000, to: 5000 } };
    const same = compareAsFound(before, { ...before, time_range: { from: 1030, to: 5060 } });
    assert.equal(same.ok, true, 'within two bars either end is the same view');
    assert.deepEqual(same.failed, []);

    const displaced = compareAsFound(before, { ...before, time_range: { from: 1000 - 14 * 86400, to: 5000 - 14 * 86400 } });
    assert.equal(displaced.ok, false);
    assert.deepEqual(displaced.failed, ['visible_range']);

    const wrongLayout = compareAsFound(before, { ...before, layout: 'Forensics' });
    assert.deepEqual(wrongLayout.failed, ['layout']);

    // Nothing recorded means nothing to compare — said so, not passed by accident.
    const noRange = compareAsFound({ ...before, time_range: null }, before);
    assert.equal(noRange.ok, true);
    assert.equal(noRange.fields.find((f) => f.what === 'visible_range').compared, false);
  });
});

describe('preflight', () => {
  const alerts = [
    { alert_id: 1, type: 'price', active: true, condition: { series: [{ type: 'barset' }] } },
    {
      alert_id: 2, type: 'strategy', active: true, resolution: '45S',
      condition: { series: [{ type: 'study', pine_id: 'P', pine_version: '0.43', inputs: { __log_level: 0, in_0: true, in_1: 5 } }] },
    },
  ];

  it('extracts only positional inputs from a strategy alert', () => {
    const [a] = strategyAlertConfigs(alerts);
    assert.equal(a.alert_id, 2);
    assert.deepEqual(a.inputs, { in_0: true, in_1: 5 });
    assert.equal(a.pine_version, '0.43');
  });

  it('passes study/source/inputs and fails an active alert on its own frozen map', async () => {
    const manifestFile = {
      build: 'b14', title: 'B14', manifest: { in_0: true, in_1: 3 },
      derived_from: { source_file: 'src.pine', source_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    };
    const r = await preflight({
      buildTag: 'b14',
      _deps: {
        manifestFile,
        readFile: () => Buffer.from(''),
        requireSettled: async () => ({ ok: true }),
        listAlerts: async () => ({ alerts: alerts.map((a) => (a.alert_id === 2 ? { ...a, condition: { series: [{ ...a.condition.series[0], pine_version: '0.46' }] } } : a)) }),
        evaluate: pageStub([B14], () => ({
          ok: true, entity_id: 'xVbiv5', title: 'B14', pine_id: 'P', pine_version: '0.46',
          inputs: [{ id: 'in_0', value: true, name: 'a' }, { id: 'in_1', value: 3, name: 'b' }],
        })),
      },
    });
    const by = Object.fromEntries(r.checks.map((c) => [c.check, c]));
    assert.equal(by.study.pass, true);
    assert.equal(by.source.pass, true);
    assert.equal(by.inputs.pass, true);
    assert.equal(by.alerts.pass, false);
    assert.deepEqual(by.alerts.diverged_active, [2]);
    assert.equal(by.alerts.alerts[0].mismatches[0].id, 'in_1');
    assert.equal(r.pass, false);
    assert.deepEqual(r.failed, ['alerts']);
  });

  it('refuses a manifest that declares another build', async () => {
    const r = await preflight({ buildTag: 'b14', _deps: { manifestFile: { build: 'b15', title: 'B15', manifest: { in_0: 1 } } } });
    assert.equal(r.reason, 'invalid_argument');
  });
});
