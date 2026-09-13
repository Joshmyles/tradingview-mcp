/**
 * The three broker refutations of Phase 0.6, pinned.
 *
 * Each has a wrong-looking-correct alternative, and each test asserts BOTH the
 * helper's answer and the recorded API behaviour that makes the naive reading
 * wrong. If TradingView changes the behaviour, the live counterpart
 * (tests/live/replay-broker-surfaces.test.js) is where that becomes visible;
 * these keep the helpers honest against what was actually measured.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brokerReadJs, fillsFor, isFlat, markToMarket, openQty } from '../src/internals/replay-broker.js';

const REC = JSON.parse(readFileSync(new URL('./fixtures/phase06-broker-readings.json', import.meta.url), 'utf8'));

describe('refutation 1: executions({symbol}) is empty after a fill; allExecutions() is the fill surface', () => {
  it('recorded: the filtered call was [] while a position was open, and after the close', () => {
    assert.equal(REC.after_fill.positions[0].qty, 1, 'fixture must describe a filled position');
    assert.deepEqual(REC.after_fill.executions_symbol_filtered, []);
    assert.deepEqual(REC.after_close.executions_symbol_filtered, []);
  });

  it('recorded: allExecutions() carried both legs', () => {
    assert.equal(REC.after_fill.all_executions.length, 2);
  });

  it('fillsFor() filters the unfiltered list client-side and finds the fills', () => {
    const fills = fillsFor(REC.after_fill.all_executions, { symbol: REC.symbol });
    assert.equal(fills.length, 2);
    assert.deepEqual(fills.map((f) => f.side), [1, -1]);
    assert.equal(fillsFor(REC.after_fill.all_executions, { symbol: 'OTHER:SYM' }).length, 0);
  });

  it('fillsFor() refuses a non-array rather than reporting no fills', () => {
    assert.throws(() => fillsFor(null), /allExecutions/);
    assert.throws(() => fillsFor({ __error: 'x' }), /allExecutions/);
  });

  it('the page read names the filtered call as a pinned refutation, not a source', () => {
    const js = brokerReadJs(REC.symbol);
    assert.match(js, /all_executions = await safe\(function \(\) \{ return ab\.allExecutions\(\); \}\)/);
    assert.match(js, /executions_symbol_filtered/);
    assert.match(js, /Do not consume/);
  });
});

describe('refutation 2: getEquity() tracks realised P&L and commission only', () => {
  const open = REC.equity_samples.filter((s) => s.label.startsWith('after_step') || s.label === 'after_fill');

  it('recorded: equity did not move while unrealised P&L ran -2.51 -> -3.59 -> -1.00', () => {
    const equities = new Set(open.map((s) => s.equity));
    const unrealised = new Set(open.map((s) => s.unrealized_pl));
    assert.equal(equities.size, 1, 'equity must be constant across the open-position samples');
    assert.ok(unrealised.size >= 3, 'unrealised P&L must have moved across the same samples');
  });

  it('recorded: equity moved only on commission (entry) and on the close', () => {
    const [before, fill] = REC.equity_samples;
    const close = REC.equity_samples.at(-1);
    assert.equal(+(before.equity - fill.equity).toFixed(2), 0.11);
    assert.equal(+(fill.equity - close.equity).toFixed(2), 1.11); // 1.00 loss + 0.11 exit commission
  });

  it('markToMarket() adds open unrealised P&L to realised equity', () => {
    const s = REC.equity_samples.find((x) => x.label === 'after_step_2');
    const r = markToMarket({
      realisedEquity: s.equity,
      positions: [{ ...REC.after_fill.positions[0], unrealizedPl: s.unrealized_pl }],
    });
    assert.equal(r.realised_equity, 99999.89);
    assert.equal(+r.mark_to_market.toFixed(2), 99996.3);
    assert.notEqual(r.mark_to_market, s.equity, 'an open loss must show in mark-to-market and not in realised equity');
  });

  it('markToMarket() refuses to value an open position with no unrealised figure at zero', () => {
    const { unrealizedPl, ...noPl } = REC.after_fill.positions[0];
    assert.throws(() => markToMarket({ realisedEquity: 100000, positions: [noPl] }), /Refusing to value it at zero/);
  });

  it('markToMarket() ignores a zero row even though it carries a side', () => {
    const r = markToMarket({ realisedEquity: 99998.78, positions: REC.after_close.positions });
    assert.equal(r.mark_to_market, 99998.78);
  });
});

describe('refutation 3: a closed position keeps a qty-0 row with the side flipped', () => {
  const rows = REC.after_close.positions;

  it('recorded: the row survives the close, qty 0, avgPrice null, side flipped', () => {
    assert.equal(rows.length, 1, 'the naive positions().length === 0 check is false on a flat account');
    assert.equal(rows[0].qty, 0);
    assert.equal(rows[0].avgPrice, null);
    assert.equal(REC.after_fill.positions[0].side, 1);
    assert.equal(rows[0].side, -1, 'side flipped on close');
    assert.equal(rows[0].id, REC.after_fill.positions[0].id, 'same row, not a new one');
  });

  it('isFlat() is true for the qty-0 row and false for the open one', () => {
    assert.equal(isFlat(rows), true);
    assert.equal(isFlat(REC.after_fill.positions), false);
    assert.equal(isFlat([]), true);
  });

  it('openQty() is 0 for the flipped zero row, whatever its side', () => {
    assert.equal(openQty(rows), 0);
    assert.equal(openQty(REC.after_fill.positions), 1);
  });

  it('isFlat() refuses an unreadable list rather than calling it flat', () => {
    assert.throws(() => isFlat(null), /Refusing/);
    assert.throws(() => isFlat({ __error: 'timeout' }), /Refusing/);
  });
});

describe('P1: the order id does not exist before placeOrder resolves', () => {
  it('recorded: placeOrder returned a promise resolving { orderId, result } with no label', () => {
    assert.equal(REC.place_order_returned_synchronously, false);
    assert.deepEqual(Object.keys(REC.place_order_resolved).sort(), ['orderId', 'result']);
    assert.match(REC.place_order_resolved.orderId, /^order_[0-9a-f-]{36}$/);
  });
});
