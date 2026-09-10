/**
 * The gate that stands between a destructive test suite and the working chart.
 *
 * On 2026-09-10 the e2e suite ran against the live research layout. It left
 * four indicators behind and wedged symbol resolution chart-wide: zero bars,
 * every study in error, and no recovery short of restarting the application.
 * A harness that can destroy what it is testing against is worse than no
 * harness, because it is trusted.
 *
 * Three conditions, all required:
 *
 *   1. An explicit environment variable. Not a default, not a flag with a
 *      sensible value — absent means no.
 *   2. The attached page is the VISIBLE chart. TradingView Desktop runs hidden
 *      preview renderers that answer every API call plausibly, so "which chart
 *      am I about to modify" is a question with a wrong answer available.
 *   3. The layout is the fixture layout, by name, and is not on the forbidden
 *      list.
 *
 * Every failure is loud. A skipped destructive suite that silently passes is
 * the same lie in the other direction.
 */
import CDP from 'chrome-remote-interface';
import { FIXTURE, FORBIDDEN_LAYOUT_NAMES, ENV_GATE } from './fixtures/fixture.config.js';

const HOST = process.env.TV_CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.TV_CDP_PORT || 9222);

const PROBE = `
  (function() {
    var out = { visible: document.visibilityState === 'visible', layout: null, symbol: null, resolution: null };
    try { out.layout = window.TradingViewApi.layoutName(); } catch (e) {}
    try {
      var cw = window.TradingViewApi._activeChartWidgetWV.value();
      out.symbol = cw.symbol();
      out.resolution = cw.resolution();
    } catch (e) {}
    return out;
  })()`;

async function probeVisibleChart() {
  const resp = await fetch(`http://${HOST}:${PORT}/json/list`);
  const targets = await resp.json();
  const pool = targets.filter(
    (t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url || ''),
  );
  const seen = [];
  for (const t of pool) {
    let c = null;
    try {
      c = await CDP({ host: HOST, port: PORT, target: t.id });
      await c.Runtime.enable();
      const r = await c.Runtime.evaluate({ expression: PROBE, returnByValue: true });
      const v = r.result?.value;
      seen.push(v);
      if (v?.visible) return { identity: v, target: t, seen };
    } catch {
      /* unreachable target; keep looking */
    } finally {
      if (c) {
        try {
          await c.close();
        } catch {
          /* already gone */
        }
      }
    }
  }
  return { identity: null, target: null, seen };
}

/**
 * Throw unless it is safe to run a destructive suite right now.
 *
 * Returns the fixture identity on success so a suite can assert against it.
 */
export async function requireFixtureLayout() {
  if (process.env[ENV_GATE] !== '1') {
    throw new Error(
      `Refusing to run a destructive suite: ${ENV_GATE} is not set to 1.\n` +
        'These tests add and remove studies and change the symbol on a LIVE chart. ' +
        `Set up the fixture layout first (tests/fixtures/README.md), switch to it, then set ${ENV_GATE}=1.`,
    );
  }

  const { identity, seen } = await probeVisibleChart();
  if (!identity) {
    throw new Error(
      'Refusing to run a destructive suite: no VISIBLE TradingView chart context. ' +
        `Contexts seen: ${JSON.stringify(seen)}. The hidden ones are layout preview renderers, not the chart.`,
    );
  }

  if (FORBIDDEN_LAYOUT_NAMES.includes(identity.layout)) {
    throw new Error(
      `Refusing to run a destructive suite against layout "${identity.layout}", which is on the forbidden list. ` +
        `Switch to "${FIXTURE.layoutName}" first.`,
    );
  }

  if (identity.layout !== FIXTURE.layoutName) {
    throw new Error(
      `Refusing to run a destructive suite against layout "${identity.layout}". ` +
        `Expected "${FIXTURE.layoutName}". See tests/fixtures/README.md for how to create it. ` +
        'Do not point these tests at a layout you care about.',
    );
  }

  return identity;
}
