/**
 * Smoke suite — the barrier and the readers, against a live chart.
 *
 * DESTRUCTIVE. It changes the resolution to prove the gate catches a
 * recompute, so it runs only against the fixture layout and only with
 * TV_MCP_ALLOW_DESTRUCTIVE=1. See tests/fixtures/README.md.
 *
 * What it is for: the unit suites cannot tell whether the internals still
 * point at anything real. This can, and it is the thing to run after a
 * TradingView update.
 *
 * Run: TV_MCP_ALLOW_DESTRUCTIVE=1 node --test tests/smoke.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requireFixtureLayout } from './_fixture-guard.js';
import { FIXTURE } from './fixtures/fixture.config.js';
import { disconnect, getTargetIdentity } from '../src/connection.js';
import { awaitSettled, captureFence, checkFence, requireSettled, SETTLE } from '../src/settle.js';
import { readStrategyReport } from '../src/strategy-report.js';
import { setTimeframe } from '../src/core/chart.js';

let startedAt = null;

describe('smoke — live chart', () => {
  before(async () => {
    const identity = await requireFixtureLayout();
    startedAt = identity.resolution;
    console.log(`fixture: ${identity.layout} ${identity.symbol} ${identity.resolution}`);
  });

  after(async () => {
    // Put the fixture back where it was found. A suite that leaves the chart
    // somewhere else makes the next run's starting state a matter of history.
    try {
      if (startedAt) await setTimeframe({ timeframe: startedAt });
    } catch {
      /* reported by the run that follows */
    }
    await disconnect();
  });

  it('attaches to the visible chart, not a preview renderer', async () => {
    await awaitSettled({ scope: 'all', timeoutMs: 30000 });
    const id = getTargetIdentity();
    assert.equal(id.visible, true, 'attached to a hidden context');
    assert.equal(id.symbol, FIXTURE.symbol);
  });

  it('settles a quiet chart quickly', async () => {
    const r = await awaitSettled({ scope: 'all', timeoutMs: 30000 });
    assert.equal(r.outcome, SETTLE.SETTLED, r.error);
  });

  it('reads a strategy report that reconciles', async () => {
    const r = await readStrategyReport({ timeoutMs: 60000 });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.trades.length > 0, 'fixture strategy produced no trades');
    assert.equal(r.reconciliation.rows_explained, true);
    assert.ok(
      r.reconciliation.pnl_identity.max_abs_error < 1e-6,
      `P&L identity broke: ${r.reconciliation.pnl_identity.max_abs_error}`,
    );
  });

  it('rejects a report whose window is not the one asked for', async () => {
    const r = await readStrategyReport({ expectWindow: { from: 1 }, timeoutMs: 60000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'window_mismatch');
  });

  it('refuses a read fenced to a different page context', async () => {
    const fence = await captureFence();
    const violation = checkFence(
      { ...fence, target: { ...fence.target, target_id: 'NOT-THIS-ONE' } },
      { target_id: getTargetIdentity()?.target_id, entity_id: 'x' },
    );
    assert.equal(violation.code, 'target_changed');
  });

  it('proves a series rebuild across a resolution change', async () => {
    const other = startedAt === '5' ? '15' : '5';
    const m = await setTimeframe({ timeframe: other });
    assert.equal(m.applied, true);
    assert.equal(m.settled, false, 'a mutation must not claim readiness');
    assert.equal(m.chart_ready, undefined, 'chart_ready was removed; it was a lie');

    const gated = await requireSettled({
      scope: 'all',
      requireSeries: true,
      fence: m.fence,
      timeoutMs: 90000,
    });
    assert.equal(gated.ok, true, gated.error);
    assert.equal(gated.settle.series_evidence, 'proven');
    assert.ok(gated.settle.series.events.completed > (m.fence.report.events?.completed ?? 0));
  });
});
