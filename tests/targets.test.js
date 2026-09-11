/**
 * Target selection.
 *
 * The measured session had four chart contexts, two of them reporting
 * `visible` at full size on the same layout while holding different loaded
 * histories. These fixtures are those measurements.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasOsWindowChrome, selectTarget } from '../src/internals/targets.js';

const ctx = (id, o) => ({
  id,
  url: `https://www.tradingview.com/chart/${o.layout === 'Esemble' ? 'bzMBAknq' : 'R7HDoRZ2'}/`,
  identity: {
    has_api: true, visible: true, focused: false,
    viewport: [1920, 1044], outer: [1920, 1044], layout: 'Trial Ground',
    ...o,
  },
});

// The live session, as measured 2026-09-10.
const REAL = ctx('09EBFD9A', { focused: true, outer: [1920, 1080] });
const DUPLICATE = ctx('962BE3C0', { outer: [1920, 1044] });
const PREVIEW_A = ctx('67BD8A45', { visible: false, viewport: [500, 318], outer: [0, 0], layout: 'Esemble' });
const PREVIEW_B = ctx('8AF118B4', { visible: false, viewport: [500, 318], outer: [0, 0], layout: 'Esemble' });
const SESSION = [DUPLICATE, PREVIEW_A, REAL, PREVIEW_B]; // deliberately not in /json/list order

describe('OS window chrome', () => {
  it('separates the real window from a render surface', () => {
    assert.equal(hasOsWindowChrome(REAL.identity), true);
    assert.equal(hasOsWindowChrome(DUPLICATE.identity), false, 'outer == inner is not a window');
    assert.equal(hasOsWindowChrome(PREVIEW_A.identity), false, 'outer [0,0] is not a window');
  });

  it('still holds when the window is minimised', () => {
    // Measured through user32 ShowWindow(SW_MINIMIZE): visibilityState stayed
    // 'visible' and only the OS geometry moved.
    const minimised = { ...REAL.identity, outer: [199, 34], screen_xy: [-32000, -32000] };
    assert.equal(hasOsWindowChrome(minimised), true);
  });
});

describe('selectTarget', () => {
  it('picks the focused window over three look-alikes', () => {
    const { candidate, rule } = selectTarget(SESSION);
    assert.equal(candidate.id, '09EBFD9A');
    assert.equal(rule, 'focused');
  });

  it('falls through to OS chrome when TradingView is not the foreground app', () => {
    const unfocused = SESSION.map((c) => ({ ...c, identity: { ...c.identity, focused: false } }));
    const { candidate, rule } = selectTarget(unfocused);
    assert.equal(candidate.id, '09EBFD9A');
    assert.equal(rule, 'os_window');
  });

  it('resolves a minimised window rather than refusing it', () => {
    // C1's premise was that a minimised window would be refused. Measured, it
    // reports visible; and even if it did not, os_window still separates it.
    const min = SESSION.map((c) =>
      c.id === '09EBFD9A'
        ? { ...c, identity: { ...c.identity, focused: false, visible: false, outer: [199, 34] } }
        : { ...c, identity: { ...c.identity, focused: false } },
    );
    const { candidate, rule } = selectTarget(min);
    assert.equal(candidate.id, '09EBFD9A');
    assert.equal(rule, 'os_window');
  });

  it('refuses rather than guessing when two candidates are indistinguishable', () => {
    const twins = [
      { ...DUPLICATE, id: 'AAAA' },
      { ...DUPLICATE, id: 'BBBB' },
    ];
    const { candidate, tied, ruleName } = selectTarget(twins);
    assert.equal(candidate, null, 'a coin toss here has a wrong side');
    assert.equal(tied.length, 2);
    // The label is the WEAKEST rule that still tied, so the message reads
    // "not even viewport size separated these" rather than naming a strong
    // rule the candidates never reached.
    assert.equal(ruleName, 'largest_viewport');
  });

  it('uses the largest viewport only when nothing reports visible', () => {
    const dark = [
      ctx('SMALL', { visible: false, viewport: [500, 318], outer: [500, 318] }),
      ctx('BIG', { visible: false, viewport: [1920, 1044], outer: [1920, 1044] }),
    ];
    const { candidate, rule } = selectTarget(dark);
    assert.equal(candidate.id, 'BIG');
    assert.equal(rule, 'largest_viewport');
  });

  it('narrows to a named layout before ranking', () => {
    const { candidate, rule } = selectTarget(SESSION, 'Esemble');
    assert.equal(rule, null, 'two identical previews must not be separated');
    assert.equal(candidate, null);
    const one = selectTarget([PREVIEW_A, REAL, DUPLICATE], 'Esemble');
    assert.equal(one.candidate.id, '67BD8A45');
    assert.equal(one.rule, 'only_candidate');
  });

  it('ignores contexts with no TradingViewApi', () => {
    const withDead = [{ ...DUPLICATE, id: 'DEAD', identity: { ...DUPLICATE.identity, has_api: false } }, REAL];
    const { candidate } = selectTarget(withDead);
    assert.equal(candidate.id, '09EBFD9A');
  });
});
