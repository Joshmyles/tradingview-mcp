/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite } from '../connection.js';
import { captureFence as _captureFence } from '../settle.js';
import { observed, refused, unobservable } from '../internals/verdict.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    captureFence: deps?.captureFence || _captureFence,
  };
}

/**
 * Mutations do not wait, and do not claim readiness.
 *
 * `chart_ready: true` used to be returned here on the strength of a DOM-element
 * count that stabilised after ~400ms, while the strategy behind it was still
 * recomputing 20 seconds later. The claim was false, and being false it was
 * worse than absent.
 *
 * The hazard a barrier defends against is a stale READ, and it is at the read
 * that the barrier now sits. A mutation reports only what it did, plus the
 * fence a later read needs to prove the chart moved on. This also composes:
 * symbol, then timeframe, then window, then one read — the settle is paid once
 * at the end rather than once per mutation.
 */
function applied(detail, fence) {
  return {
    success: true,
    applied: true,
    // Deliberately not a readiness claim. Nothing here has been waited on.
    settled: false,
    ...detail,
    fence,
    next: 'Reads gate themselves. Call chart_await_settled first only if you need to know the chart has caught up before doing something else.',
  };
}

export async function getState({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol, _deps }) {
  const { evaluateAsync, captureFence } = _resolve(_deps);
  const fence = await captureFence({ seriesAffecting: true });
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  return applied({ symbol }, fence);
}

