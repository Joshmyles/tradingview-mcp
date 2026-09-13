#!/usr/bin/env node
/**
 * Compare two drawing dumps and report what actually differs.
 *
 * Comparing ids alone would pass a chart whose drawings had all moved, so this
 * compares points and properties too. Volatile fields are excluded by name and
 * the exclusions are printed, because a diff that quietly ignores things is the
 * same failure as a tool that quietly reports success.
 *
 * Usage: node scripts/compare-chart-state.mjs <before.json> <after.json>
 */
import { readFileSync } from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('Usage: node scripts/compare-chart-state.mjs <before.json> <after.json>');
  process.exit(2);
}

const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));

// `index` is a bar ordinal: it legitimately shifts when the series reloads or
// replay changes how many bars exist, while time_t/price do not. Excluding it
// is a deliberate decision, stated in the output rather than buried here.
const VOLATILE_POINT_FIELDS = ['index'];
const VOLATILE_PROP_FIELDS = ['zOrderVersion', 'symbolStateVersion'];

function normPoints(points) {
  return (points || []).map((p) => {
    const o = {};
    for (const k of Object.keys(p).sort()) if (!VOLATILE_POINT_FIELDS.includes(k)) o[k] = p[k];
    return o;
  });
}
function normProps(props) {
  const o = {};
  for (const k of Object.keys(props || {}).sort()) if (!VOLATILE_PROP_FIELDS.includes(k)) o[k] = props[k];
  return o;
}

const byId = (dump) => new Map((dump.drawings || []).map((d) => [d.id, d]));
const b = byId(before);
const a = byId(after);

const missing = [...b.keys()].filter((id) => !a.has(id));
const added = [...a.keys()].filter((id) => !b.has(id));
const changed = [];

for (const [id, bd] of b) {
  const ad = a.get(id);
  if (!ad) continue;
  const diffs = [];
  if (bd.toolname !== ad.toolname) diffs.push({ field: 'toolname', before: bd.toolname, after: ad.toolname });
  const bp = JSON.stringify(normPoints(bd.points));
  const ap = JSON.stringify(normPoints(ad.points));
  if (bp !== ap) diffs.push({ field: 'points', before: bp, after: ap });
  const bpr = normProps(bd.properties);
  const apr = normProps(ad.properties);
  for (const k of new Set([...Object.keys(bpr), ...Object.keys(apr)])) {
    if (JSON.stringify(bpr[k]) !== JSON.stringify(apr[k])) {
      diffs.push({ field: `properties.${k}`, before: bpr[k], after: apr[k] });
    }
  }
  if (diffs.length) changed.push({ id, toolname: bd.toolname, diffs });
}

const identical = missing.length === 0 && added.length === 0 && changed.length === 0;

const report = {
  identical,
  before: { file: beforePath, drawings: before.drawings.length, studies: before.studies?.length, alert_labels: before.alert_label_count },
  after: { file: afterPath, drawings: after.drawings.length, studies: after.studies?.length, alert_labels: after.alert_label_count },
  missing,
  added,
  changed,
  excluded_as_volatile: { point_fields: VOLATILE_POINT_FIELDS, property_fields: VOLATILE_PROP_FIELDS },
};

console.log(JSON.stringify(report, null, 2));
process.exit(identical ? 0 : 1);
