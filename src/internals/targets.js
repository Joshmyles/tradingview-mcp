/**
 * CDP target identity and selection.
 *
 * INTERNAL — see paths.js. Re-verify after every TradingView update.
 *
 * TradingView Desktop runs MORE THAN ONE page context per chart layout, and
 * more than one of them can look like the chart at the same time. Measured
 * 2026-09-10 on a two-layout session, `/json/list` reported four chart pages:
 *
 *   id        layout        vis      inner      outer      screenXY      focus
 *   09EBFD9A  Trial Ground  visible  1920x1044  1920x1080  [-1920, 0]    true
 *   962BE3C0  Trial Ground  visible  1920x1044  1920x1044  [0, 0]        false
 *   67BD8A45  Esemble       hidden    500x318      0x0     [0, 0]        false
 *   8AF118B4  Esemble       hidden    500x318      0x0     [0, 0]        false
 *
 * None of the three extras are stubs. Each has a complete
 * `window.TradingViewApi`, its own chart model, its own symbol and resolution,
 * and — for the same-layout duplicate — the same study ids. Every path in
 * paths.js resolves on them and returns plausible, wrong answers.
 *
 * They are not the same chart either. Sampled simultaneously, the two
 * Trial Ground contexts held DIFFERENT loaded histories: 329 bars over index
 * [-16, 312] against 381 bars over [0, 380], with different visible ranges.
 * On a 45S chart the backtest window follows the loaded bar count, so two
 * contexts that agree on the report today can disagree after any recompute.
 * Attaching to the wrong one is a correctness hazard, not an inconvenience.
 *
 * `visibilityState` DOES NOT SEPARATE THEM. Measured, and this corrects an
 * earlier reading in this file:
 *
 *   - The same-layout duplicate reports `visible`. It reported `hidden` at
 *     500x318 an hour earlier — it is re-used as the layout preview renderer
 *     and returns to full size afterwards, so its visibility and viewport
 *     both change under you while nobody touches the chart.
 *   - Minimising the real window does NOT make it hidden. Driven through
 *     user32 ShowWindow(SW_MINIMIZE), `09EBFD9A` still reported
 *     `visibilityState: 'visible'` throughout; only its OS geometry moved, to
 *     outer [199, 34] at [-32000, -32000]. Electron keeps the compositor
 *     alive, so the feared failure mode — every read refused against a
 *     minimised TradingView — does not occur on this build.
 *
 * Two signals do separate them, and both were stable across a minimise cycle
 * and a foreground cycle:
 *
 *   1. `document.hasFocus()` is true for the real window and false for every
 *      other context, whenever TradingView is the foreground application.
 *      Definitive when true; false for all when the user is in another app.
 *   2. The real window has OS window chrome: non-zero `outerWidth`/
 *      `outerHeight` that DIFFER from the inner viewport (36px of title bar
 *      here). The duplicate's outer size is permanently equal to its inner
 *      size, and the preview renderers report outer [0, 0]. The real window
 *      keeps this property even while minimised.
 *
 * Neither is sufficient alone — (1) needs TradingView in the foreground, and
 * (2) would fail for a true-fullscreen window — so selection tries them in
 * order and NAMES the rule that decided. When no rule produces a unique
 * winner, selection refuses instead of guessing.
 */

/**
 * Identity of the page context this expression is evaluated in.
 *
 * Everything here is evidence. The selection rules read it; a caller that
 * rejects a target can report what it rejected.
 */
export const TARGET_IDENTITY_JS = `
  (function() {
    var o = {
      href: location.href,
      visible: document.visibilityState === 'visible',
      focused: document.hasFocus(),
      viewport: [window.innerWidth, window.innerHeight],
      outer: [window.outerWidth, window.outerHeight],
      screen_xy: [window.screenX, window.screenY],
      ready: document.readyState,
      has_api: !!(window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV)
    };
    try {
      o.layout = window.TradingViewApi.layoutName();
    } catch (e) {
      o.layout = null;
    }
    try {
      var cw = window.TradingViewApi._activeChartWidgetWV.value();
      o.symbol = cw.symbol();
      o.resolution = cw.resolution();
    } catch (e) {
      o.symbol = null;
      o.resolution = null;
    }
    return o;
  })()`;

/**
 * Does this context sit in a real OS window?
 *
 * The real window reports outer dimensions that came from the window manager
 * and therefore include chrome. A render surface reports outer == inner, or
 * zero. Measured stable across minimise/restore.
 */
export function hasOsWindowChrome(identity) {
  const outer = identity?.outer;
  const inner = identity?.viewport;
  if (!Array.isArray(outer) || !Array.isArray(inner)) return false;
  if (!(outer[0] > 0 && outer[1] > 0)) return false;
  return outer[0] !== inner[0] || outer[1] !== inner[1];
}

/** Usable at all: the API is present and the document has loaded. */
export function isChartContext(identity) {
  return !!(identity && identity.has_api);
}

const AREA = (identity) => {
  const v = identity?.viewport;
  return Array.isArray(v) ? (v[0] || 0) * (v[1] || 0) : 0;
};

/**
 * Selection rules, strongest first. Each returns the candidates it considers
 * winners; a rule decides only when it returns exactly one.
 *
 * `visible_largest` and `largest_viewport` are the weak tail. They exist so a
 * session with no focused window and no readable chrome still resolves, and
 * they are separated so the answer can say which one had to be used.
 */
const RULES = [
  { name: 'focused', pick: (c) => c.filter((x) => x.identity.focused) },
  { name: 'os_window', pick: (c) => c.filter((x) => hasOsWindowChrome(x.identity)) },
  {
    name: 'visible_largest',
    pick: (c) => {
      const vis = c.filter((x) => x.identity.visible);
      if (!vis.length) return [];
      const max = Math.max(...vis.map((x) => AREA(x.identity)));
      return vis.filter((x) => AREA(x.identity) === max);
    },
  },
  {
    name: 'largest_viewport',
    pick: (c) => {
      if (!c.length) return [];
      const max = Math.max(...c.map((x) => AREA(x.identity)));
      return c.filter((x) => AREA(x.identity) === max);
    },
  },
];

/**
 * Choose one context from probed candidates.
 *
 * Returns `{ candidate, rule }` on a unique winner, or
 * `{ candidate: null, rule: null, tied, ruleName }` when every rule left more
 * than one standing. Never picks arbitrarily — two contexts on one layout hold
 * different histories, so "the first one" is a coin toss with a wrong side.
 *
 * @param {Array<{id: string, url: string, identity: object}>} probed
 * @param {string|null} layout  Restrict to this layout name when given.
 */
export function selectTarget(probed, layout = null) {
  let pool = probed.filter((x) => isChartContext(x.identity));
  if (layout) {
    const inLayout = pool.filter((x) => x.identity.layout === layout);
    if (inLayout.length) pool = inLayout;
  }
  if (!pool.length) return { candidate: null, rule: null, tied: [], ruleName: null };
  if (pool.length === 1) return { candidate: pool[0], rule: 'only_candidate' };

  let lastTie = { tied: pool, ruleName: null };
  for (const rule of RULES) {
    const winners = rule.pick(pool);
    if (winners.length === 1) return { candidate: winners[0], rule: rule.name };
    if (winners.length > 1) lastTie = { tied: winners, ruleName: rule.name };
  }
  return { candidate: null, rule: null, ...lastTie };
}
