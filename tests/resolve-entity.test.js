/**
 * Entity resolution refuses on ambiguity.
 *
 * Driven through a stubbed page evaluator rather than a live chart, because
 * the case that matters cannot be staged on the working chart: build 14 is
 * titled "B14" and build 15 will be "B15", both can be loaded at once, and a
 * prefix matches both. The live chart carries one study, so it can only ever
 * demonstrate the easy path.
 *
 * Returning the first match here would attach every downstream read, assert
 * and backtest to whichever study came first out of `dataSources()`, with
 * nothing on the result to say it had happened.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntity } from '../src/core/pine-inputs.js';

const chartWith = (studies) => ({
  evaluate: async () => ({ ok: true, symbol: 'ICMARKETS:XAUUSD', resolution: '45S', studies }),
});

const B14 = { entity_id: 'xVbiv5', title: 'B14', is_strategy: true, report_present: true };
const B15 = { entity_id: 'zQq001', title: 'B15', is_strategy: true, report_present: true };

describe('resolveEntity', () => {
  it('resolves the only strategy, and says how', async () => {
    const r = await resolveEntity({ _deps: chartWith([B14]) });
    assert.equal(r.ok, true);
    assert.equal(r.resolved.entity_id, 'xVbiv5');
    assert.equal(r.resolved.build, 'b14');
    assert.equal(r.matched_by, 'only_strategy_with_report');
  });

  it('REFUSES when a prefix matches two builds', async () => {
    const r = await resolveEntity({ hint: 'B1', _deps: chartWith([B14, B15]) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ambiguous');
    assert.equal(r.candidates.length, 2);
    assert.match(r.error, /B14 \(xVbiv5\), B15 \(zQq001\)/, 'the refusal has to name what it could not choose between');
    assert.match(r.error, /Refusing rather than picking one/);
  });

  it('REFUSES with no hint when both builds carry a report', async () => {
    // The dangerous case: nobody asked for a study at all, both are loaded,
    // and "the strategy on the chart" is not a well-formed request.
    const r = await resolveEntity({ _deps: chartWith([B14, B15]) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ambiguous');
  });

  it('an exact title beats a substring, so ambiguity is escapable', async () => {
    // Without this tier a chart carrying B14 and "B14 copy" would be
    // permanently unresolvable by name.
    const COPY = { entity_id: 'copy01', title: 'B14 copy', is_strategy: true, report_present: true };
    const r = await resolveEntity({ hint: 'B14', _deps: chartWith([B14, COPY]) });
    assert.equal(r.ok, true);
    assert.equal(r.matched_by, 'exact_title');
    assert.equal(r.resolved.entity_id, 'xVbiv5');
  });

  it('an entity id beats everything', async () => {
    const r = await resolveEntity({ hint: 'zQq001', _deps: chartWith([B14, B15]) });
    assert.equal(r.ok, true);
    assert.equal(r.matched_by, 'entity_id');
    assert.equal(r.resolved.title, 'B15');
  });

  it('says not_found rather than resolving something else', async () => {
    const r = await resolveEntity({ hint: 'B99', _deps: chartWith([B14, B15]) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_found');
  });
});
