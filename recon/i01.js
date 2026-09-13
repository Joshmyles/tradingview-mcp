/**
 * Phase 0.6 Task 1, probe i01 — WHAT drawing surfaces exist, and which of them
 * can produce a definition complete enough to reconstruct a shape by hand.
 *
 * READ-ONLY. Nothing here writes to the chart.
 *
 * Three candidate surfaces, because the widget-level one is known to be lossy:
 *   A  chartWidgetApi.getAllShapes()            -> { id, name } only
 *   B  ...getShapeById(id).getPoints()/getProperties()
 *   C  model().model().dataSources() filtered to line tools -> .state(), which
 *      is TradingView's OWN serialization (what a saved layout stores)
 */
import { evaluate } from '../src/connection.js';

const JS = `
(function () {
  var out = { ok: false, surfaces: {} };
  try {
    var cw = window.TradingViewApi._activeChartWidgetWV.value();
    out.surfaces.chart_widget_present = !!cw;

    // ---- A: the widget API's own shape list
    try {
      var all = cw.getAllShapes();
      out.surfaces.getAllShapes = {
        present: true,
        count: all.length,
        sample: all.slice(0, 3),
        keys_on_entry: all.length ? Object.keys(all[0]) : [],
      };
    } catch (e) { out.surfaces.getAllShapes = { present: false, error: String(e && e.message || e) }; }

    // ---- B: one shape, fully interrogated
    try {
      var all2 = cw.getAllShapes();
      if (all2.length) {
        var sh = cw.getShapeById(all2[0].id);
        var b = { id: all2[0].id, name: all2[0].name, methods: [] };
        for (var k in sh) { if (typeof sh[k] === 'function') b.methods.push(k); }
        try { b.points = sh.getPoints(); } catch (e) { b.points_error = String(e && e.message || e); }
        try { b.props_keys = Object.keys(sh.getProperties() || {}).slice(0, 40); } catch (e) { b.props_error = String(e && e.message || e); }
        out.surfaces.getShapeById = b;
      } else {
        out.surfaces.getShapeById = { note: 'no shapes to interrogate' };
      }
    } catch (e) { out.surfaces.getShapeById = { error: String(e && e.message || e) }; }

    // ---- C: the model's data sources - where line tools actually live
    try {
      var m = cw._chartWidget.model().model();
      var ds = m.dataSources();
      var kinds = {};
      var lineToolCount = 0;
      var firstLineTool = null;
      for (var i = 0; i < ds.length; i++) {
        var s = ds[i];
        var nm = 'unknown';
        try { nm = s.constructor && s.constructor.name || 'anon'; } catch (e) {}
        kinds[nm] = (kinds[nm] || 0) + 1;
        var isLT = false;
        try { isLT = typeof s.toolname === 'string' || (typeof s.isLineTool === 'function' && s.isLineTool()); } catch (e) {}
        if (isLT) {
          lineToolCount++;
          if (!firstLineTool) {
            var f = { ctor: nm, methods: [] };
            try { f.toolname = s.toolname; } catch (e) {}
            try { f.id = s.id(); } catch (e) {}
            for (var k2 in s) { if (typeof s[k2] === 'function') f.methods.push(k2); }
            f.methods = f.methods.slice(0, 80);
            try { f.has_state = typeof s.state === 'function'; } catch (e) {}
            try {
              var st = s.state(true);
              f.state_keys = Object.keys(st);
              f.state_sample = JSON.parse(JSON.stringify(st)).points;
            } catch (e) { f.state_error = String(e && e.message || e); }
            firstLineTool = f;
          }
        }
      }
      out.surfaces.dataSources = {
        total: ds.length,
        kinds: kinds,
        line_tool_count: lineToolCount,
        first_line_tool: firstLineTool,
      };
    } catch (e) { out.surfaces.dataSources = { error: String(e && e.message || e) }; }

    // ---- how many panes, since drawings can live on any of them
    try {
      var panes = cw._chartWidget.model().model().panes();
      out.surfaces.pane_count = panes.length;
      var perPane = [];
      for (var p = 0; p < panes.length; p++) {
        var srcs = panes[p].dataSources();
        var n = 0;
        for (var q = 0; q < srcs.length; q++) {
          try { if (typeof srcs[q].toolname === 'string') n++; } catch (e) {}
        }
        perPane.push({ pane: p, sources: srcs.length, line_tools: n });
      }
      out.surfaces.per_pane = perPane;
    } catch (e) { out.surfaces.panes_error = String(e && e.message || e); }

    out.ok = true;
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return JSON.stringify(out);
})()`;

const raw = await evaluate(JS);
console.log(raw);
process.exit(0);
