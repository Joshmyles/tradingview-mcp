/**
 * verdict.js is the only path to a result's ok / success.
 *
 * Two halves:
 *   1. the lint rule (eslint.config.mjs VERDICT_ONLY_PATH) finds ZERO violations
 *      under src/ — so this runs in `npm test`, not only when someone remembers
 *      `npm run lint`;
 *   2. the rule and the helpers behave on the shapes that ACTUALLY occurred:
 *      a detail carrying ok/success, a merge of another result, and a spread
 *      after the verdict.
 *
 * If eslint is not installed this file fails on import. That is intended: a
 * guard that silently skips when its tool is missing is the failure it guards.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import { VERDICT_ONLY_PATH } from '../eslint.config.mjs';
import {
  adopt, answered, failed, isVerdict, observed, refused, unobservable, withDetail,
} from '../src/internals/verdict.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('the rule holds across src/', () => {
  it('no object literal or assignment outside verdict.js writes ok / success', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const results = await eslint.lintFiles(['src/**/*.js']);
    const hits = results.flatMap((r) => r.messages
      .filter((m) => m.ruleId === 'no-restricted-syntax')
      .map((m) => `${r.filePath.slice(ROOT.length)}:${m.line}:${m.column}`));
    assert.ok(results.length > 50, `expected to lint the whole of src/, linted ${results.length} files`);
    assert.deepEqual(hits, [], `verdict keys written outside src/internals/verdict.js:\n  ${hits.join('\n  ')}`);
  });
});

describe('the rule flags the shapes that occurred', () => {
  const linter = new Linter({ configType: 'flat' });
  const config = [{ ...VERDICT_ONLY_PATH, files: ['**/*.js'], ignores: [], languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } }];
  const flagged = (code) => linter.verify(code, config, 'src/core/example.js').filter((m) => m.ruleId === 'no-restricted-syntax').length;

  it('pine_inputs_assert: { ok, ...cmp, reason } — a verdict spread-overwritten by a merged result', () => {
    assert.ok(flagged('const ok = a && b; export const r = { ok, ...cmp, reason: "script_drift" };') >= 1);
  });

  it('a spread AFTER a literal verdict key', () => {
    assert.ok(flagged('export const r = { success: true, ...detail };') >= 1);
  });

  it('quoted, computed and assigned forms', () => {
    assert.ok(flagged('export const r = { "ok": false };') >= 1);
    assert.ok(flagged('export const r = { ["success"]: true };') >= 1);
    assert.ok(flagged('const r = {}; r.success = true;') >= 1);
    assert.ok(flagged('const r = {}; r["ok"] = true;') >= 1);
  });

  it('does not flag reads, destructuring or page-context strings', () => {
    assert.equal(flagged('const { ok } = r; if (r.ok && r.success) {}'), 0);
    assert.equal(flagged('const js = "return { ok: true, success: true }";'), 0);
  });
});

describe('helper behaviour on the shapes that occurred', () => {
  it('a detail carrying ok or success throws, for every helper', () => {
    for (const make of [
      (d) => observed({ seen: 1 }, d), (d) => refused('no', d), (d) => unobservable('why', d),
      (d) => answered(d), (d) => failed('not_found', d),
    ]) {
      assert.throws(() => make({ ok: true }), /may not carry "ok"/);
      assert.throws(() => make({ success: false }), /may not carry "success"/);
    }
  });

  it('merging another result in as detail throws: the pine_inputs_assert case', () => {
    const cmp = answered({ matched: 334 }); // "the inputs matched"
    assert.throws(() => refused('script_drift', { ...cmp }), /may not carry "ok", "success"/);
  });

  it('withDetail refuses an ordinary-key collision: the replay_health case', () => {
    const classification = answered({ state: 'healthy', armed: true });
    assert.throws(() => withDetail(classification, { state: { raw: 'reading' } }), /"state" already present/);
    const r = withDetail(classification, { reading: { raw: 'reading' } });
    assert.equal(r.state, 'healthy');
    assert.equal(r.success, true);
  });

  it('withDetail refuses reserved keys and non-verdicts', () => {
    assert.throws(() => withDetail(refused('no'), { success: true }), /may not carry/);
    assert.throws(() => withDetail({ ...refused('no') }, { x: 1 }), /takes a verdict/);
  });

  it('a verdict is frozen: assignment after issue throws in module code', () => {
    const r = refused('the cursor did not move');
    assert.throws(() => { r.success = true; }, TypeError);
    assert.throws(() => { r.ok = true; }, TypeError);
  });

  it('LIMIT, pinned so it is not forgotten: a hand-written spread copy can still override, and loses the brand', () => {
    const r = refused('the cursor did not move', { state: 'stalled' });
    const copy = { ...r, state: 'healthy' };
    assert.equal(copy.state, 'healthy', 'freezing does not stop a copy — the lint rule and withDetail() are the guards');
    assert.equal(isVerdict(r), true);
    assert.equal(isVerdict(copy), false, 'a consumer that needs the guarantee can tell the copy apart');
  });

  it('adopt() refuses an object whose ok and success disagree', () => {
    assert.throws(() => adopt({ ok: true, success: false, error: 'x' }), /disagrees with itself/);
  });

  it('adopt() refuses an object with no verdict rather than inventing one', () => {
    assert.throws(() => adopt({ rows: [] }), /carries no ok\/success/);
  });

  it('adopt() keeps a page failure failing, with its reason', () => {
    const v = adopt({ ok: false, reason: 'replay_not_started', error: 'Replay is not started.' });
    assert.equal(isVerdict(v), true);
    assert.equal(v.success, false);
    assert.equal(v.reason, 'replay_not_started');
    assert.equal(v.error, 'Replay is not started.');
    assert.equal(adopt({ success: false }).reason, 'failed');
  });

  it('adopt() preserves observed / unobservable semantics and returns verdicts unchanged', () => {
    assert.equal(adopt({ ok: true, observed: true, evidence: { a: 1 } }).observed, true);
    assert.match(adopt({ success: true, observed: false, observation: 'dispatch only' }).observation, /dispatch/);
    const v = refused('no');
    assert.equal(adopt(v), v);
  });

  it('ok mirrors success on every helper', () => {
    for (const v of [observed({ a: 1 }), refused('no'), unobservable('why'), answered(), failed('x')]) {
      assert.equal(v.ok, v.success);
    }
  });
});
