/**
 * CDP target identity.
 *
 * INTERNAL — see paths.js. Re-verify after every TradingView update.
 *
 * TradingView Desktop runs MORE THAN ONE page context per chart layout.
 * Measured 2026-09-10 on a two-layout session, `/json/list` reported four
 * chart pages:
 *
 *   09EBFD9A  R7HDoRZ2  visible  1920x1046  ICMARKETS:XAUUSD 45S  304 bars
 *   962BE3C0  R7HDoRZ2  hidden    500x318   ICMARKETS:XAUUSD 45S  301 bars
 *   67BD8A45  bzMBAknq  hidden    500x318   OANDA:XAGUSD      2   300 bars
 *   8AF118B4  bzMBAknq  hidden    500x318   ICMARKETS:XAUUSD  5   300 bars
 *
 * The hidden three are the desktop app's layout preview renderers. They are
 * NOT stubs: each has a complete `window.TradingViewApi`, its own chart model,
 * its own symbol and resolution, its own data sources, and — for the duplicate
 * of the working layout — the same study ids. Every path in paths.js resolves
 * on them and returns plausible, wrong answers.
 *
 * `/json/list` carries no visibility field and its ordering is not guaranteed,
 * so a target chosen by URL match alone is chosen at random among these. A
 * mutation applied to a preview and a read taken from the real chart is
 * indistinguishable from the staleness this whole barrier exists to catch.
 *
 * The discriminator is in-page and unambiguous: exactly one context reports
 * `document.visibilityState === 'visible'`.
 */

/**
 * Identity of the page context this expression is evaluated in.
 *
 * `visible` is the selection rule. The rest is evidence, returned so a caller
 * that rejects a target can say what it rejected.
 */
export const TARGET_IDENTITY_JS = `
  (function() {
    var o = {
      href: location.href,
      visible: document.visibilityState === 'visible',
      viewport: [window.innerWidth, window.innerHeight],
      ready: document.readyState,
      has_api: !!(window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV)
    };
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
 * Preview renderers are small. Kept as corroboration only — visibility is the
 * rule, because a genuinely small application window must still be usable.
 */
export const PREVIEW_VIEWPORT_HINT = { w: 500, h: 318 };

/** A target worth attaching to: the real chart, loaded, with the API present. */
export function isWorkingChart(identity) {
  return !!(identity && identity.visible && identity.has_api);
}
