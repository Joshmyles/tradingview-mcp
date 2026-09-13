/**
 * Fail-fast environment preconditions for the replay execution harness.
 *
 * WHAT THIS IS FOR. The harness is allowed to skip target- and study-
 * disambiguation entirely — no ranking, no "pick the focused one", no
 * first-match — but that is only safe if a violated assumption is LOUD. Every
 * order-emitting or cursor-moving replay tool calls `assertReplayEnvironment()`
 * before it acts, and that call either returns the one page context and the one
 * strategy, or throws with the full inventory of what it actually found.
 * Nothing here ever chooses between candidates.
 *
 * ── THE STATED INVARIANTS, AND WHAT IS ACTUALLY TRUE ────────────────────────
 *
 * The Phase 0.5 brief asserted two environment invariants. Both are false as
 * literally written, measured on this machine 2026-09-12, TradingView Desktop
 * 3.4.1.8194. They are restated below over the sets that actually create the
 * ambiguity, which is what the invariants were for. This is a deviation from
 * the brief and is recorded here rather than absorbed.
 *
 *   "Exactly one CDP page target (single tab open)."
 *   FALSE. /json/list returned SEVEN targets of type "page" with a single chart
 *   tab open. One is the chart (https://www.tradingview.com/chart/R7HDoRZ2/).
 *   The other six are Electron's own renderers — the tabbed-window title bar
 *   (x2), a drag-service window, index.html shells — and three of those do not
 *   answer a CDP Runtime.evaluate at all (probe timed out at 4000ms, three
 *   times out of three). A literal count of page targets refuses on a clean,
 *   correctly configured machine, every time, so it is not a usable check.
 *   IMPLEMENTED INSTEAD: exactly one page target whose URL is a TradingView
 *   chart, and it must carry a loaded TradingViewApi. That is the set from
 *   which a chart context could be chosen, so it is the set that must be a
 *   singleton for "no disambiguation" to be sound. Non-chart page targets are
 *   listed in the inventory but are not counted, and are not probed (three of
 *   them hang, and 12s of timeouts per tool call is not a precondition).
 *
 *   "Exactly one study on the chart (B15)."
 *   FALSE. `dataSources()` returned 56 entries: 16 studies, 29 drawings titled
 *   with the symbol, 5 built-in event sources, 5 other drawings, the series and
 *   the crosshair. ELEVEN of the 16 studies are Pine: Adaptive Trend Finder,
 *   Consolidation Zones - Live, Liquidity Sweeps [LuxAlgo], Fair Value Gap
 *   [LuxAlgo] (x2), Support Resistance Classification (VR) [LuxAlgo], Delta
 *   Volume Bubbles (x2), Institutional Order Flow Strength Classifier
 *   [LuxAlgo], Multi-Session ORB, ADX and DI for v4 — plus B15. Ten of those
 *   eleven are INVISIBLE; B15 is the only visible one. Four more are built-in
 *   (Dividends, Splits, Earnings, roll dates).
 *   IMPLEMENTED INSTEAD, as three separate checks:
 *     (a) exactly ONE source exposing reportData(), i.e. one strategy. This is
 *         the check that matters: it is what makes "the strategy" a definite
 *         description, and the resolver in core/pine-inputs.js already refuses
 *         rather than tie-breaks for the same reason.
 *     (b) no VISIBLE Pine study other than that strategy. A second script
 *         drawing on the chart is a second program the operator is reading,
 *         and that is worth refusing over.
 *     (c) invisible extra Pine studies are COUNTED AND RETURNED, never
 *         silently dropped — but they are not fatal, because they create
 *         neither of the ambiguities the invariants exist to prevent, and the
 *         strict reading would refuse on the chart as it stands today.
 *   Check (c) was the one judgement call in this file. DECIDED Phase 0.7: it is
 *   FATAL on the replay profile and not on workflow or diagnostic, because the
 *   single-study invariant is load-bearing only for the harness. See
 *   resolveStrictStudies().
 *
 *   Strict counting rests on a CROSS-CHECKED enumeration, never one source.
 *   Phase 0.5 counted 29 drawings off dataSources() when the real number was 5
 *   (the rest were AlertLabel sources rendered from the alert service), so a
 *   count taken from a single surface is not trusted to refuse on. Three
 *   independent enumerations must agree — dataSources(), the chart API's
 *   getAllStudies(), and the saved-layout serialization — and a disagreement
 *   is itself a refusal that names which surface saw what.
 *
 * NOTHING HERE MUTATES. Every expression below is a read.
 */
