#!/usr/bin/env node
/**
 * Dump every drawing on the live chart to a timestamped file, in enough detail
 * to rebuild each one by hand.
 *
 * THIS IS INSURANCE, NOT A RESTORE MECHANISM. It reads and writes a file. It
 * has no counterpart that puts anything back, deliberately: a half-working
 * automatic restore invites a reload nobody checked, and rebuilding five
 * drawings by hand from a complete record is a smaller risk than trusting a
 * replay path that has never been exercised.
 *
 * READ-ONLY against the chart. Nothing here mutates chart state.
 *
 * WHAT COUNTS AS A DRAWING, measured 2026-09-12 rather than assumed. The
 * widget API's getAllShapes() and the model's line-tool set agree at 5, and the
 * saved-layout serialization (model().state(true)) lists exactly the same five
 * under panes[].sources[]. The "29" carried into the Phase 0.5 report is a
 * different family entirely - 29 AlertLabel sources, one per active alert, which
 * are rendered from the alert service and are NOT part of the saved layout.
 * They are inventoried here as context so the discrepancy stays visible, but
 * they are not drawings and a reload does not put them at risk.
 *
 * Usage: node scripts/dump-chart-state.mjs [outDir]
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from '../src/connection.js';

const DUMP_JS = `
(function () {
  function safe(fn, d) { try { return fn(); } catch (e) { return d === undefined ? { __error: String(e && e.message || e) } : d; } }
  var out = { ok: false, captured_at: new Date().toISOString() };
  try {
    var cw = window.TradingViewApi._activeChartWidgetWV.value();
    var mw = cw._chartWidget.model();
    var m = mw.model();

    // ---- chart identity, so a dump can never be applied to the wrong chart
    out.chart = {
      symbol: safe(function () { return String(m.mainSeries().symbol()); }),
      resolution: safe(function () { return String(m.mainSeries().interval()); }),
      timezone: safe(function () { return String(m.timezone()); }),
      pane_count: safe(function () { return m.panes().length; }),
    };

    // ---- THE DRAWINGS. Three independent renderings of the same five objects,
    //      kept side by side so a disagreement between them is visible rather
    //      than silently resolved in favour of whichever was read last.
    var drawings = [];
    var panes = m.panes();
    for (var p = 0; p < panes.length; p++) {
      var srcs = panes[p].dataSources();
      for (var i = 0; i < srcs.length; i++) {
        var s = srcs[i];
        var toolname = safe(function () { return s.toolname; }, null);
        if (typeof toolname !== 'string' || toolname.indexOf('LineTool') !== 0) continue;
        var d = { pane: p, toolname: toolname };
        d.id = safe(function () { return String(s.id()); });
        d.title = safe(function () { return typeof s.title === 'function' ? String(s.title()) : null; }, null);
        // (1) TradingView's own serialization - what a saved layout stores.
        d.state = safe(function () { return JSON.parse(JSON.stringify(s.state(true))); });
        // (2) the model's live points, in chart coordinates
        d.points = safe(function () { return JSON.parse(JSON.stringify(s.points())); });
        // (3) resolved property values
        d.properties = safe(function () {
          var ps = s.properties();
          return JSON.parse(JSON.stringify(typeof ps.state === 'function' ? ps.state() : ps));
        });
        d.z_order = safe(function () { return s.zorder(); }, null);
        drawings.push(d);
      }
    }
    out.drawings = drawings;

    // ---- widget-API cross-check of the same set
    out.widget_api_shapes = safe(function () {
      return cw.getAllShapes().map(function (sh) {
        var rec = { id: sh.id, name: sh.name };
        var h = safe(function () { return cw.getShapeById(sh.id); }, null);
        if (h) {
          rec.points = safe(function () { return h.getPoints(); });
          rec.properties = safe(function () { return JSON.parse(JSON.stringify(h.getProperties())); });
          rec.visible = safe(function () { return h.isVisible(); }, null);
          rec.locked = safe(function () { return h.isLocked(); }, null);
        }
        return rec;
      });
    });

    // ---- CONTEXT, not drawings: studies and alert labels, so the post-reload
    //      comparison can tell "a drawing went missing" from "an alert redrew".
    var studies = [], alertLabels = 0;
    for (var p2 = 0; p2 < panes.length; p2++) {
      var ss = panes[p2].dataSources();
      for (var j = 0; j < ss.length; j++) {
        var src = ss[j];
        var st = safe(function () { var x = src.state(true); return x && x.type; }, null);
        if (st === 'AlertLabel') { alertLabels++; continue; }
        if (st === 'Study' || st === 'StudyStrategy') {
          studies.push({
            pane: p2,
            type: st,
            id: safe(function () { return String(src.id()); }),
            title: safe(function () { return String(src.title()); }),
          });
        }
      }
    }
    out.studies = studies;
    out.alert_label_count = alertLabels;

    // ---- the layout's own saved shape, for the record
    out.layout_source_types = safe(function () {
      var st = m.state(true);
      var types = {};
      for (var a = 0; a < st.panes.length; a++) {
        var sr = st.panes[a].sources || [];
        for (var b = 0; b < sr.length; b++) { var t = sr[b].type || 'undefined'; types[t] = (types[t] || 0) + 1; }
      }
      return types;
    });

    out.ok = true;
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return JSON.stringify(out);
})()`;

const outDir = process.argv[2] || join(process.cwd(), 'recon', 'chart-state');
mkdirSync(outDir, { recursive: true });

const raw = await evaluate(DUMP_JS);
if (typeof raw !== 'string' || raw.length === 0) {
  console.error('REFUSING: the page returned no dump payload at all.');
  process.exit(1);
}

let dump;
try {
  dump = JSON.parse(raw);
} catch (err) {
  console.error(`REFUSING: the dump payload did not parse: ${err.message}`);
  process.exit(1);
}

// ---- The verification the brief asks for, BEFORE anything is called a backup.
//      A dump that silently captured nothing is the failure this phase is about,
//      so each of these is a hard exit rather than a warning.
const problems = [];
if (dump.ok !== true) problems.push(`the page reported failure: ${dump.error || 'no reason given'}`);
if (!Array.isArray(dump.drawings)) problems.push('drawings is not an array');
else if (dump.drawings.length === 0) problems.push('zero drawings captured');
else {
  dump.drawings.forEach((d, i) => {
    if (!d.id) problems.push(`drawing[${i}] has no id`);
    if (!d.toolname) problems.push(`drawing[${i}] has no toolname`);
    if (!d.state || d.state.__error) problems.push(`drawing[${i}] (${d.id}) has no usable state: ${d.state?.__error || 'missing'}`);
    if (!Array.isArray(d.points) || d.points.length === 0) problems.push(`drawing[${i}] (${d.id}) has no points`);
    if (!d.properties || d.properties.__error) problems.push(`drawing[${i}] (${d.id}) has no properties`);
  });
}
// The two independent enumerations must agree, or we do not know what we have.
const modelIds = (dump.drawings || []).map((d) => d.id).sort();
const widgetIds = (dump.widget_api_shapes || []).map((s) => s.id).sort();
if (JSON.stringify(modelIds) !== JSON.stringify(widgetIds)) {
  problems.push(`the model and the widget API disagree on the drawing set: model=${JSON.stringify(modelIds)} widget=${JSON.stringify(widgetIds)}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(outDir, `drawings-${stamp}.json`);

if (problems.length) {
  console.error('REFUSING to treat this as a backup. Problems:');
  for (const p of problems) console.error(`  - ${p}`);
  // Still write it, clearly marked, so the failure itself is inspectable.
  writeFileSync(file.replace(/\.json$/, '.REJECTED.json'), JSON.stringify(dump, null, 2));
  console.error(`\nThe rejected payload was written to ${file.replace(/\.json$/, '.REJECTED.json')} for inspection.`);
  process.exit(1);
}

writeFileSync(file, JSON.stringify(dump, null, 2));

// Re-read from disk and re-parse: "it parsed in memory" is not the claim being
// made, "there is a readable file on disk" is.
const reread = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(reread.drawings) || reread.drawings.length !== dump.drawings.length) {
  console.error('REFUSING: the file on disk does not read back as what was written.');
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  file,
  bytes: readFileSync(file, 'utf8').length,
  verified: 'reread from disk, parsed, drawing count matches',
  chart: dump.chart,
  drawing_count: reread.drawings.length,
  drawings: reread.drawings.map((d) => ({ id: d.id, toolname: d.toolname, points: d.points.length })),
  studies: dump.studies.length,
  alert_labels_not_drawings: dump.alert_label_count,
  layout_source_types: dump.layout_source_types,
}, null, 2));
process.exit(0);
