/**
 * Phase 0.6 Task 6, stage A — arm the replay session's capital / currency /
 * commission EXPLICITLY, and verify each one read back.
 *
 * WHY EXPLICITLY. Replay defaults commission_type to "percent" while build15
 * models cash_per_contract at 0.11/side. Inheriting the default zeroes the
 * commission and makes every result optimistic, and it breaks reconciliation
 * against the Strategy Tester in a way that would look like an execution defect
 * rather than a configuration one.
 *
 * This also settles assumption A6 — that setValue on a
 * replayStudyStrategyProperties child takes effect at all.
 */
import { evaluate } from '../src/connection.js';

const TARGET = {
  initial_capital: 100000,
  currency: 'USD',
  commission_type: 'cash_per_contract',
  commission_value: 0.11,
};

const JS = `
(async function () {
  function u(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
  var out = { ok: false };
  try {
    var props = await window.TradingViewApi.chart(0).replayStudyStrategyProperties();
    if (!props) { out.error = 'replayStudyStrategyProperties() resolved falsy'; return JSON.stringify(out); }
    var bag = props.childs ? props.childs() : null;
    if (!bag) { out.error = 'no childs() on the property bag'; return JSON.stringify(out); }

    out.available_children = Object.keys(bag);

    var target = ${JSON.stringify(TARGET)};
    out.before = {};
    for (var k in target) { try { out.before[k] = u(bag[k] && bag[k].value()); } catch (e) { out.before[k] = 'ERR:' + String(e && e.message || e); } }

    out.write_errors = {};
    for (var k2 in target) {
      try {
        if (!bag[k2] || typeof bag[k2].setValue !== 'function') { out.write_errors[k2] = 'no setValue'; continue; }
        bag[k2].setValue(target[k2]);
      } catch (e) { out.write_errors[k2] = String(e && e.message || e); }
    }

    await new Promise(function (r) { setTimeout(r, 800); });

    out.after = {};
    for (var k3 in target) { try { out.after[k3] = u(bag[k3] && bag[k3].value()); } catch (e) { out.after[k3] = 'ERR:' + String(e && e.message || e); } }

    // Independent confirmation: the broker's own view of the settings, which is
    // what an order would actually be priced against.
    try {
      var req = null;
      window.webpackChunktradingview.push([[Math.random()], {}, function (r) { req = r; }]);
      var ts = req('822530').tradingService();
      var acc = ts.activeBroker()._brokerConnection._brokerConnection.currentAccountApi();
      out.broker_view = acc.placeOrderCapability._transport.getUserInputSettings();
      out.broker_equity = await acc.equityCapability.getEquity();
    } catch (e) { out.broker_view_error = String(e && e.message || e); }

    out.ok = true;
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return JSON.stringify(out);
})()`;

const raw = await evaluate(JS, { awaitPromise: true });
const r = JSON.parse(raw);

// Report the VERDICT per field, not just the readings.
if (r.ok) {
  r.verdict = {};
  for (const [k, want] of Object.entries(TARGET)) {
    const got = r.after?.[k];
    r.verdict[k] = {
      requested: want,
      read_back: got,
      took: JSON.stringify(got) === JSON.stringify(want),
      was: r.before?.[k],
    };
  }
  r.all_took = Object.values(r.verdict).every((v) => v.took);
}

console.log(JSON.stringify(r, null, 2));
process.exit(r.ok && r.all_took ? 0 : 1);
