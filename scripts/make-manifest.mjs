#!/usr/bin/env node
/**
 * Build a build's reference manifest from its Pine source plus its override
 * list. Never from a chart.
 *
 *   node scripts/make-manifest.mjs manifests/b14.overrides.json
 *
 * The chart is what a manifest is used to CHECK. Deriving the reference from a
 * snapshot of the chart makes the check vacuous, and that is precisely how an
 * unintended configuration became the baseline: `in_323` was on against a
 * default of false, and every recorded figure described it.
 *
 * Output is written next to the override file as `<build>.intended.json` and
 * carries the source file's SHA-256. That hash is not decoration. Input ids are
 * positional - deleting one `input.*` call renumbers every input after it - so
 * a manifest is only meaningful against the exact revision it was derived from,
 * and this records which one that was.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { manifestFromSource, parseInputDeclarations } from '../src/internals/pine-source.js';
import { manifestHash } from '../src/internals/inputs.js';

const specPath = resolve(process.argv[2] || 'manifests/b14.overrides.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const sourcePath = resolve(dirname(specPath), spec.source_file);
const source = readFileSync(sourcePath, 'utf8');

const decls = parseInputDeclarations(source);

// Script overrides and corrections are the same kind of thing - a deliberate
// departure from the source default - and are kept apart only so the three
// that this manifest exists to fix are readable at a glance.
const scriptOverrides = { ...(spec.script_overrides || {}), ...(spec.corrections || {}) };
const built = manifestFromSource(decls, scriptOverrides);
if (built.unknown_overrides.length) {
  console.error(`REFUSING: override ids not declared in the source: ${built.unknown_overrides.join(', ')}`);
  console.error('An override for an id the script does not declare means the override list was written against a different revision.');
  process.exit(1);
}

// Strategy properties are not in the source and cannot be derived from it.
const properties = [];
for (const [id, o] of Object.entries(spec.properties || {})) {
  if (id.startsWith('_')) continue;
  if (decls.some((d) => d.id === id)) {
    console.error(`REFUSING: ${id} is declared in the Pine source, so it is a script input, not a strategy property.`);
    process.exit(1);
  }
  built.manifest[id] = o.value;
  properties.push({ id, value: o.value, why: o.why ?? null });
}

const out = {
  build: spec.build,
  title: spec.title,
  state: 'intended',
  note:
    'Build ' + spec.build + "'s REFERENCE configuration. Derived from the Pine source's input.* defaults plus the explicit " +
    'override list in ' + specPath.split(/[\\/]/).pop() + ', never from a chart snapshot. Assert against this before any measurement, ' +
    'and re-derive it rather than editing it. It does not carry forward to another build: input ids are positional, so the same ' +
    'id means something different in a script with a different set of declarations.',
  generated_at: new Date().toISOString(),
  derived_from: {
    source_file: spec.source_file,
    source_sha256: createHash('sha256').update(source).digest('hex'),
    source_bytes: source.length,
    declarations: decls.length,
    id_range: decls.length ? `${decls[0].id}..${decls[decls.length - 1].id}` : null,
  },
  pinned: Object.keys(built.manifest).length,
  pinned_hash: manifestHash(built.manifest),
  unpinned_count: built.unpinned.length,
  unpinned_note:
    'Inputs whose source default is an expression rather than a literal (colour constructors). A manifest cannot state a value ' +
    'for them without compiling the script, so they are left unpinned; pine_inputs_assert counts what a manifest does not pin ' +
    'rather than failing on it. All of them are drawing colours.',
  unpinned: built.unpinned,
  corrections: Object.keys(spec.corrections || {}).map((id) => {
    const d = decls.find((x) => x.id === id);
    return { id, title: d ? d.title : null, value: spec.corrections[id].value, why: spec.corrections[id].why };
  }),
  overrides: built.overrides.filter((o) => !(spec.corrections || {})[o.id]),
  properties,
  manifest: built.manifest,
};

const outPath = resolve(dirname(specPath), `${spec.build}.intended.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

console.log(`source      ${sourcePath}`);
console.log(`sha256      ${out.derived_from.source_sha256}`);
console.log(`declared    ${decls.length} inputs (${out.derived_from.id_range})`);
console.log(`pinned      ${out.pinned}  (${built.overrides.length} script overrides, ${properties.length} properties)`);
console.log(`unpinned    ${out.unpinned_count} (non-literal defaults)`);
console.log(`pinned_hash ${out.pinned_hash}`);
console.log(`wrote       ${outPath}`);
