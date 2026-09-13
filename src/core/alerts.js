/**
 * Core alert logic.
 *
 * Alerts are created / listed / deleted through TradingView's pricealerts REST API
 * (https://pricealerts.tradingview.com) using the desktop app's authenticated session.
 * Requests are sent as text/plain so the browser does not issue a CORS preflight that
 * the endpoint rejects. The create/delete bodies must be wrapped in a `payload` object.
 */
import { evaluate, evaluateAsync, safeString, requireFinite } from '../connection.js';
import { answered, failed, observed, refused, unobservable } from '../internals/verdict.js';

// Map the tool's friendly condition names to TradingView's alert condition types.
const CONDITION_TYPE_MAP = {
  crossing: 'cross', cross: 'cross',
  greater_than: 'greater', greater: 'greater', above: 'greater', '>': 'greater',
  less_than: 'less', less: 'less', below: 'less', '<': 'less',
};

export async function create({ condition, price, message }) {
  const p = requireFinite(price, 'price');
  const condType = CONDITION_TYPE_MAP[String(condition || 'crossing').trim().toLowerCase()] || 'cross';

  const result = await evaluate(`
    (function() {
      try {
        var ms = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
        var sym = (ms.proSymbol && ms.proSymbol()) || (ms.symbol && ms.symbol());
        if (!sym) return { success: false, error: 'Could not read current chart symbol from TradingView' };
        var price = ${JSON.stringify(p)};
        var condType = ${safeString(condType)};
        var msg = ${safeString(message || '')};
        if (!msg) {
          var verb = condType === 'greater' ? 'above' : (condType === 'less' ? 'below' : 'crossing');
          msg = sym.split(':').pop() + ' ' + verb + ' ' + price;
        }
        var cond = { type: condType, frequency: 'on_first_fire', series: [{ type: 'barset' }, { type: 'value', value: price }], resolution: '1' };
        var payload = {
          conditions: [cond],
          symbol: '={"symbol":"' + sym + '"}',
          resolution: '1',
          message: msg,
          sound_file: 'alert/fired', sound_duration: 0,
          popup: true, auto_deactivate: true,
          email: false, sms_over_email: false, mobile_push: true,
          web_hook: null, name: null,
          expiration: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          active: true, ignore_warnings: true
        };
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/create_alert', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: payload }));
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) {}
        if (data.s === 'ok') {
          return { success: true, source: 'internal_api', symbol: sym, price: price, condition: condType, message: msg, alert_id: (data.r && data.r.alert_id) || null };
        }
        return { success: false, source: 'internal_api', error: (data.err && data.err.code) || data.errmsg || ('HTTP ' + x.status), response: (x.responseText || '').slice(0, 200) };
      } catch (e) {
        return { success: false, source: 'internal_api', error: e.message };
      }
    })()
  `);

  if (!result?.success) {
    const error = result?.error || 'the page returned nothing';
    return refused(`create_alert was not accepted: ${error}`, {
      source: result?.source || 'internal_api',
      error,
      ...(result?.response !== undefined && { response: result.response }),
    });
  }
  const created = {
    source: result.source, symbol: result.symbol, price: result.price,
    condition: result.condition, message: result.message, alert_id: result.alert_id,
  };
  // The server's "s: ok" is an acknowledgement, not the alert. Look for it.
  if (created.alert_id == null) {
    return unobservable('create_alert was acknowledged without an alert_id, so the new alert cannot be looked up', created);
  }
  const listed = await list();
  if (!listed.ok) {
    return unobservable(`create_alert was acknowledged but list_alerts could not be read back: ${listed.error}`, created);
  }
  const found = listed.alerts.find((a) => String(a.alert_id) === String(created.alert_id));
  if (!found) {
    return refused(
      `alert ${created.alert_id} is not in list_alerts after create_alert acknowledged it`,
      { ...created, alert_count: listed.alert_count },
    );
  }
  return observed({ alert_id: found.alert_id, listed_active: found.active ?? null }, created);
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  const detail = { alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [] };
  // An empty list with an error is not "no alerts"; it is no answer.
  if (result?.error) return failed('unavailable', { ...detail, error: result.error });
  return answered(detail);
}

export async function deleteAlerts({ delete_all, alert_ids, alert_id } = {}) {
  // Resolve the set of alert ids to delete.
  let ids = [];
  if (Array.isArray(alert_ids)) ids = ids.concat(alert_ids);
  if (alert_id != null) ids.push(alert_id);
  if (delete_all) {
    const listed = await list();
    if (!listed.ok) {
      return failed(listed.reason, { source: 'internal_api', error: `Could not list alerts to delete: ${listed.error}` });
    }
    ids = (listed.alerts || []).map((a) => a.alert_id);
  }
  ids = ids.filter((x) => x != null);
  if (!ids.length) {
    return delete_all
      ? failed('not_found', { source: 'internal_api', error: 'No alerts to delete.' })
      : failed('invalid_argument', { source: 'internal_api', error: 'Provide delete_all: true or an alert_id to delete.' });
  }

  const result = await evaluate(`
    (function() {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/delete_alerts', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } }));
        var data = {}; try { data = JSON.parse(x.responseText); } catch (e) {}
        return { ok: data.s === 'ok', status: x.status, response: (x.responseText || '').slice(0, 200) };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (!(result && result.ok)) {
    const error = (result && (result.error || result.response)) || 'delete failed';
    return refused(`delete_alerts was not accepted: ${error}`, { source: 'internal_api', alert_ids: ids, error });
  }
  // The server's acknowledgement is not the deletion. List again and look.
  const detail = { source: 'internal_api', deleted_count: ids.length, alert_ids: ids };
  const after = await list();
  if (!after.ok) {
    return unobservable(`delete_alerts was acknowledged but list_alerts could not be read back: ${after.error}`, detail);
  }
  const stillListed = ids.filter((id) => after.alerts.some((a) => String(a.alert_id) === String(id)));
  if (stillListed.length) {
    return refused(
      `${stillListed.length} alert(s) still listed after delete_alerts: ${stillListed.join(', ')}`,
      { ...detail, still_listed: stillListed },
    );
  }
  return observed({ still_listed: [], alerts_remaining: after.alert_count }, detail);
}
