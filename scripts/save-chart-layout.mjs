#!/usr/bin/env node
/**
 * Explicitly save the chart layout, and report what actually happened.
 *
 * WHY THIS IS NOT `TradingViewApi.saveChart()`. That call reads as the save and
 * is not one: its body is `saveToJSON(t)` handed to a callback. It serializes
 * and returns; it never reaches the server. Calling it and reporting "layout
 * saved" is precisely the silent-success class this phase exists to remove, so
 * it is named here only to be ruled out.
 *
 * The real path is `_saveChartService.saveExistentChart(before, ok, err)`, which
 * routes to `_doSave` -> `_chartSaver.saveChartSilently`. One caution about
 * `_doSave`, checked before calling rather than after: it assigns
 * `location.href` when `location.pathname === "/chart/"`. On this desktop
 * client the pathname is `/chart/<layoutId>/`, so the branch is unreachable -
 * but it is checked at run time below, and the save is refused if it is not.
 *
 * The result reports the OBSERVED transition, never a bare success.
 */
import { evaluate } from '../src/connection.js';

const SAVE_JS = `
(function () {
  function safe(fn, d) { try { var v = fn(); return (v && typeof v.value === 'function') ? v.value() : v; } catch (e) { return d === undefined ? ('ERR:' + String(e && e.message || e)) : d; } }
  var svc = window.TradingViewApi._saveChartService;
  if (!svc) return Promise.resolve(JSON.stringify({ ok: false, error: 'no _saveChartService' }));

  // The navigation branch in _doSave is a hazard, not a hypothetical. Refuse
  // rather than risk navigating the chart away mid-phase.
  if (location.pathname === '/chart/') {
    return Promise.resolve(JSON.stringify({
      ok: false,
      error: 'REFUSING: location.pathname is "/chart/", where _doSave assigns location.href and would navigate.',
    }));
  }

  var before = {
    layout_id: safe(function () { return svc.layoutId(); }),
    auto_save_enabled: safe(function () { return svc.autoSaveEnabled(); }),
    has_changes: safe(function () { return svc.hasChanges(); }),
    change_count: safe(function () { return svc.changes(); }),
  };

  return new Promise(function (resolve) {
    var settled = false;
    function done(outcome, detail) {
      if (settled) return;
      settled = true;
      var after = {
        has_changes: safe(function () { return svc.hasChanges(); }),
        change_count: safe(function () { return svc.changes(); }),
      };
      resolve(JSON.stringify({ ok: outcome === 'saved', outcome: outcome, detail: detail || null, before: before, after: after }));
    }
    // A save that never calls back is a failure, not a success. Ten seconds is
    // a network round trip with room to spare; a hang must surface as a hang.
    setTimeout(function () { done('timeout', 'neither the success nor the error callback fired within 10000ms'); }, 10000);
    try {
      svc.saveExistentChart(undefined, function (res) {
        done('saved', res && res.uid ? ('server uid ' + res.uid) : 'success callback fired');
      }, function () {
        done('error', 'the save service reported an error');
      });
    } catch (e) {
      done('threw', String(e && e.message || e));
    }
  });
})()`;

const raw = await evaluate(SAVE_JS, { awaitPromise: true });
const r = JSON.parse(raw);
console.log(JSON.stringify(r, null, 2));

if (!r.ok) {
  console.error(`\nLayout save did NOT complete: ${r.outcome} — ${r.detail}`);
  process.exit(1);
}
console.log('\nLayout saved; the save service ran its success path.');
process.exit(0);
