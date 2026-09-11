/**
 * loss_autopsy — one trade, one packet, from a context that is the same every
 * time.
 *
 * ## The point is the determinism, not the pictures
 *
 * An autopsy assembled by hand starts from whatever happened to be on screen:
 * some resolution, some zoom, some set of overlays, some layout. Two autopsies
 * of two trades are then not comparable, and neither is the same trade looked
 * at twice a week apart. This tool pins all of it — the layout, the bar
 * window, the resolutions — so what differs between two packets is the trade.
 *
 * ## Every exit path restores
 *
 * The tool changes the chart: layout, resolution, and visible range. All three
 * are captured before anything moves and restored in a `finally`, including
 * when the trade lookup fails, when a capture throws, and when the caller's
 * timeout fires. What "restored" has to mean is the `AS_FOUND` list below —
 * one place, read by the check, the test and the packet. `restored` in the
 * result says what went back and whether it was verified, and a restore that
 * FAILED is reported as an error on an otherwise successful packet rather than
 * being swallowed — leaving the live research chart on a forensics layout is
 * the worst outcome here, and silence about it is worse still.
 *
 * ## The forensics layout is not invented
 *
 * If `layout` names a layout that does not exist, this REFUSES and lists what
 * there is. Falling back to the current layout would defeat the entire purpose
 * — the packet would claim a pinned context and describe whatever was on
 * screen — and provisioning the layout automatically is the failure mode
 * `tests/fixtures/README.md` already argues against: a harness that creates
 * its own target on a live account can create it in the wrong place.
 *
 * Omitting `layout` runs on the current one and the packet says
 * `layout_pinned: false`, so a caller can tell a deterministic packet from an
 * opportunistic one.
 */
import { evaluate } from '../connection.js';
import { PATHS } from '../internals/paths.js';
import { captureFence, requireSettled } from '../settle.js';
import { resolutionSeconds, setVisibleRange } from './chart.js';
import { resolveEntity } from './pine-inputs.js';
import { readStrategyReport } from '../strategy-report.js';
import { captureScreenshot } from './capture.js';
import { getPineLines, getPineLabels, getPineBoxes } from './data.js';
import { ensureHistoryJs } from '../internals/equity.js';

