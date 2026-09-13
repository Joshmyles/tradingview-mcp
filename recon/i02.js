/**
 * Phase 0.6 Task 1, probe i02 — reconcile the two counts.
 *
 * i01: getAllShapes() = 5, but one constructor ("Ae") has 29 instances, and 29
 * is the drawing count Phase 0.5 recorded. One of those numbers is drawings and
 * the other is not; this probe decides which by looking at what the objects ARE
 * rather than by trusting either count.
 *
 * READ-ONLY.
 */
import { evaluate } from '../src/connection.js';

const JS = `
(function () {
  var out = { ok: false };
  function safe(fn, d) { try { return fn(); } catch (e) { return d === undefined ? ('ERR:' + String(e && e.message || e)) : d; } }
  try {
    var cw = window.TradingViewApi._activeChartWidgetWV.value();
    var m = cw._chartWidget.model().model();
    var panes = m.panes();
    var rows = [];
    for (var p = 0; p < panes.length; p++) {
      var srcs = panes[p].dataSources();
      for (var i = 0; i < srcs.length; i++) {
        var s = srcs[i];
        var r = { pane: p, idx: i };
        r.ctor = safe(function () { return s.constructor && s.constructor.name; }, 'anon');
        r.id = safe(function () { return String(s.id()); });
        r.toolname = safe(function () { return s.toolname; }, null);
        r.hasPoints = safe(function () { return typeof s.points === 'function'; }, false);
        r.hasState = safe(function () { return typeof s.state === 'function'; }, false);
        r.isLineTool = safe(function () { return typeof s.isLineTool === 'function' ? s.isLineTool() : null; }, null);
        r.title = safe(function () { return typeof s.title === 'function' ? String(s.title()) : null; }, null);
        r.nPoints = safe(function () { return typeof s.points === 'function' ? s.points().length : null; }, null);
        rows.push(r);
      }
    }
    out.rows = rows;

    // group by constructor to see what each family is
    var byCtor = {};
    for (var j = 0; j < rows.length; j++) {
      var c = rows[j].ctor;
      if (!byCtor[c]) byCtor[c] = { count: 0, sample: rows[j], toolnames: {} };
      byCtor[c].count++;
      var tn = String(rows[j].toolname);
      byCtor[c].toolnames[tn] = (byCtor[c].toolnames[tn] || 0) + 1;
    }
    out.by_ctor = byCtor;

    // The authoritative line-tool list, if the model exposes one
    out.model_apis = {};
    for (var k in m) { if (typeof m[k] === 'function' && /line|tool|shape|draw/i.test(k)) out.model_apis[k] = true; }

    // selection / group models often enumerate drawings authoritatively
    out.lineToolsGroupModel = safe(function () {
      var g = m.lineToolsGroupModel();
      return { present: !!g, groups: g.groups().length };
    });

    out.getAllShapes_count = safe(function () { return cw.getAllShapes().length; });
    out.getAllShapes = safe(function () { return cw.getAllShapes(); });
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  out.ok = true;
  return JSON.stringify(out);
})()`;

console.log(await evaluate(JS));
process.exit(0);
