import CDP from 'chrome-remote-interface';
import { TARGET_IDENTITY_JS, selectTarget } from './internals/targets.js';

let client = null;
let targetInfo = null;
let targetIdentity = null;
// Once a working chart context has been chosen, stay on it. Reconnects must not
// re-roll the choice: see findChartTarget for why the pool is not homogeneous.
let pinnedTargetId = process.env.TV_CDP_TARGET || null;
const layoutFilter = process.env.TV_CDP_LAYOUT || null;
// Overridable via TV_CDP_HOST/TV_CDP_PORT (or CDP_HOST/CDP_PORT) env vars.
// Default is 127.0.0.1, not localhost: on some Windows machines localhost
// resolves to ::1 first, and Electron's --remote-debugging-port only listens on IPv4.
export const CDP_HOST =
  process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
export const CDP_PORT =
  Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars:
    'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n))
    throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect(targetId = null) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = targetId
        ? await findTargetById(targetId)
        : await findChartTarget();
      if (!target) {
        throw new Error(
          targetId
            ? `CDP target ${targetId} not found — is the tab still open?`
            : 'No TradingView chart target found. Is TradingView open with a chart?',
        );
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      if (targetId) {
        // An explicitly named target skipped findChartTarget's probe.
        try {
          const r = await client.Runtime.evaluate({
            expression: TARGET_IDENTITY_JS,
            returnByValue: true,
          });
          targetIdentity = r.result?.value ?? null;
          if (targetIdentity) targetIdentity.selected_by = 'explicit_target';
        } catch {
          targetIdentity = null;
        }
      }
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(
    `CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
  );
}

/**
 * Re-attach the cached CDP client to a specific target id.
 * Used by tab_switch so subsequent reads (chart_get_state, data_get_*,
 * quote_get, screenshots) follow the activated tab instead of staying
 * glued to the target picked at first connect.
 */
export async function reconnectTo(targetId) {
  pinnedTargetId = targetId;
  if (client) {
    try {
      await client.close();
    } catch {
      /* already gone */
    }
    client = null;
    targetInfo = null;
  }
  return connect(targetId);
}

/**
 * Read a candidate target's page identity over a short-lived connection.
 * Returns null if the target cannot be reached or evaluated.
 */
async function probeIdentity(target) {
  let c = null;
  try {
    c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
    await c.Runtime.enable();
    const r = await c.Runtime.evaluate({
      expression: TARGET_IDENTITY_JS,
      returnByValue: true,
    });
    return r.result?.value ?? null;
  } catch {
    return null;
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

/**
 * Choose the page context that IS the chart the user is looking at.
 *
 * TradingView Desktop runs several page contexts per session: the chart, a
 * same-layout duplicate that is re-used as the layout preview renderer, and a
 * preview renderer per other saved layout. All of them carry a complete
 * TradingViewApi with their own symbol, resolution and studies, and two
 * contexts on ONE layout were measured holding different loaded histories, so
 * matching on URL alone picks one at random and can pick differently on each
 * reconnect.
 *
 * `document.visibilityState` does not separate them and is not used as the
 * rule; see internals/targets.js for what does and for the measurements.
 * Candidates are probed in-page, ranked, and the winning rule is recorded on
 * the identity as `selected_by`. A tie is refused, never broken arbitrarily.
 */
async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const candidates = targets.filter(
    (t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url),
  );
  const pool = candidates.length
    ? candidates
    : targets.filter((t) => t.type === 'page' && /tradingview/i.test(t.url));
  if (!pool.length) return null;

  // An explicit pin wins outright: a caller that named a target meant it.
  if (pinnedTargetId) {
    const pinned = pool.find((t) => t.id === pinnedTargetId);
    if (pinned) {
      targetIdentity = await probeIdentity(pinned);
      if (targetIdentity) targetIdentity.selected_by = 'pinned';
      return pinned;
    }
  }

  const probed = [];
  for (const t of pool) {
    probed.push({ id: t.id, url: t.url, target: t, identity: await probeIdentity(t) });
  }

  const { candidate, rule, tied, ruleName } = selectTarget(probed, layoutFilter);
  if (candidate) {
    targetIdentity = { ...candidate.identity, selected_by: rule };
    pinnedTargetId = candidate.id;
    return candidate.target;
  }

  const describe = (x) =>
    `${x.id.slice(0, 8)} layout=${x.identity?.layout ?? '?'} ` +
    `${x.identity?.symbol ?? '?'} ${x.identity?.resolution ?? '?'} ` +
    `inner=${(x.identity?.viewport || []).join('x')} outer=${(x.identity?.outer || []).join('x')}`;

  const usable = probed.filter((x) => x.identity?.has_api);
  if (!usable.length) {
    const err = new Error(
      `No usable TradingView chart context. ${pool.length} chart page(s) found, none with a loaded ` +
        'TradingViewApi. Open a chart, or pin a context with TV_CDP_TARGET.',
    );
    err.rejectedTargets = probed.map((x) => ({ id: x.id, url: x.url, identity: x.identity }));
    throw err;
  }

  // Ambiguous. These contexts are NOT interchangeable — measured, two on one
  // layout held 329 and 381 bars — so picking one would be a coin toss with a
  // wrong side.
  const lines = [
    `Ambiguous TradingView chart context: ${(tied || []).length} candidates tied at rule ` +
      `"${ruleName ?? 'none'}" and no stronger rule separated them.`,
    ...(tied || []).map(describe),
    'Bring the chart window to the foreground, or pin one with TV_CDP_TARGET=<id> ' +
      '(or narrow to a layout with TV_CDP_LAYOUT=<name>).',
  ];
  const err = new Error(lines.join('\n'));
  err.rejectedTargets = probed.map((x) => ({ id: x.id, url: x.url, identity: x.identity }));
  err.ambiguous = true;
  throw err;
}

async function findTargetById(id) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.find((t) => t.id === id) || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try {
      await client.close();
    } catch {}
    client = null;
    targetInfo = null;
    targetIdentity = null;
  }
}

/**
 * The page identity of the currently attached context.
 *
 * Part of a state fence: a read that describes a different context from the
 * one a mutation was applied to is not stale, it is unrelated. Returns null
 * before the first connect.
 */
export function getTargetIdentity() {
  return targetIdentity ? { ...targetIdentity, target_id: targetInfo?.id ?? null } : null;
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(
    `typeof (${path}) !== 'undefined' && (${path}) !== null`,
  );
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(
    KNOWN_PATHS.chartWidgetCollection,
    'Chart Widget Collection',
  );
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
