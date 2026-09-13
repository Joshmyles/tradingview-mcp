/**
 * LIVE pin of refutation 1: executions({symbol}) stays empty after fills while
 * allExecutions() carries them. The unit test pins what was measured; this is
 * where the day TradingView changes it becomes visible.
 *
 * Needs a replay session with at least one fill already in it. It never places
 * one: with no fills it SKIPS and says so, because an empty session proves
 * nothing either way and a pass there would be vacuous.
 *
 *   node --test tests/live/replay-broker-surfaces.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, disconnect } from '../../src/connection.js';
import { brokerReadJs, fillsFor } from '../../src/internals/replay-broker.js';

const SYMBOL = process.env.TVMCP_BROKER_SYMBOL || 'ICMARKETS:XAUUSD';

describe('replay broker surfaces (live)', () => {
  it('executions({symbol}) is empty while allExecutions() holds the fills', async (t) => {
    let read;
    try {
      read = JSON.parse(await evaluate(brokerReadJs(SYMBOL), { awaitPromise: true }));
    } finally {
      await disconnect();
    }
    if (!read.broker_present) return t.skip('no active broker in this session');
    if (!Array.isArray(read.all_executions)) return t.skip(`allExecutions() unreadable: ${JSON.stringify(read.all_executions)}`);
    const fills = fillsFor(read.all_executions, { symbol: SYMBOL });
    if (fills.length === 0) return t.skip(`no fills for ${SYMBOL} in this session; the refutation needs at least one`);

    assert.ok(Array.isArray(read.executions_symbol_filtered), 'filtered executions() must be readable to compare');
    assert.deepEqual(
      read.executions_symbol_filtered,
      [],
      `executions({symbol}) now returns ${read.executions_symbol_filtered.length} row(s) with ${fills.length} fill(s) in `
      + 'allExecutions(). The refutation no longer holds: re-measure before relying on either surface.',
    );
  });
});