import CDP from 'chrome-remote-interface';
import { CDP_HOST, CDP_PORT } from '../connection.js';
import { answered } from './verdict.js';

/** A refusal carrying the inventory, so the message can name what it found. */
export class EnvironmentInvariantError extends Error {
  constructor(message, inventory) {
    super(message);
    this.name = 'EnvironmentInvariantError';
    this.inventory = inventory;
  }
}

const CHART_URL = /tradingview\.com\/chart/i;

/**
 * Chart identity plus a full source inventory, read in one round trip.
 *
 * `visible` is read through isVisible(), which on this build returns a plain
 * boolean on some source types and a watched value on others; both shapes are
 * unwrapped, and a source that answers neither reports null rather than
 * having a default guessed for it.
 */
export const ENVIRONMENT_INVENTORY_JS = `
(function () {
  var o = {
    href: location.href,
    has_api: !!(window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV),
  };
  if (!o.has_api) return o;
  try { o.layout = window.TradingViewApi.layoutName(); } catch (e) {}
  var cw;
  try { cw = window.TradingViewApi._activeChartWidgetWV.value(); }
  catch (e) { o.error = String(e && e.message || e); return o; }
  try {
    o.symbol = cw._chartWidget.model().mainSeries().symbol();
    o.resolution = cw._chartWidget.model().mainSeries().interval();
  } catch (e) {}
  var srcs;
  try { srcs = cw._chartWidget.model().model().dataSources(); }
  catch (e) { o.error = String(e && e.message || e); return o; }
  o.source_count = srcs.length;
  // Two further enumerations, read independently so they can be cross-checked
  // (see crossCheckStudyEnumerations). Unavailable is recorded, never defaulted.
  try { o.api_studies = cw.getAllStudies().map(function (x) { return x.id; }); }
  catch (e) { o.api_studies_error = String(e && e.message || e); }
  try {
    var st = cw._chartWidget.model().model().state(true);
    o.serialized_studies = [];
    (st.panes || []).forEach(function (p) {
      (p.sources || []).forEach(function (src) {
        if (!/^Study/.test(String(src.type))) return;
        var smi = src.metaInfo || {};
        o.serialized_studies.push({ id: src.id, type: src.type, is_pine: (smi.pineId || smi.productId) === 'tv-scripting' });
      });
    });
  } catch (e) { o.serialized_studies_error = String(e && e.message || e); }
  o.studies = [];
  o.non_studies = 0;
  for (var i = 0; i < srcs.length; i++) {
    var s = srcs[i];
    if (typeof s.metaInfo !== 'function') { o.non_studies++; continue; }
    var rec = { is_strategy: typeof s.reportData === 'function' };
    try { rec.entity_id = typeof s.id === 'function' ? s.id() : s.id; } catch (e) {}
    try { rec.title = typeof s.title === 'function' ? s.title() : s.title; } catch (e) {}
    try {
      var v = s.isVisible();
      rec.visible = (v && typeof v.value === 'function') ? !!v.value() : (typeof v === 'boolean' ? v : null);
    } catch (e) { rec.visible = null; }
    try {
      var mi = s.metaInfo();
      rec.description = mi && mi.description;
      rec.pine_id = mi && (mi.pineId || mi.productId);
      rec.is_pine = (mi && (mi.pineId || mi.productId)) === 'tv-scripting';
      rec.input_count = mi && mi.inputs ? mi.inputs.length : null;
    } catch (e) { rec.meta_error = String(e && e.message || e); }
    o.studies.push(rec);
  }
  return o;
})()`;

