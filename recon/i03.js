/**
 * Phase 0.6 Task 1, probe i03 — identify the 29 "Ae" sources and the 11 "ji"
 * sources, and establish the AUTHORITATIVE drawing set.
 *
 * i02 showed the only sources carrying a LineTool* toolname are 5: two
 * risk/reward positions, one trend line, two callouts — exactly the 5
 * getAllShapes() reports. So the "29 drawings" figure carried into Phase 0.5 is
 * suspect. This probe names all 29 so the correction is evidence, not assertion.
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
    var ae = [], ji = [], tools = [];
    for (var p = 0; p < panes.length; p++) {
      var srcs = panes[p].dataSources();
      for (var i = 0; i < srcs.length; i++) {
        var s = srcs[i];
        var ctor = safe(function () { return s.constructor && s.constructor.name; }, 'anon');
        var rec = {
          pane: p,
          id: safe(function () { return String(s.id()); }),
          title: safe(function () { return typeof s.title === 'function' ? String(s.title()) : null; }, null),
          toolname: safe(function () { return s.toolname; }, null),
          isStudy: safe(function () { return typeof s.isStudy === 'function' ? s.isStudy() : null; }, null),
          stateType: safe(function () { var st = s.state(true); return st && st.type; }, null),
        };
        if (ctor === 'Ae') ae.push(rec);
        else if (ctor === 'ji') ji.push(rec);
        if (rec.toolname && String(rec.toolname).indexOf('LineTool') === 0) tools.push(rec);
      }
    }
    out.Ae = ae;
    out.ji = ji;
    out.line_tools = tools;
    out.counts = { Ae: ae.length, ji: ji.length, line_tools: tools.length };

    // Cross-check against the widget API's own shape list
    out.getAllShapes = safe(function () { return cw.getAllShapes(); });

    // And against the SAVED-LAYOUT serialization, which is the ground truth for
    // "what a reload would restore".
    out.saved_state_probe = safe(function () {
      var st = cw._chartWidget.model().model().state(true);
      var keys = Object.keys(st);
      var res = { keys: keys };
      // panes[].sources[] is where a saved layout keeps both studies and drawings
      if (st.panes) {
        res.panes = st.panes.length;
        var srcTypes = {};
        for (var a = 0; a < st.panes.length; a++) {
          var ss = st.panes[a].sources || [];
          for (var b = 0; b < ss.length; b++) {
            var t = ss[b].type || 'undefined';
            srcTypes[t] = (srcTypes[t] || 0) + 1;
          }
        }
        res.source_types = srcTypes;
      }
      return res;
    });
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  out.ok = true;
  return JSON.stringify(out);
})()`;

console.log(await evaluate(JS));
process.exit(0);
