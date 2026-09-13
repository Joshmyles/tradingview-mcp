/**
 * The silent-success guard.
 *
 * THE RULE, which Phase 0.6 Task 3 exists to enforce:
 *
 *     A tool may report success only if it has observed the state change it
 *     claims to have caused.
 *
 * Three violations were found by accident rather than by looking — `replay_trade`
 * returning success on a null broker model, `pine_inputs_assert` letting a spread
 * overwrite its own verdict, and `replay_step` reporting success at a cursor that
 * never moved. Three incidental finds implies more, so this test makes the
 * inventory a thing that has to be maintained: every `success: true` in
 * src/core/*.js must have an entry in tests/fixtures/silent-success-audit.json
 * saying which category it falls in and WHY that is defensible.
 *
 * The point is friction in the right direction. Adding a read-back is less work
 * than writing a justification, so the cheap path is the correct one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE_DIR = join(ROOT, 'src', 'core');
const AUDIT = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'silent-success-audit.json'), 'utf8'));

const VALID_CLASSIFICATIONS = Object.keys(AUDIT._classifications);

/**
 * Every `success: true` site in src/core, keyed "file::enclosingFunction".
 *
 * Comment lines are skipped: several of the fixed defects left a note behind
 * saying "this used to return success: true", and a scanner that counted those
 * would report the fix as the defect.
 */
function scanSites() {
  const sites = new Map();
  for (const file of readdirSync(CORE_DIR).filter((f) => f.endsWith('.js'))) {
    const lines = readFileSync(join(CORE_DIR, file), 'utf8').split('\n');
    let fn = '(module)';
    lines.forEach((raw, i) => {
      const line = raw.trim();
      const m = /^export (?:async )?function (\w+)/.exec(raw);
      if (m) fn = m[1];
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
      if (!/\bsuccess:\s*true\b/.test(line)) return;
      const key = `${file}::${fn}`;
      if (!sites.has(key)) sites.set(key, []);
      sites.get(key).push(i + 1);
    });
  }
  return sites;
}

describe('silent-success audit', () => {
  const sites = scanSites();

  it('finds success sites to audit at all (guards against a vacuous pass)', () => {
    // If the scanner silently matched nothing — a refactor, a renamed directory —
    // every assertion below would pass while checking nothing. That is the same
    // failure mode the audit is about, so it is checked first.
    assert.ok(sites.size > 20, `expected many success sites, scanner found ${sites.size}`);
  });

  it('every success:true site has a recorded justification', () => {
    const undocumented = [...sites.keys()].filter((k) => !AUDIT.sites[k]);
    assert.deepEqual(
      undocumented,
      [],
      'These return success:true with no entry in tests/fixtures/silent-success-audit.json.\n'
      + 'Either read back the change you claim to have caused (preferred), or add an\n'
      + 'entry saying why success is defensible without one:\n  '
      + undocumented.map((u) => `${u} (lines ${sites.get(u).join(', ')})`).join('\n  '),
    );
  });

  it('no justification is a placeholder', () => {
    for (const [key, entry] of Object.entries(AUDIT.sites)) {
      assert.ok(
        VALID_CLASSIFICATIONS.includes(entry.classification),
        `${key}: classification "${entry.classification}" is not one of ${VALID_CLASSIFICATIONS.join(', ')}`,
      );
      assert.ok(
        typeof entry.why === 'string' && entry.why.trim().length >= 40,
        `${key}: "why" must actually say something (got ${JSON.stringify(entry.why)})`,
      );
    }
  });

  it('the inventory carries no stale entries', () => {
    // A stale entry is a justification for code that no longer exists, which
    // makes the inventory unreadable as a statement about the current tools.
    const stale = Object.keys(AUDIT.sites).filter((k) => !sites.has(k));
    assert.deepEqual(stale, [], `these audit entries no longer match any code site: ${stale.join(', ')}`);
  });

  it('the mutations fixed in Phase 0.6 do not reappear as bare successes', () => {
    // Named explicitly, because these are the ones that were measured wrong.
    // If any of them returns a bare success:true again, it is a regression, and
    // adding an audit entry for it should not be enough to make this pass.
    const mustNotBeBare = [
      'chart.js::setType',
      'chart.js::manageIndicator',
      'chart.js::scrollToDate',
      'chart.js::setVisibleRange',
      'indicators.js::setInputs',
      'indicators.js::toggleVisibility',
      'drawing.js::drawShape',
      'drawing.js::removeOne',
      'drawing.js::clearAll',
      'pane.js::setLayout',
      'pane.js::focus',
      'pane.js::setSymbol',
      'pine.js::setSource',
      'pine.js::newScript',
      'pine.js::compile',
      'pine.js::save',
      'pine.js::smartCompile',
      'ui.js::click',
      'ui.js::openPanel',
      'ui.js::fullscreen',
      'ui.js::keyboard',
      'ui.js::typeText',
      'ui.js::hover',
      'ui.js::scroll',
      'ui.js::mouseClick',
      'watchlist.js::remove',
    ];
    const regressed = mustNotBeBare.filter((k) => sites.has(k));
    assert.deepEqual(
      regressed,
      [],
      'These were fixed in Phase 0.6 to report an observation (or to declare the\n'
      + 'effect unobservable) and are constructing a bare success:true again:\n  '
      + regressed.join('\n  '),
    );
  });
});

describe('verdict construction', () => {
  it('a later spread cannot overwrite the verdict', async () => {
    // This is the pine_inputs_assert shape: a detail object carrying its own
    // `success`/`reason`. It must throw rather than silently win.
    const { observed, refused, unobservable } = await import('../src/internals/verdict.js');
    assert.throws(() => observed({ seen: 1 }, { success: false }), /may not carry/);
    assert.throws(() => observed({ seen: 1 }, { reason: 'nope' }), /may not carry/);
    assert.throws(() => refused('no', { success: true }), /may not carry/);
    assert.throws(() => unobservable('why', { observed: true }), /may not carry/);
  });

  it('the verdict survives being spread into another object', () => {
    // Frozen is not enough on its own — callers legitimately re-wrap results —
    // so what matters is that `success` is written last and carries the answer.
    return import('../src/internals/verdict.js').then(({ refused }) => {
      const r = refused('the cursor did not move', { current_date: 7 });
      assert.equal(r.success, false);
      assert.equal({ ...r }.success, false);
      assert.equal(r.current_date, 7);
    });
  });

  it('success cannot be claimed with no evidence', async () => {
    const { observed } = await import('../src/internals/verdict.js');
    assert.throws(() => observed({}), /requires non-empty evidence/);
    assert.throws(() => observed(null), /requires non-empty evidence/);
  });

  it('unobservable must say why', async () => {
    const { unobservable } = await import('../src/internals/verdict.js');
    assert.throws(() => unobservable(''), /requires a reason/);
    const r = unobservable('CDP dispatches the key; the page is not read back');
    assert.equal(r.success, true);
    assert.equal(r.observed, false);
    assert.match(r.observation, /not read back/);
  });
});