export const PROFILES = Object.freeze(['workflow', 'diagnostic', 'replay']);

/**
 * Whether extra hidden Pine studies are fatal, decided by profile.
 *
 *   replay               ON, always. TVMCP_REPLAY_STRICT_STUDIES=0 is refused
 *                        rather than honoured: an env var that silently
 *                        switches off the harness's own precondition is the
 *                        kind of control this project has stopped trusting.
 *   workflow, diagnostic OFF, unless TVMCP_REPLAY_STRICT_STUDIES=1 opts in.
 *
 * `profile` is required. A missing profile defaulting to lenient would hand
 * the replay harness the workflow behaviour by omission.
 */
export function resolveStrictStudies({ profile, env = process.env.TVMCP_REPLAY_STRICT_STUDIES } = {}) {
  if (!PROFILES.includes(profile)) {
    throw new Error(
      `assertReplayEnvironment requires profile to be one of ${PROFILES.join(', ')}; got ${JSON.stringify(profile)}. `
      + 'It is required, not defaulted, because the strict-studies decision depends on it.',
    );
  }
  if (profile === 'replay') {
    if (env === '0') {
      throw new Error(
        'TVMCP_REPLAY_STRICT_STUDIES=0 cannot disable strict studies on the replay profile: the single-study '
        + 'invariant is the harness precondition. Remove the extra studies from the chart, or unset the variable.',
      );
    }
    return true;
  }
  return env === '1';
}

const EVENT_SOURCE = /^ESD\$/; // built-in dividends/splits/earnings/roll dates: dataSources() only

const diffIds = (a, b) => ({ only_in_first: a.filter((x) => !b.includes(x)), only_in_second: b.filter((x) => !a.includes(x)) });

/**
 * Cross-check the study enumerations the inventory read. Pure.
 *
 * Compares, by entity id:
 *   studies       dataSources() (event sources excluded) vs getAllStudies() vs serialization
 *   pine studies  dataSources() metaInfo vs serialization metaInfo
 *
 * @returns {{ agreed: boolean, unavailable: string[], disagreements: object[], pine_ids: string[] }}
 */
export function crossCheckStudyEnumerations(page) {
  const unavailable = [];
  const ds = (page?.studies || []).filter((s) => !EVENT_SOURCE.test(String(s.entity_id)));
  const sets = { data_sources: ds.map((s) => s.entity_id).sort() };
  if (Array.isArray(page?.api_studies)) sets.chart_api = [...page.api_studies].sort();
  else unavailable.push(`chart_api (getAllStudies): ${page?.api_studies_error || 'not read'}`);
  if (Array.isArray(page?.serialized_studies)) sets.serialized_layout = page.serialized_studies.map((s) => s.id).sort();
  else unavailable.push(`serialized_layout (state(true)): ${page?.serialized_studies_error || 'not read'}`);

  const disagreements = [];
  const names = Object.keys(sets);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const d = diffIds(sets[names[i]], sets[names[j]]);
      if (d.only_in_first.length || d.only_in_second.length) {
        disagreements.push({ over: 'studies', first: names[i], second: names[j], ...d });
      }
    }
  }
  const pineDs = ds.filter((s) => s.is_pine).map((s) => s.entity_id).sort();
  if (Array.isArray(page?.serialized_studies)) {
    const pineSer = page.serialized_studies.filter((s) => s.is_pine).map((s) => s.id).sort();
    const d = diffIds(pineDs, pineSer);
    if (d.only_in_first.length || d.only_in_second.length) {
      disagreements.push({ over: 'pine_studies', first: 'data_sources', second: 'serialized_layout', ...d });
    }
  }
  return { agreed: unavailable.length === 0 && disagreements.length === 0, unavailable, disagreements, pine_ids: pineDs, sets };
}

