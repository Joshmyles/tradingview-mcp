#!/usr/bin/env node
/**
 * Record an IDENTITY manifest of the strategy currently on the chart.
 *
 *   node scripts/make-live-manifest.mjs b15 manifests/b15.manifest.json
 *
 * ── HOW THIS DIFFERS FROM make-manifest.mjs, AND WHY BOTH EXIST ─────────────
 *
 * `make-manifest.mjs` derives a REFERENCE configuration from the Pine source
 * and refuses to look at the chart, because a reference built from the chart
 * cannot catch the chart being wrong. That argument is correct and it still
 * stands; this script is not a replacement for it.
 *
 * This one answers a different question: not "is the configuration the one I
 * intended" but "is the PROGRAM on the chart still the program I measured".
 * That question can only be answered against the chart, because the thing it
 * is checking is the chart. Two facts force it:
 *
 *   1. Entity id and pine id are NOT identity. Slot `xVbiv5` /
 *      `USER;e003abfb1017423c8f9137fd2c9ffd95` has now carried three different
 *      programs: B14 (pine v0.46, 351 inputs), "Base 2.0.36" (v0.49, 25
 *      inputs) and Build 15 (v0.51, 353 inputs). Every one of them answered to
 *      the same ids. An identity check built on ids is a false pass waiting to
 *      happen; it has to be content-based.
 *   2. Input ids are POSITIONAL. Deleting one `input.*` call renumbers every
 *      input after it, so a manifest is only meaningful against the exact
 *      source revision it was taken from — which is why the source SHA-256 is
 *      recorded here, and why the script refuses when the source's declared
 *      ids do not line up with the chart's.
 *
 * THE SOURCE CROSS-CHECK IS THE POINT. A live snapshot on its own records
 * whatever happens to be loaded, wrong program included. This script pairs the
 * snapshot with the repo's Pine source and refuses unless EVERY declared input
 * id and name matches the chart, one for one. Only then is the pairing written
 * down, and the manifest can then claim that this hash means this source.
 *
 * Writes nothing to the chart. Reads only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { pineInputsSnapshot } from '../src/core/pine-inputs.js';
import { parseInputDeclarations } from '../src/internals/pine-source.js';
import { assertReplayEnvironment } from '../src/internals/invariants.js';

const SOURCES = {
  b15: {
    title: 'B15',
    description: 'Build 15',
    source_file: '../../second round/build 7.0/build15.pine',
  },
};

const build = (process.argv[2] || 'b15').toLowerCase();
const outPath = resolve(process.argv[3] || `manifests/${build}.manifest.json`);
const spec = SOURCES[build];
if (!spec) {
  console.error(`No source mapping for build "${build}". Add one to SOURCES.`);
  process.exit(1);
}

// The environment check first: a manifest taken from an ambiguous chart would
// record whichever study won a coin toss.
const env = await assertReplayEnvironment({ expectStrategyTitle: spec.description });
console.error(`env ok: ${env.layout} | ${env.symbol} ${env.resolution} | strategy ${env.strategy.entity_id}`);

const snap = await pineInputsSnapshot({ entityId: env.strategy.entity_id, include: ['all', 'manifest'] });
if (!snap.ok) {
  console.error(`REFUSING: snapshot failed: ${snap.error}`);
  process.exit(1);
}

const sourcePath = resolve(outPath, '..', spec.source_file);
const source = readFileSync(sourcePath, 'utf8');
const decls = parseInputDeclarations(source);

// One-for-one, id AND name. A name difference at a matching id is the exact
// signature of a source revision that no longer matches the compiled program.
const liveById = new Map(snap.inputs.map((i) => [i.id, i]));
const drift = [];
for (const d of decls) {
  const live = liveById.get(d.id);
  const want = (d.title ?? d.name ?? '').trim();
  if (!live) { drift.push(`${d.id}: declared in source, absent from the chart`); continue; }
  const got = (live.name ?? '').trim();
  if (want !== got) drift.push(`${d.id}: source "${want}" vs chart "${got}"`);
}
if (drift.length) {
  console.error(`REFUSING: ${drift.length} input(s) differ between ${relative(process.cwd(), sourcePath)} and the chart:`);
  for (const d of drift.slice(0, 20)) console.error(`  ${d}`);
  console.error('The repo source is not the program on the chart. Export the chart\'s script to the repo, or load the repo\'s source onto the chart, before recording a manifest.');
  process.exit(1);
}

// Ids the chart carries that the source does not declare are TradingView's
// strategy properties (initial capital, commission, pyramiding, ...). They are
// real configuration and they are pinned, but they are labelled separately
// because they cannot be derived from or checked against the Pine source.
const declaredIds = new Set(decls.map((d) => d.id));
const properties = snap.inputs.filter((i) => !declaredIds.has(i.id));

const manifest = {
  build,
  title: snap.title,
  description: spec.description,
  state: 'as-found-live',
  note:
    'IDENTITY manifest of the strategy as it stands on the chart, cross-checked against the repo Pine source. '
    + 'manifest_hash covers ALL inputs in id order, so it moves when any input moves, default-valued ones included. '
    + 'It answers "is this still the program and configuration I measured", not "is this the configuration I intended" '
    + '(that is manifests/<build>.intended.json, derived from source alone). '
    + 'Entity id and pine id are NOT identity: this slot has carried three different programs.',
  generated_at: new Date().toISOString(),
  chart: {
    entity_id: snap.entity_id,
    layout: env.layout,
    symbol: snap.symbol,
    resolution: snap.resolution,
  },
  // Top level as well as under `script`: internals/inputs.js readManifest()
  // looks for them here, so pine_inputs_assert picks up script identity from
  // this file without the caller having to pass it separately.
  pine_id: snap.pine_id,
  pine_version: snap.pine_version,
  script: {
    pine_id: snap.pine_id,
    pine_version: snap.pine_version,
    program_title: snap.title,
    program_description: spec.description,
  },
  derived_from: {
    source_file: spec.source_file,
    source_sha256: createHash('sha256').update(source).digest('hex'),
    source_bytes: Buffer.byteLength(source),
    declarations: decls.length,
    id_range: `${decls[0].id}..${decls[decls.length - 1].id}`,
    cross_check: `all ${decls.length} declared inputs matched the chart by id and name`,
  },
  input_count: snap.count,
  script_input_count: decls.length,
  strategy_property_count: properties.length,
  strategy_property_ids: properties.map((p) => p.id),
  non_default_count: snap.non_default_count,
  manifest_hash: snap.manifest_hash,
  ordered_ids: snap.inputs.map((i) => i.id),
  manifest: snap.manifest,
  non_default: snap.non_default,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.error(
  `wrote ${relative(process.cwd(), outPath)}: ${manifest.input_count} inputs `
  + `(${manifest.script_input_count} script + ${manifest.strategy_property_count} strategy properties), `
  + `hash ${manifest.manifest_hash}, pine ${manifest.script.pine_version}`,
);
process.exit(0);
