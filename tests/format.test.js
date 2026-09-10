/**
 * Response envelope and response budget.
 *
 * No live chart: these are pure functions, and they are the layer every tool
 * answers through, so they are worth pinning.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CODES,
  applyBudget,
  classifyError,
  errorEnvelope,
  fromReaderFailure,
  fromThrown,
  jsonResult,
  MAX_RESPONSE_CHARS,
} from '../src/tools/_format.js';

const rows = (n, pad = 40) =>
  Array.from({ length: n }, (_, i) => ({ i, text: 'x'.repeat(pad), v: i * 3 }));

describe('error envelope', () => {
  it('carries ok, the mirrored success flag, a code and a retry verdict', () => {
    const e = errorEnvelope(ERROR_CODES.TIMED_OUT, 'too slow');
    assert.equal(e.ok, false);
    assert.equal(e.success, false);
    assert.equal(e.error.code, 'timed_out');
    assert.equal(e.error.message, 'too slow');
    assert.equal(e.error.retry, 'after_settle');
  });

  it('classifies a missing chart as unavailable, not internal', () => {
    assert.equal(
      classifyError(new Error('No visible TradingView chart context')),
      ERROR_CODES.UNAVAILABLE,
    );
    assert.equal(
      classifyError(new Error('CDP connection failed after 5 attempts')),
      ERROR_CODES.UNAVAILABLE,
    );
  });

  it('classifies an unrecognised message as internal rather than guessing', () => {
    assert.equal(classifyError(new Error('kaboom')), ERROR_CODES.INTERNAL);
  });

  it('preserves a reader failure\'s evidence alongside the code', () => {
    const e = fromReaderFailure({
      ok: false,
      reason: 'window_mismatch',
      error: 'wrong window',
      expected_from: 111,
      actual_from: 222,
    });
    assert.equal(e.error.code, 'window_mismatch');
    assert.equal(e.error.expected_from, 111);
    assert.equal(e.error.actual_from, 222);
    assert.equal(e.error.reason, 'window_mismatch');
  });

  it('maps an uncomputed report to not_found, which does not invite a retry', () => {
    const e = fromReaderFailure({ ok: false, reason: 'report_not_computed', error: 'no report' });
    assert.equal(e.error.code, ERROR_CODES.NOT_FOUND);
    assert.equal(e.error.retry, 'never');
  });

  it('flags isError from the envelope without being told', () => {
    assert.equal(jsonResult(fromThrown(new Error('boom'))).isError, true);
    assert.equal(jsonResult({ ok: true, a: 1 }).isError, undefined);
  });

  it('mirrors legacy success into ok so every tool answers the same question', () => {
    const parsed = JSON.parse(jsonResult({ success: true, data: 1 }).content[0].text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.success, true);
  });
});

describe('response budget', () => {
  it('leaves a payload inside the budget completely alone', () => {
    const payload = { rows: rows(3) };
    const { payload: out, report } = applyBudget(payload, 60000);
    assert.equal(report, null);
    assert.equal(out, payload);
  });

  it('trims to fit and reports the exact counts', () => {
    const payload = { rows: rows(5000) };
    const { payload: out, report } = applyBudget(payload, 20000);
    assert.equal(report.applied, true);
    assert.ok(JSON.stringify(out, null, 2).length <= 20000);
    const t = report.truncated.find((x) => x.path === 'rows');
    assert.equal(t.kept, out.rows.length);
    assert.equal(t.of, 5000);
    assert.equal(t.kept + t.dropped, 5000);
  });

  it('keeps the head of the series, not an arbitrary window', () => {
    const { payload: out } = applyBudget({ rows: rows(5000) }, 20000);
    assert.equal(out.rows[0].i, 0);
    assert.equal(out.rows[out.rows.length - 1].i, out.rows.length - 1);
  });

  it('trims two lists by the same factor instead of annihilating one', () => {
    const { payload: out } = applyBudget({ trades: rows(2000), orders: rows(2000) }, 30000);
    // Equal inputs, so equal survivors. An earlier implementation trimmed the
    // largest array first and left 1 of one list against 821 of the other.
    assert.equal(out.trades.length, out.orders.length);
    assert.ok(out.trades.length > 1);
  });

  it('stays under the limit once the report block is added', () => {
    const text = jsonResult({ rows: rows(20000) }, false).content[0].text;
    assert.ok(text.length <= MAX_RESPONSE_CHARS, `budget overshot: ${text.length}`);
    assert.equal(JSON.parse(text).response_budget.applied, true);
  });

  it('passes a full 105-trade book through untouched', () => {
    // The measured trade book is ~77k pretty-printed chars. The budget exists
    // to stop runaway responses, not to quietly halve the deliverable.
    const book = { trades: rows(105, 690) };
    assert.ok(JSON.stringify(book, null, 2).length > 70000, 'fixture too small to be the real test');
    assert.equal(applyBudget(book).report, null);
  });

  it('says so rather than cutting when there is no list to trim', () => {
    const { payload: out, report } = applyBudget({ source: 'y'.repeat(50000) }, 10000);
    assert.equal(report.applied, false);
    assert.equal(out.source.length, 50000, 'a long string must not be cut mid-token');
  });

  it('can be disabled outright', () => {
    assert.equal(applyBudget({ rows: rows(5000) }, 0).report, null);
  });
});