/** Three resolutions: the trading one, and one either side of it. */
export const DEFAULT_TIMEFRAMES = ['45S', '5', '60'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sameResolution(a, b) {
  const x = resolutionSeconds(a);
  return x != null && x === resolutionSeconds(b);
}

/**
 * What "as found" means, in full.
 *
 * Every piece of chart state this tool changes is listed here with how it is
 * compared, and `matches_as_found` is true only when EVERY entry verifies. The
 * list is explicit because the implicit one was wrong: on 2026-09-11 the
 * restore compared layout, symbol and resolution, left the chart two weeks
 * displaced, and reported `matches_as_found: true`. A list nobody can read is
 * audited by its next omission; this one is read by the test and printed in
 * the packet as `restored.as_found`.
 *
 * Deliberately NOT on it, so nobody has to rediscover why:
 *   - loaded history depth — extended to reach the entry; harmless, and there
 *     is no API to unload it
 *   - the bar-index range — it rebases whenever history is extended, so time
 *     is the durable coordinate and is what `visible_range` compares
 *   - replay state, study visibility, drawings, chart type — this tool never
 *     touches them, so it has nothing to put back
 */
export const AS_FOUND = [
  { what: 'layout', read: (c) => c?.layout ?? null, same: (a, b) => a === b },
  { what: 'symbol', read: (c) => c?.symbol ?? null, same: (a, b) => a === b },
  { what: 'resolution', read: (c) => c?.resolution ?? null, same: (a, b) => a === b || sameResolution(a, b) },
  {
    what: 'visible_range',
    read: (c) => c?.time_range ?? null,
    // By TIME, within two bars of the found resolution at either end:
    // setVisibleRange snaps to bar boundaries, so exact equality is not on offer.
    same: (a, b, tol) => !!b && Math.abs(b.from - a.from) <= tol && Math.abs(b.to - a.to) <= tol,
  },
];

/**
 * Compare the chart as left against the chart as found, field by field.
 *
 * A field that was never recorded (a null range on a chart with no bars) is
 * reported `compared: false` and does not fail the whole — silently passing
 * it would be a lie, silently failing it would make the tool unusable on the
 * charts where it matters least.
 */
export function compareAsFound(before, final) {
  const tol = 2 * (resolutionSeconds(before?.resolution) || 45);
  const fields = AS_FOUND.map((f) => {
    const want = f.read(before);
    const got = f.read(final);
    const recorded = want != null && (f.what !== 'visible_range' || (Number.isFinite(want.from) && Number.isFinite(want.to)));
    if (!recorded) return { what: f.what, want, got, compared: false, ok: true };
    return { what: f.what, want, got, compared: true, ok: f.same(want, got, tol) };
  });
  const failed = fields.filter((f) => !f.ok).map((f) => f.what);
  return { ok: failed.length === 0, fields, failed };
}

/** Read the chart identity that has to be put back. */
async function captureContext(ev) {
  return ev(`
    (function() {
      var cw = ${PATHS.chartApi};
      var out = { symbol: null, resolution: null, layout: null, layout_id: null, range: null, time_range: null };
      // Bar indices rebase whenever history is extended, so the view is restored
      // by TIME; the index range is kept for the record only.
      try { out.time_range = cw.getVisibleRange(); } catch (e) {}
      try { out.symbol = cw.symbol(); } catch (e) {}
      try { out.resolution = cw.resolution(); } catch (e) {}
      try { out.layout = window.TradingViewApi.layoutName(); } catch (e) {}
      try {
        var ts = cw._chartWidget.model().timeScale();
        out.range = { first: ts.visibleBarsStrictRange().firstBar(), last: ts.visibleBarsStrictRange().lastBar() };
      } catch (e) {}
      return out;
    })()`);
}

/** Saved layouts, by name. Read-only. */
async function listLayouts(ev) {
  return ev(
    `new Promise(function(resolve){
       try {
         window.TradingViewApi.getSavedCharts(function(list){
           resolve((list || []).map(function(c){ return { id: c.id, name: c.name }; }));
         });
       } catch (e) { resolve([]); }
       setTimeout(function(){ resolve([]); }, 15000);
     })`,
    { awaitPromise: true },
  );
}

async function switchLayout(ev, id, name) {
  // loadChartFromServer needs TradingView's own saved-chart ENTRY: it loads
  // /chart/<entry.url>/. Handed { id } alone, the backend load rejected with
  // "Response" (measured 2026-09-11). So the entry is looked up and passed in
  // the same page call, never rebuilt from the fields this file happens to know.
  const started = await ev(
    `new Promise(function(resolve){
       try {
         window.TradingViewApi.getSavedCharts(function(list){
           var e = (list || []).find(function(c){ return c.id === ${JSON.stringify(id)}; });
           if (!e) { resolve({ ok: false, error: 'layout ' + ${JSON.stringify(id)} + ' is not in the saved list' }); return; }
           Promise.resolve(window.TradingViewApi.loadChartFromServer(e)).then(
             function(){ resolve({ ok: true }); },
             function(err){ resolve({ ok: false, error: String(err && err.message || err) }); });
         });
       } catch (e) { resolve({ ok: false, error: e.message }); }
       setTimeout(function(){ resolve({ ok: false, error: 'getSavedCharts timed out' }); }, 15000);
     })`,
    { awaitPromise: true },
  );
  if (!started?.ok) return null;
  // Wait for the TARGET name. Any non-null name is not an edge: the old
  // layout's name is non-null from the first poll.
  for (let i = 0; i < 60; i++) {
    const now = await ev(`(function(){ try { return window.TradingViewApi.layoutName(); } catch (e) { return null; } })()`);
    if (now === name) return now;
    await sleep(500);
  }
  return null;
}

/** Centre the chart on a time, using the resolution's real bar length. */
async function centreOn(ev, timeMs, barsEitherSide) {
  const resolution = await ev(`${PATHS.chartApi}.resolution()`);
  const secs = resolutionSeconds(resolution);
  if (secs == null) {
    return { ok: false, error: `Unrecognised resolution "${resolution}"; cannot size a bar window from it.` };
  }
  const centre = Math.floor(timeMs / 1000);
  const half = barsEitherSide * secs;
  // The series is a viewport cache: on a fresh resolution it holds a few
  // hundred bars, and an entry two weeks back is simply not loaded. Measured
  // on the first live run: the 5-minute view came back time_outside_loaded_bars
  // and was photographed anyway. Pull history in first, and say so if it
  // cannot reach.
  const hist = await ev(ensureHistoryJs(centre - half), { awaitPromise: true });
  if (hist && hist.covered === false) {
    return {
      ok: false,
      reason: 'history_not_reached',
      resolution,
      seconds_per_bar: secs,
      history: { reason: hist.reason, rounds: hist.rounds, first_bar_sec: hist.final?.t0 ?? null },
    };
  }
  const applied = await ev(`
    (function() {
      var cw = ${PATHS.chartApi};
      var m = cw._chartWidget.model();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex(), endIdx = bars.lastIndex();
      if (startIdx == null || endIdx == null) return { ok: false, reason: 'no_bars' };
      var from = ${centre - 0} - ${half}, to = ${centre} + ${half};
      var fromIdx = null, toIdx = null;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (!v) continue;
        if (v[0] >= from && fromIdx === null) fromIdx = i;
        if (v[0] <= to) toIdx = i;
      }
      if (fromIdx === null || toIdx === null || toIdx <= fromIdx) return { ok: false, reason: 'time_outside_loaded_bars', first: bars.valueAt(startIdx) && bars.valueAt(startIdx)[0], last: bars.valueAt(endIdx) && bars.valueAt(endIdx)[0] };
      m.timeScale().zoomToBarsRange(fromIdx, toIdx);
      return { ok: true, from_index: fromIdx, to_index: toIdx, bars: toIdx - fromIdx + 1 };
    })()`);
  return { ok: applied?.ok !== false, resolution, seconds_per_bar: secs, ...applied };
}

export async function lossAutopsy({
  tradeIndex,
  entityId = null,
  layout = null,
  timeframes = DEFAULT_TIMEFRAMES,
  barsEitherSide = 40,
  includeCaptures = true,
  _deps,
} = {}) {
  const ev = _deps?.evaluate || evaluate;
  const capture = _deps?.captureScreenshot || captureScreenshot;

  const idx = Number(tradeIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    return { ok: false, reason: 'invalid_argument', error: `trade_index must be a non-negative integer; got "${tradeIndex}".` };
  }
  const frames = Array.isArray(timeframes) && timeframes.length ? timeframes : DEFAULT_TIMEFRAMES;
  const badFrame = frames.find((f) => resolutionSeconds(f) == null);
  if (badFrame) {
    return { ok: false, reason: 'invalid_argument', error: `Unrecognised timeframe "${badFrame}". Use e.g. 45S, 5, 60, D.` };
  }

  const resolved = await resolveEntity({ hint: entityId, _deps });
  if (!resolved.ok) {
    return {
      ok: false,
      reason: resolved.reason === 'ambiguous' ? 'ambiguous_entity' : resolved.reason,
      error: resolved.error,
      candidates: resolved.candidates,
    };
  }
  const entity = resolved.resolved;
  // The drawing readers name a study by its script description ("Build 14"),
  // not its chart title ("B14"). Filtering by title matched nothing on the
  // first live run and returned 0 of 0 drawings of every kind.
  const description = await ev(`(function(){ try { var s = ${PATHS.dataSources}.find(function(x){ try { return x.id() === ${JSON.stringify(entity.entity_id)}; } catch (e) { return false; } }); return s ? s.metaInfo().description : null; } catch (e) { return null; } })()`);

  // Everything that will be changed, read BEFORE anything changes.
  const before = await captureContext(ev);

  // Resolve the forensics layout up front. Refusing here costs nothing;
  // refusing after three resolution changes wastes two minutes.
  let layoutTarget = null;
  if (layout) {
    const saved = await listLayouts(ev);
    const match = saved.filter((l) => l.name === layout);
    if (match.length !== 1) {
      return {
        ok: false,
        reason: match.length ? 'ambiguous_layout' : 'layout_not_found',
        error: match.length
          ? `${match.length} saved layouts are named "${layout}". Names are the only handle this has; rename one.`
          : `No saved layout named "${layout}". An autopsy pinned to a layout that does not exist would describe whatever happened to be on screen, which is the thing this tool exists to prevent.`,
        available_layouts: saved.map((l) => l.name),
      };
    }
    layoutTarget = match[0];
  }

  const packet = {
    ok: true,
    trade_index: idx,
    entity_id: entity.entity_id,
    entity_title: entity.title,
    layout_pinned: !!layoutTarget,
    layout: layoutTarget?.name ?? before.layout,
    context_as_found: before,
  };
  const restored = { attempted: false };
  const errors = [];

  try {
    if (layoutTarget && layoutTarget.name !== before.layout) {
      restored.attempted = true;
      const now = await switchLayout(ev, layoutTarget.id, layoutTarget.name);
      if (now !== layoutTarget.name) {
        return {
          ok: false,
          reason: 'layout_switch_failed',
          error: `Asked for layout "${layoutTarget.name}" and the chart reports "${now}". Nothing was captured.`,
          context_as_found: before,
        };
      }
      const gate = await requireSettled({ scope: 'strategies', requireSeries: true });
      if (!gate.ok) errors.push({ stage: 'layout_settle', ...gate });
    }

    // --- The trade. Read through the barrier, on the resolved entity.
    const report = await readStrategyReport({ entityId: entity.entity_id });
    if (!report?.ok && report?.success !== true) {
      return { ...packet, ok: false, reason: report?.reason || 'report_unavailable', error: report?.error || 'Could not read the strategy report.' };
    }
    const trades = report.trades || report.book || [];
    if (!trades.length) {
      return { ...packet, ok: false, reason: 'not_found', error: 'The strategy report holds no trades on this chart.' };
    }
    if (idx >= trades.length) {
      return {
        ...packet,
        ok: false,
        reason: 'not_found',
        error: `trade_index ${idx} is out of range: the book holds ${trades.length} rows (0..${trades.length - 1}).`,
        trade_count: trades.length,
      };
    }
    const trade = trades[idx];
    const entryMs = trade.entry_time ?? trade.entry?.time ?? null;
    if (entryMs == null) {
      return { ...packet, ok: false, reason: 'internal', error: 'The trade row carries no entry time, so there is nothing to centre on.', trade };
    }
    packet.trade = trade;
    packet.trade_count = trades.length;

    // --- Captures, one per timeframe, each centred on the entry bar.
    const secsHere = resolutionSeconds(before.resolution) || 45;
    const spanMs = barsEitherSide * secsHere * 1000;
    packet.window = { centre_ms: entryMs, bars_either_side: barsEitherSide, span_ms: spanMs };

    const views = [];
    for (const tf of frames) {
      const view = { timeframe: tf };
      try {
        const current = await ev(`${PATHS.chartApi}.resolution()`);
        if (sameResolution(current, tf)) {
          // Already on it: no rebuild is coming, so a rebuild fence would wait
          // for one that never arrives (measured: the 45S view timed out at 90s).
          const gate = await requireSettled({ scope: 'strategies', requireSeries: true });
          if (!gate.ok) {
            view.error = gate.error;
            view.settle = gate.settle;
            views.push(view);
            continue;
          }
        } else {
          const fence = await captureFence({ seriesAffecting: true, entityId: entity.entity_id });
          await ev(`${PATHS.chartApi}.setResolution(${JSON.stringify(tf)}, {})`);
          const gate = await requireSettled({ scope: 'strategies', requireSeries: true, fence });
          if (!gate.ok) {
            view.error = gate.error;
            view.settle = gate.settle;
            views.push(view);
            continue;
          }
        }
        const centred = await centreOn(ev, entryMs, barsEitherSide);
        view.centred = centred;
        if (!centred.ok) {
          view.capture = {
            skipped: 'not_centred',
            note: 'A capture of a window that does not contain the entry would be evidence of the wrong thing, so none was taken.',
          };
        } else if (includeCaptures) {
          const shot = await capture({
            region: 'chart',
            filename: `autopsy_${entity.entity_id}_t${idx}_${String(tf).replace(/\W/g, '')}`,
            waitForRender: true,
          });
          view.capture =
            shot?.success === false || shot?.ok === false
              ? { error: shot.error?.message || shot.error }
              : { path: shot.file_path ?? null, bytes: shot.size_bytes ?? null };
        }
      } catch (err) {
        view.error = err.message;
      }
      views.push(view);
    }
    packet.views = views;

    // --- Pine drawings across the trade, read on the ORIGINAL resolution so
    // the bar indices are the ones the book was computed on.
    try {
      if (!sameResolution(await ev(`${PATHS.chartApi}.resolution()`), before.resolution)) {
        const fence = await captureFence({ seriesAffecting: true, entityId: entity.entity_id });
        await ev(`${PATHS.chartApi}.setResolution(${JSON.stringify(before.resolution)}, {})`);
        const gate = await requireSettled({ scope: 'strategies', requireSeries: true, fence });
        if (!gate.ok) errors.push({ stage: 'drawings_settle', ...gate });
      }
      const centred = await centreOn(ev, entryMs, barsEitherSide);
      const filter = description || entity.title || undefined;
      const [lines, labels, boxes] = await Promise.all([
        getPineLines({ study_filter: filter, verbose: true, wait: false }).catch((e) => ({ error: e.message })),
        getPineLabels({ study_filter: filter, verbose: true, wait: false }).catch((e) => ({ error: e.message })),
        getPineBoxes({ study_filter: filter, verbose: true, wait: false }).catch((e) => ({ error: e.message })),
      ]);
      const total = (r, key) => (r?.error ? { error: r.error } : { count: (r?.studies || []).reduce((n, st) => n + (st[key] || []).length, 0) });
      // NOT JOINED, deliberately. Measured 2026-09-11: drawing x values
      // (1..867) sit in neither the study's bar-index space (trades 48..20463)
      // nor the series cache's (-20411..302). Placing each drawing's price on
      // the bar at its x put 0% of 504 on a plausible bar as a study index and
      // 4% of 200 as a bars() index — no better than shifted controls. A
      // window filter in either space returns the WRONG drawings while looking
      // right, so none is applied until the primitive index space is identified.
      packet.drawings = {
        joined: false,
        reason: 'x_space_unidentified',
        study_filter: filter,
        centred,
        totals: { lines: total(lines, 'all_lines'), labels: total(labels, 'labels'), boxes: total(boxes, 'all_boxes') },
        note:
          'Drawings are counted, not windowed. Their x coordinate is in TradingView\'s own primitive index space, which ' +
          'is neither the study bar index nor the mainSeries().bars() index; filtering by either returns the wrong drawings. ' +
          'See internals/README.md, "Pine drawing x is in neither known index space".',
      };
    } catch (err) {
      errors.push({ stage: 'drawings', error: err.message });
    }
  } catch (err) {
    errors.push({ stage: 'autopsy', error: err.message });
    packet.ok = false;
    packet.reason = 'internal';
    packet.error = err.message;
  } finally {
    // --- RESTORE. Every path, including the failures above.
    try {
      const now = await captureContext(ev);
      const steps = [];
      if (restored.attempted && before.layout && now.layout !== before.layout) {
        const saved = await listLayouts(ev);
        const back = saved.find((l) => l.name === before.layout);
        if (back) {
          const got = await switchLayout(ev, back.id, before.layout);
          steps.push({ what: 'layout', to: before.layout, verified: got === before.layout });
        } else {
          steps.push({ what: 'layout', to: before.layout, verified: false, error: 'The layout it started on is no longer in the saved list.' });
        }
      }
      const after1 = await captureContext(ev);
      if (before.resolution && after1.resolution !== before.resolution) {
        await ev(`${PATHS.chartApi}.setResolution(${JSON.stringify(before.resolution)}, {})`);
        await requireSettled({ scope: 'strategies', requireSeries: true });
        const after2 = await captureContext(ev);
        steps.push({ what: 'resolution', to: before.resolution, verified: after2.resolution === before.resolution });
      }
      // The view, by time. It is on the AS_FOUND list because it once was not:
      // resolution and layout came back, the chart sat two weeks in the past,
      // and the packet said matches_as_found.
      const want = before.time_range;
      if (want && Number.isFinite(want.from) && Number.isFinite(want.to)) {
        await (_deps?.setVisibleRange || setVisibleRange)({ from: want.from, to: want.to, _deps });
        steps.push({ what: 'visible_range', to: want });
      }
      const final = await captureContext(ev);
      const check = compareAsFound(before, final);
      for (const step of steps) {
        const field = check.fields.find((f) => f.what === step.what);
        if (field && step.verified === undefined) step.verified = field.ok;
      }
      restored.steps = steps;
      restored.final = final;
      // Every field compared, with what was wanted and what was got — the full
      // meaning of matches_as_found, in the packet rather than in a comment.
      restored.as_found = check.fields;
      restored.matches_as_found = check.ok;
      if (!check.ok) {
        const detail = check.fields
          .filter((f) => !f.ok)
          .map((f) => `${f.what}: found ${JSON.stringify(f.want)}, left ${JSON.stringify(f.got)}`)
          .join('; ');
        restored.error = `The chart was NOT returned to the state it was found in — ${detail}. Put it back by hand.`;
        errors.push({ stage: 'restore', error: restored.error });
      }
    } catch (err) {
      restored.error = `Restore threw: ${err.message}. The chart may not be as it was found.`;
      errors.push({ stage: 'restore', error: restored.error });
    }
  }

  packet.restored = restored;
  if (errors.length) packet.errors = errors;
  packet.note =
    'One packet per trade, from a pinned context. layout_pinned says whether the layout was pinned or the packet ' +
    'simply describes whatever was on screen. restored.matches_as_found is the one field to check before trusting ' +
    'that the chart was put back.';
  return packet;
}
