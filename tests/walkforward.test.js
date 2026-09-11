/**
 * Walk-forward independence, and the wrong-study fence check.
 *
 * Pure, so no live chart. Both pinned because both failures are silent and
 * both produce a result that looks complete and correct.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { independence } from '../src/core/backtest.js';
import { checkFence } from '../src/settle.js';

const row = (from, to, net, requested = null) => ({
  ok: true,
  requested: requested || { from, to },
  window: { backtest_from: from, backtest_to: to },
  trades: 10,
  performance: { net_profit: net },
});

const DAY = 86400000;

describe('independence', () => {
  it('treats genuinely disjoint windows as what they are', () => {
    const r = independence([row(0, DAY, 10), row(2 * DAY, 3 * DAY, 20)]);
    assert.equal(r.distinct.length, 2);
    assert.equal(r.summary.windows_distinct, 2);
    assert.equal(r.summary.windows_duplicated, 0);
    assert.equal(r.summary.independence_warning, undefined);
  });

  it('drops a window that snapped onto one already covered', () => {
    // Measured hazard: TradingView snaps a requested range to available data,
    // and two DIFFERENT requests snapped to the SAME window. Pooling both
    // counts one observation twice — it inflates the sample and shrinks the
    // apparent variance, and every row still looks like a complete result.
    const r = independence([
      row(100, 200, 10, { from: 90, to: 210 }),
      row(100, 200, 10, { from: 95, to: 205 }),
      row(300, 400, 30),
    ]);
    assert.equal(r.distinct.length, 2, 'the repeat is not a second observation');
    assert.equal(r.summary.windows_duplicated, 1);
    assert.deepEqual(r.summary.duplicate_windows[0].rows, [0, 1]);
    assert.deepEqual(
      r.summary.duplicate_windows[0].requested,
      [{ from: 90, to: 210 }, { from: 95, to: 205 }],
      'the two distinct requests are kept, so the collision is diagnosable',
    );
    assert.match(r.summary.independence_warning, /one observation, not two/);
  });

  it('flags overlapping windows without silently dropping them', () => {
    // Partial overlap is a matter of degree, so it is the caller's judgement —
    // but it must not be presented as a clean sample of two.
    const r = independence([row(0, 2 * DAY, 10), row(DAY, 3 * DAY, 20)]);
    assert.equal(r.distinct.length, 2, 'still pooled');
    assert.deepEqual(r.summary.overlapping_windows[0].rows, [0, 1]);
    assert.equal(r.summary.overlapping_windows[0].overlap_ms, DAY);
    assert.match(r.summary.independence_warning, /not independent/);
  });

  it('does not call abutting windows an overlap', () => {
    // Back-to-back weeks share an endpoint and nothing else.
    const r = independence([row(0, DAY, 10), row(DAY, 2 * DAY, 20)]);
    assert.equal(r.summary.overlapping_windows, undefined);
  });
});

describe('checkFence — wrong study', () => {
  const base = { target_id: 'T', symbol: 'ICMARKETS:XAUUSD', resolution: '45S' };

  it('refuses a read of a study the fence was not taken on', () => {
    // With two builds loaded, every other check passes: the per-strategy
    // checks are keyed by the OBSERVED entity id, so an unfenced study simply
    // has no prior to compare against and the read arrives clean.
    const v = checkFence(
      { ...base, entity_id: 'xVbiv5', strategies: {}, target: { target_id: 'T' } },
      { ...base, entity_id: 'OTHER9', inputs_hash: 'abc' },
    );
    assert.equal(v.code, 'wrong_study');
    assert.equal(v.fence_entity, 'xVbiv5');
    assert.equal(v.observed_entity, 'OTHER9');
  });

  it('passes the study it was taken on', () => {
    const v = checkFence(
      { ...base, entity_id: 'xVbiv5', strategies: {}, target: { target_id: 'T' } },
      { ...base, entity_id: 'xVbiv5', inputs_hash: 'abc' },
    );
    assert.equal(v, null);
  });

  it('stays quiet when the fence never named a study', () => {
    // A fence taken without resolving one must not start failing reads.
    const v = checkFence(
      { ...base, strategies: {}, target: { target_id: 'T' } },
      { ...base, entity_id: 'anything', inputs_hash: 'abc' },
    );
    assert.equal(v, null);
  });
});
