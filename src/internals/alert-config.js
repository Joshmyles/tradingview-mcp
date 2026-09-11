/**
 * The configuration a strategy alert actually runs.
 *
 * INTERNAL — see paths.js. Re-verify after every TradingView update.
 *
 * A strategy alert does not point at the study on the chart. It carries its
 * OWN frozen copy of the script's configuration, taken when it was created,
 * and runs that until it is deleted and recreated. Measured 2026-09-11 via
 * `pricealerts.tradingview.com/list_alerts`:
 *
 *   type: 'strategy'
 *   condition.series[0] = { type: 'study', study: 'StrategyScript@tv-scripting-101',
 *                           pine_id, pine_version, inputs: { id: value, ... } }
 *
 * The active B14 alert `5574059086` held 358 keys at `pine_version 0.43`
 * against the chart's `0.46`; the inactive `5500389832` held 315 at `0.27`.
 * `inputs` is keyed by the SAME positional `in_N` ids as the study, plus host
 * keys (`__chart_bgcolor`, `__log_level`, `text`, ...) that are not settings.
 *
 * So there are three configurations that can differ at once — the chart, a
 * backtest, and live — and only this map describes live orders. Nothing here
 * writes; recreating an alert is a live-execution change on a broker-attached
 * account and belongs to its owner.
 */

/** Only positional script inputs are configuration; host keys are not. */
const INPUT_ID = /^in_[0-9]+$/;

/**
 * Pull the frozen configuration out of every strategy alert.
 *
 * `alerts` is the row list from core/alerts.js `list()`. Returns one entry per
 * strategy alert, with the input map reduced to `in_N` ids so it can be
 * compared against a manifest the same way the chart is.
 */
export function strategyAlertConfigs(alerts) {
  const out = [];
  for (const a of alerts || []) {
    if (a?.type !== 'strategy') continue;
    const series = (a.condition?.series || []).find((s) => s?.type === 'study');
    if (!series) continue;
    const raw = series.inputs && typeof series.inputs === 'object' ? series.inputs : {};
    const inputs = {};
    for (const [k, v] of Object.entries(raw)) if (INPUT_ID.test(k)) inputs[k] = v;
    out.push({
      alert_id: a.alert_id,
      active: a.active === true,
      symbol: a.symbol,
      resolution: a.resolution,
      pine_id: series.pine_id ?? null,
      pine_version: series.pine_version ?? null,
      input_count: Object.keys(inputs).length,
      inputs,
    });
  }
  return out;
}
