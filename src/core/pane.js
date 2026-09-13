/**
 * Core pane/layout management logic.
 * Controls multi-chart layouts (split panes) in TradingView.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';
import { answered, observed, refused, unobservable } from '../internals/verdict.js';

const CWC = 'window.TradingViewApi._chartWidgetCollection';

const LAYOUT_NAMES = {
  's': '1 chart',
  '2h': '2 horizontal',
  '2v': '2 vertical',
  '2-1': '2 top, 1 bottom',
  '1-2': '1 top, 2 bottom',
  '3h': '3 horizontal',
  '3v': '3 vertical',
  '3s': '3 custom',
  '4': '2x2 grid',
  '4h': '4 horizontal',
  '4v': '4 vertical',
  '4s': '4 custom',
  '6': '6 charts',
  '8': '8 charts',
  '10': '10 charts',
  '12': '12 charts',
  '14': '14 charts',
  '16': '16 charts',
};

/**
 * How many charts each layout code must produce.
 *
 * Derived from the layout names above rather than guessed: setLayout() reports
 * nothing at all, so without an expected count there is nothing to compare the
 * post-change reading against, and "I asked for a 2x2 grid" would keep passing
 * for a collection that stayed on one chart.
 */
const EXPECTED_CHART_COUNT = {
  's': 1,
  '2h': 2, '2v': 2,
  '2-1': 3, '1-2': 3, '3h': 3, '3v': 3, '3s': 3,
  '4': 4, '4h': 4, '4v': 4, '4s': 4,
  '6': 6, '8': 8, '10': 10, '12': 12, '14': 14, '16': 16,
};

/**
 * List all panes in the current layout with their symbols and index.
 */
export async function list() {
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var layoutType = cwc._layoutType;
      if (typeof layoutType === 'object' && layoutType && typeof layoutType.value === 'function') layoutType = layoutType.value();
      var count = cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();

      var all = cwc.getAll();
      var panes = [];
      for (var i = 0; i < all.length; i++) {
        try {
          var c = all[i];
          var model = c.model ? c.model() : null;
          var mainSeries = model ? model.mainSeries() : null;
          var sym = mainSeries ? mainSeries.symbol() : 'unknown';
          var res = mainSeries ? mainSeries.interval() : null;
          panes.push({ index: i, symbol: sym, resolution: res || null });
        } catch(e) { panes.push({ index: i, error: e.message }); }
      }

      // Check which pane is active
      var activeChart = window.TradingViewApi._activeChartWidgetWV.value();
      var activeIndex = null;
      for (var j = 0; j < all.length; j++) {
        try {
          if (all[j].model && activeChart._chartWidget && all[j] === activeChart._chartWidget) { activeIndex = j; break; }
        } catch(e) {}
      }

      return { layout: layoutType, chart_count: count, active_index: activeIndex, panes: panes };
    })()
  `);

  return answered({
    layout: result.layout,
    layout_name: LAYOUT_NAMES[result.layout] || result.layout,
    chart_count: result.chart_count,
    active_index: result.active_index,
    panes: result.panes,
  });
}

/**
 * Set the chart layout grid.
 * @param {string} layout - Layout code: s, 2h, 2v, 2-1, 1-2, 3h, 3v, 4, 6, 8, etc.
 */
export async function setLayout({ layout }) {
  const code = layout.toLowerCase().replace(/\s+/g, '');

  // Map friendly names to codes
  const aliases = {
    'single': 's', '1': 's', '1x1': 's',
    '2x1': '2h', '1x2': '2v',
    '2x2': '4', 'grid': '4', 'quad': '4',
    '3x1': '3h', '1x3': '3v',
  };
  const resolved = aliases[code] || code;

  if (!LAYOUT_NAMES[resolved]) {
    const available = Object.entries(LAYOUT_NAMES).map(([k, v]) => `  ${k} — ${v}`).join('\n');
    throw new Error(`Unknown layout "${layout}". Available layouts:\n${available}`);
  }

  await evaluateAsync(`${CWC}.setLayout(${safeString(resolved)})`);
  await new Promise(r => setTimeout(r, 500));

  const state = await list();
  // setLayout() is silent about a layout the collection declines, so the
  // re-read below was being reported without ever being compared.
  const expected = EXPECTED_CHART_COUNT[resolved];
  if (expected !== undefined && state.chart_count !== expected) {
    return refused(
      `layout "${resolved}" (${LAYOUT_NAMES[resolved]}) should hold ${expected} chart(s) but the collection reports ${state.chart_count}`,
      { layout: resolved, layout_name: LAYOUT_NAMES[resolved], chart_count: state.chart_count, panes: state.panes },
    );
  }
  return observed(
    { chart_count: state.chart_count },
    { layout: resolved, layout_name: LAYOUT_NAMES[resolved], panes: state.panes },
  );
}

/**
 * Focus a specific pane by index.
 */
export async function focus({ index }) {
  const idx = Number(index);
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      if (${idx} >= all.length) return { error: 'Pane index ' + ${idx} + ' out of range (have ' + all.length + ' panes)' };
      var chart = all[${idx}];
      // Click the main div to activate it
      if (chart._mainDiv) chart._mainDiv.click();
      return { focused: ${idx}, total: all.length };
    })()
  `);

  if (result?.error) throw new Error(result.error);
  // Clicking _mainDiv is a request to focus, not a focus. Read which chart the
  // collection now considers active.
  const activeIdx = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      var active = cwc.activeChartWidget ? cwc.activeChartWidget.value() : null;
      for (var i = 0; i < all.length; i++) { if (all[i] === active) return i; }
      return null;
    })()
  `);
  if (activeIdx === null || activeIdx === undefined) {
    return unobservable(
      'this build exposes no readable active-pane index, so focus was requested but not confirmed',
      { focused_index: result.focused, total_panes: result.total },
    );
  }
  if (Number(activeIdx) !== idx) {
    return refused(
      `pane ${activeIdx} is active after clicking pane ${idx}`,
      { requested_index: idx, active_index: Number(activeIdx), total_panes: result.total },
    );
  }
  return observed({ active_index: Number(activeIdx) }, { focused_index: idx, total_panes: result.total });
}

/**
 * Set the symbol on a specific pane by index.
 * Works by focusing the pane, then using the active chart's setSymbol.
 */
export async function setSymbol({ index, symbol }) {
  const idx = Number(index);

  // Focus the target pane first
  await focus({ index: idx });
  await new Promise(r => setTimeout(r, 300));

  // Now set symbol on the now-active chart
  await evaluateAsync(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);

  // The symbol the pane ACTUALLY carries, not the one that was asked for.
  const actual = await evaluate(`
    (function() {
      try {
        var cwc = ${CWC};
        var all = cwc.getAll();
        var c = all[${idx}];
        return String(c.model().mainSeries().symbol());
      } catch (e) { return null; }
    })()
  `);
  if (actual === null) {
    return unobservable(
      `the symbol on pane ${idx} could not be read back, so the change was requested but not confirmed`,
      { index: idx, symbol },
    );
  }
  // TradingView normalises symbols (XAUUSD -> ICMARKETS:XAUUSD), so compare on
  // the bare ticker rather than demanding an exact string match.
  const bare = (x) => String(x).split(':').pop().toUpperCase();
  if (bare(actual) !== bare(symbol)) {
    return refused(
      `pane ${idx} carries "${actual}" after setSymbol("${symbol}")`,
      { index: idx, requested: symbol, actual },
    );
  }
  return observed({ symbol_now: actual }, { index: idx, symbol });
}