/** Evaluate one expression against one target over a short-lived connection. */
async function evaluateOn(targetId, expression, timeoutMs = 8000) {
  let c = null;
  try {
    return await Promise.race([
      (async () => {
        c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
        await c.Runtime.enable();
        const r = await c.Runtime.evaluate({ expression, returnByValue: true });
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        }
        return r.result?.value ?? null;
      })(),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs,
      )),
    ]);
  } finally {
    if (c) { try { await c.close(); } catch { /* already gone */ } }
  }
}

/**
 * Assert the environment is unambiguous, and return what it is.
 *
 * Throws EnvironmentInvariantError naming everything it found. Never picks.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.expectStrategyTitle]  refuse unless the one strategy's
 *   description matches exactly. Identity by TITLE is weak and is not trusted
 *   here — see manifests/b15.manifest.json and core/replay-manifest.js for the
 *   content hash, which is the real identity check. This is a cheap early-out.
 * @param {string}  opts.profile               REQUIRED: 'workflow' | 'diagnostic' |
 *   'replay'. Decides whether extra hidden Pine studies are fatal; see
 *   resolveStrictStudies().
 */
export async function assertReplayEnvironment({
  expectStrategyTitle = null,
  profile,
  _deps = null,
} = {}) {
  // Resolved before any I/O, so a misconfiguration refuses without touching CDP.
  const strictStudies = resolveStrictStudies({ profile, env: _deps?.env ?? process.env.TVMCP_REPLAY_STRICT_STUDIES });
  const listTargets = _deps?.listTargets
    || (async () => (await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`)).json());
  const evaluateTarget = _deps?.evaluateOn || evaluateOn;

  let targets;
  try {
    targets = await listTargets();
  } catch (err) {
    throw new EnvironmentInvariantError(
      `Cannot reach the CDP endpoint at ${CDP_HOST}:${CDP_PORT}: ${err.message}. `
      + 'TradingView Desktop must be running with --remote-debugging-port.',
      { targets: null },
    );
  }

  const pages = targets.filter((t) => t.type === 'page');
  const chartPages = pages.filter((t) => CHART_URL.test(t.url || ''));
  const otherPages = pages.filter((t) => !CHART_URL.test(t.url || ''));

  const inventory = {
    checked_at: new Date().toISOString(),
    cdp: `${CDP_HOST}:${CDP_PORT}`,
    page_targets_total: pages.length,
    chart_page_targets: chartPages.map((t) => ({ id: t.id, url: t.url, title: t.title })),
    // Listed, not counted and not probed: these are Electron's own renderers
    // (title bar, drag service, shells) and several do not answer CDP at all.
    other_page_targets: otherPages.map((t) => ({ id: t.id, url: (t.url || '').slice(0, 120) })),
  };

  if (chartPages.length !== 1) {
    throw new EnvironmentInvariantError(
      `Expected exactly 1 TradingView chart page target, found ${chartPages.length}`
      + (chartPages.length
        ? `: ${chartPages.map((t) => `${t.id.slice(0, 8)} ${t.url}`).join(', ')}. `
          + 'Close the extra chart windows or tabs. Refusing rather than choosing one: '
          + 'two contexts on one layout have been measured holding different loaded histories.'
        : '. Open a TradingView chart.'),
      inventory,
    );
  }

  const target = chartPages[0];
  let page;
  try {
    page = await evaluateTarget(target.id, ENVIRONMENT_INVENTORY_JS);
  } catch (err) {
    throw new EnvironmentInvariantError(
      `The one chart page target (${target.id.slice(0, 8)}) did not answer: ${err.message}`,
      inventory,
    );
  }

  inventory.page = page;
  if (!page?.has_api) {
    throw new EnvironmentInvariantError(
      `The one chart page target (${target.id.slice(0, 8)}) has no loaded TradingViewApi`
      + (page?.error ? `: ${page.error}` : '. The chart may still be loading.'),
      inventory,
    );
  }

  const studies = page.studies || [];
  const strategies = studies.filter((s) => s.is_strategy);
  const pineStudies = studies.filter((s) => s.is_pine);
  const describe = (s) =>
    `${s.description || s.title || '(untitled)'} (${s.entity_id}${s.visible === false ? ', hidden' : ''})`;

  inventory.studies = {
    total: studies.length,
    strategies: strategies.map(describe),
    pine_non_strategy: pineStudies.filter((s) => !s.is_strategy).map(describe),
    builtin: studies.filter((s) => !s.is_pine).map(describe),
    non_study_sources: page.non_studies,
  };

  if (strategies.length !== 1) {
    throw new EnvironmentInvariantError(
      `Expected exactly 1 strategy on the chart, found ${strategies.length}`
      + (strategies.length ? `: ${strategies.map(describe).join(', ')}. ` : '. ')
      + 'Refusing rather than choosing one: two builds on one chart are not interchangeable.',
      inventory,
    );
  }

  const strategy = strategies[0];

  const visibleOtherPine = pineStudies.filter((s) => !s.is_strategy && s.visible !== false);
  if (visibleOtherPine.length) {
    throw new EnvironmentInvariantError(
      `${visibleOtherPine.length} visible Pine study/studies besides the strategy: `
      + `${visibleOtherPine.map(describe).join(', ')}. Hide or remove them.`,
      inventory,
    );
  }

  const hiddenOtherPine = pineStudies.filter((s) => !s.is_strategy);
  const cross = crossCheckStudyEnumerations(page);
  inventory.enumeration_cross_check = cross;

  if (strictStudies && !cross.agreed) {
    const parts = [
      ...cross.unavailable.map((u) => `unavailable: ${u}`),
      ...cross.disagreements.map((d) => `${d.over}: ${d.first} alone has [${d.only_in_first.join(', ')}], `
        + `${d.second} alone has [${d.only_in_second.join(', ')}]`),
    ];
    throw new EnvironmentInvariantError(
      `Study enumerations do not agree, so the study count cannot be trusted to refuse on (${profile} profile, strict): `
      + `${parts.join('; ')}. Refusing rather than believing one surface — a single-surface count was once `
      + 'six times too high.',
      inventory,
    );
  }

  if (hiddenOtherPine.length && strictStudies) {
    throw new EnvironmentInvariantError(
      `${hiddenOtherPine.length} extra Pine study/studies loaded (all hidden): `
      + `${hiddenOtherPine.map(describe).join(', ')}. `
      + (profile === 'replay'
        ? 'The replay profile requires the strategy to be the only Pine study on the chart. Remove them.'
        : 'TVMCP_REPLAY_STRICT_STUDIES=1 makes this fatal. Unset it to allow hidden extras.'),
      inventory,
    );
  }

  if (expectStrategyTitle && (strategy.description || strategy.title) !== expectStrategyTitle) {
    throw new EnvironmentInvariantError(
      `The one strategy on the chart is "${strategy.description || strategy.title}", expected `
      + `"${expectStrategyTitle}". Titles are not identity — check the manifest hash — but they `
      + 'are not supposed to differ either.',
      inventory,
    );
  }

  return answered({
    target_id: target.id,
    url: target.url,
    layout: page.layout,
    symbol: page.symbol,
    resolution: page.resolution,
    strategy: {
      entity_id: strategy.entity_id,
      title: strategy.title,
      description: strategy.description,
      input_count: strategy.input_count,
    },
    profile,
    strict_studies: strictStudies,
    // Surfaced on the SUCCESS path too: the operator should see the hidden
    // extras exist without having to trip a refusal to learn about them.
    extra_hidden_pine_studies: hiddenOtherPine.map(describe),
    // Non-strict profiles do not refuse on a disagreement, but they report it.
    enumerations_agree: cross.agreed,
    ...(cross.agreed ? {} : { enumeration_disagreement: { unavailable: cross.unavailable, disagreements: cross.disagreements } }),
    inventory,
  });
}