export async function setTimeframe({ timeframe, _deps }) {
  const { evaluate, captureFence } = _resolve(_deps);
  const fence = await captureFence({ seriesAffecting: true });
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${safeString(timeframe)}, {});
    })()
  `);
  return applied({ timeframe }, fence);
}

export async function setType({ chart_type, _deps }) {
  const { evaluate } = _resolve(_deps);
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum) || typeNum < 0 || typeNum > 9 || !Number.isInteger(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
      try { return chart.chartType(); } catch (e) {
        try { return chart._chartWidget.model().mainSeries().properties().style.value(); } catch (e2) { return null; }
      }
    })()
  `);
  // setChartType() returns nothing and throws nothing for a type the chart
  // declines, so without this read the tool reported the type it was ASKED for.
  if (actual === null || actual === undefined) {
    return unobservable(
      'the chart exposes no readable chart-type accessor in this build, so the '
      + 'change was requested but not confirmed',
      { chart_type, type_num: typeNum },
    );
  }
  if (Number(actual) !== typeNum) {
    return refused(
      `chart type is ${actual} after setChartType(${typeNum}) for "${chart_type}"`,
      { chart_type, type_num: typeNum, actual_type_num: Number(actual) },
    );
  }
  return observed({ chart_type_now: Number(actual) }, { chart_type, type_num: typeNum });
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator)}, false, false, []);
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    const entityId = newIds[0] || null;

    // createStudy's inputs argument is unreliable across builds (#249): the
    // study is created with defaults regardless. Apply overrides afterward
    // via the study's own getInputValues/setInputValues, then read back to
    // report what actually took.
    let appliedInputs;
    if (entityId && inputs && Object.keys(inputs).length) {
      const result = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var study = chart.getStudyById(${safeString(entityId)});
          if (!study || typeof study.getInputValues !== 'function') return { error: 'inputs unsupported for this study' };
          var current = study.getInputValues();
          var overrides = ${JSON.stringify(inputs)};
          var applied = {}, unknown = [];
          var byId = {};
          for (var i = 0; i < current.length; i++) byId[current[i].id] = true;
          for (var k in overrides) {
            if (byId[k]) { for (var j = 0; j < current.length; j++) { if (current[j].id === k) current[j].value = overrides[k]; } applied[k] = overrides[k]; }
            else unknown.push(k);
          }
          study.setInputValues(current);
          var after = study.getInputValues();
          var confirmed = {};
          for (var m = 0; m < after.length; m++) { if (applied.hasOwnProperty(after[m].id)) confirmed[after[m].id] = after[m].value; }
          return { confirmed: confirmed, unknown: unknown };
        })()
      `);
      if (result?.error) appliedInputs = { error: result.error };
      else appliedInputs = { applied: result?.confirmed || {}, ...(result?.unknown?.length && { unknown_inputs: result.unknown }) };
    }

    return {
      success: newIds.length > 0,
      action: 'add',
      indicator,
      entity_id: entityId,
      new_study_count: newIds.length,
      ...(appliedInputs && { inputs: appliedInputs }),
    };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    const removal = await evaluate(`
      (function() {
        var chart = ${CHART_API};
        var idsBefore = chart.getAllStudies().map(function(s) { return s.id; });
        var existed = idsBefore.indexOf(${safeString(entity_id)}) !== -1;
        chart.removeEntity(${safeString(entity_id)});
        var idsAfter = chart.getAllStudies().map(function(s) { return s.id; });
        return { existed: existed, still_present: idsAfter.indexOf(${safeString(entity_id)}) !== -1, remaining: idsAfter.length };
      })()
    `);
    // removeEntity() is silent about an id that does not exist and about one it
    // declines to remove, so both used to read as a successful removal.
    if (!removal?.existed) {
      return refused(
        `no study with entity_id "${entity_id}" was on the chart, so nothing was removed`,
        { action: 'remove', entity_id, remaining_studies: removal?.remaining ?? null },
      );
    }
    if (removal.still_present) {
      return refused(
        `study "${entity_id}" is still on the chart after removeEntity()`,
        { action: 'remove', entity_id, remaining_studies: removal.remaining },
      );
    }
    return observed(
      { removed_entity_id: entity_id, remaining_studies: removal.remaining },
      { action: 'remove', entity_id },
    );
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to, _deps }) {
  const { evaluate } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');

  // Ensure enough history is loaded to cover `from`. The chart lazy-loads bars
  // (~300 initially), so without this a multi-year range clamps to whatever is
  // already loaded. Page back via requestMoreData until the earliest loaded bar
  // reaches `from`, the feed runs out, or a guard trips.
  for (let i = 0; i < 25; i++) {
    const state = await evaluate(`(function() {
      var ms = ${CHART_API}._chartWidget.model().mainSeries();
      var b = ms.bars(); var fv = b.valueAt(b.firstIndex());
      var more = true; try { more = ms.requestMoreDataAvailable(); } catch (e) {}
      return { firstTime: fv && fv[0], more: more };
    })()`);
    if (!state || state.firstTime == null || state.firstTime <= f || !state.more) break;
    await evaluate(`(function() { try { ${CHART_API}._chartWidget.model().mainSeries().requestMoreData(1000); } catch (e) {} })()`);
    await new Promise(r => setTimeout(r, 1800));
  }

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${f} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${t}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  // zoomToBarsRange clamps to loaded history; `actual` was already read and
  // then reported beside an unconditional success.
  if (!actual || (actual.from === 0 && actual.to === 0)) {
    return refused(
      'the visible range could not be read back after zooming, so the window on screen is unknown',
      { requested: { from, to }, actual: actual || { from: 0, to: 0 } },
    );
  }
  return observed({ actual_window: actual }, { requested: { from, to }, actual });
}

/**
 * Bar length in seconds for a TradingView resolution string.
 *
 * The `S` suffix is the reason this exists. `parseInt('45S')` is 45, and the
 * obvious `mins * 60` then reads a 45-SECOND chart as a 45-MINUTE one — a
 * 60-fold error that produces a perfectly plausible chart window, just the
 * wrong one. The reference chart is 45S, so this was wrong on the only
 * resolution that matters here.
 *
 * Returns null for a resolution this does not understand, so a caller can say
 * so rather than silently defaulting to a minute.
 */
export function resolutionSeconds(resolution) {
  const res = String(resolution ?? '').trim().toUpperCase();
  if (!res) return null;
  if (res === 'D' || res === '1D') return 86400;
  if (res === 'W' || res === '1W') return 604800;
  if (res === 'M' || res === '1M') return 2592000;
  let m = res.match(/^(\d+)S$/);
  if (m) return Number(m[1]);
  m = res.match(/^(\d+)D$/);
  if (m) return Number(m[1]) * 86400;
  m = res.match(/^(\d+)W$/);
  if (m) return Number(m[1]) * 604800;
  m = res.match(/^(\d+)M$/);
  if (m) return Number(m[1]) * 2592000;
  m = res.match(/^(\d+)$/);
  if (m) return Number(m[1]) * 60;
  return null;
}

export async function scrollToDate({ date, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  const secsPerBar = resolutionSeconds(resolution);

  if (secsPerBar == null) throw new Error(`Unrecognised resolution "${resolution}"; cannot size a bar window from it.`);
  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  // zoomToBarsRange() silently clamps to whatever history is loaded, so the
  // requested window and the window on screen routinely differ. Report BOTH.
  const actual = await evaluate(`
    (function() {
      try { var r = ${CHART_API}.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch (e) { return null; }
    })()
  `);
  if (!actual) {
    return unobservable(
      'the visible range could not be read back, so the scroll was requested but not confirmed',
      { date, centered_on: timestamp, resolution, window: { from, to } },
    );
  }
  const covers = actual.from <= timestamp && actual.to >= timestamp;
  if (!covers) {
    return refused(
      `the visible window after scrolling is ${actual.from}..${actual.to}, which does not contain ${timestamp} `
      + `(${date}) — the chart clamped to the history it has loaded`,
      { date, centered_on: timestamp, resolution, requested_window: { from, to }, actual_window: actual },
    );
  }
  return observed(
    { actual_window: actual, contains_target: true },
    { date, centered_on: timestamp, resolution, requested_window: { from, to } },
  );
}

export async function symbolInfo({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
