/**
 * The §6 loop precondition, and the defect it exposed.
 *
 * Two things are pinned here.
 *
 * 1. REGRESSION: pine_inputs_assert used to return `ok: true` for a chart whose
 *    SCRIPT had drifted. `compareManifest()` returns its own `ok`, and the
 *    result object spread it AFTER the computed verdict, so `cmp.ok` (the
 *    inputs matched) silently overwrote `ok` (the script did not). The payload
 *    carried `reason: 'script_drift'`, a `script_drift` array and an error
 *    string saying the inputs were not comparable — and `.ok` said pass.
 *    Measured live 2026-09-12: manifest pinned pine 0.46, chart carried 0.51.
 *    A precondition that answers "yes" while explaining why the answer is "no"
 *    is worse than no precondition, because everything downstream reads `.ok`.
 *
 * 2. The committed b15 manifest is internally consistent — its declared hash is
 *    the hash of the map it carries — so a corrupted or hand-edited manifest
 *    cannot pass by asserting its own wrong hash.
 *
 * Pure: mocked evaluate, no live chart.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { pineInputsAssert } from '../src/core/pine-inputs.js';
import { manifestHash } from '../src/internals/inputs.js';

const MANIFEST_PATH = fileURLToPath(new URL('../manifests/b15.manifest.json', import.meta.url));
const B15 = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

/**
 * A chart that answers with the given inputs, script identity and title.
 *
 * Both page reads in the assert path — resolveEntity's source listing and
 * inputsSnapshotJs — go through one evaluate, so this picks by the shape of
 * the expression rather than by call order, which would be fragile.
 */
function mockChart({ inputs, pineId, pineVersion, title = 'B15' }) {
  return {
    evaluate: async (expr) => {
      // Discriminate on getInputValues, not on reportData: BOTH expressions
      // mention reportData (the snapshot uses it to find the strategy), so
      // matching on that returned the study list where the inputs were wanted.
      if (!expr.includes('getInputValues')) {
        return {
          ok: true,
          symbol: 'ICMARKETS:XAUUSD',
          resolution: '45S',
          studies: [{ entity_id: 'xVbiv5', title, is_strategy: true, report_present: true }],
        };
      }
      return {
        ok: true,
        entity_id: 'xVbiv5',
        title,
        pine_id: pineId,
        pine_version: pineVersion,
        symbol: 'ICMARKETS:XAUUSD',
        resolution: '45S',
        inputs,
      };
    },
  };
}

/** Every input the manifest pins, valued exactly as it pins it. */
function inputsMatchingManifest() {
  return Object.entries(B15.manifest).map(([id, value]) => ({
    id,
    name: id,
    type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'float' : 'string',
    group: null,
    value,
    def: value,
  }));
}

describe('manifest precondition', () => {
  it('passes when script identity and every input match', async () => {
    const r = await pineInputsAssert({
      manifest: B15,
      entityId: 'xVbiv5',
      requireComplete: true,
      _deps: mockChart({
        inputs: inputsMatchingManifest(),
        pineId: B15.pine_id,
        pineVersion: B15.pine_version,
      }),
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.manifest_hash, B15.manifest_hash);
    assert.equal(r.mismatches.length, 0);
  });

  it('REGRESSION: script drift with matching inputs must NOT report ok', async () => {
    const r = await pineInputsAssert({
      manifest: B15,
      entityId: 'xVbiv5',
      requireComplete: true,
      _deps: mockChart({
        inputs: inputsMatchingManifest(),
        pineId: B15.pine_id,
        pineVersion: '0.46', // B14's version in B15's slot — the live case
      }),
    });
    assert.equal(r.ok, false, 'script drift was detected and then reported as a pass');
    assert.equal(r.reason, 'script_drift');
    assert.deepEqual(r.script_drift, [
      { field: 'pine_version', expected: B15.pine_version, actual: '0.46' },
    ]);
    // The inputs really did match; that is the whole point of the trap.
    assert.equal(r.inputs_ok, true);
    assert.equal(r.mismatches.length, 0);
  });

  it('REGRESSION: pine_id drift with matching inputs must NOT report ok', async () => {
    const r = await pineInputsAssert({
      manifest: B15,
      entityId: 'xVbiv5',
      requireComplete: true,
      _deps: mockChart({
        inputs: inputsMatchingManifest(),
        pineId: 'USER;0000000000000000000000000000000',
        pineVersion: B15.pine_version,
      }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'script_drift');
  });

  it('a changed input is refused with the id, the expectation and the reading', async () => {
    const inputs = inputsMatchingManifest();
    const target = inputs.find((i) => i.id === 'in_0');
    target.name = 'Loopback Period';
    target.type = 'integer';
    target.value = 999;
    const r = await pineInputsAssert({
      manifest: B15,
      entityId: 'xVbiv5',
      requireComplete: true,
      _deps: mockChart({
        inputs,
        pineId: B15.pine_id,
        pineVersion: B15.pine_version,
      }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'inputs_mismatch');
    assert.deepEqual(r.mismatches, [
      { id: 'in_0', name: 'Loopback Period', expected: B15.manifest.in_0, actual: 999 },
    ]);
  });

  it('an input the manifest does not pin is refused under requireComplete', async () => {
    // Recompiling with one extra input.* call is exactly this case, and it
    // renumbers every input after it.
    const inputs = inputsMatchingManifest();
    inputs.push({ id: 'in_999', name: 'a new lever', type: 'bool', group: null, value: true, def: false });
    const r = await pineInputsAssert({
      manifest: B15,
      entityId: 'xVbiv5',
      requireComplete: true,
      _deps: mockChart({ inputs, pineId: B15.pine_id, pineVersion: B15.pine_version }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.not_in_manifest_count, 1);
  });
});

describe('the committed b15 manifest', () => {
  it('declares the hash of the map it actually carries', () => {
    assert.equal(manifestHash(B15.manifest), B15.manifest_hash);
  });

  it('pins every input it claims to, script inputs and strategy properties', () => {
    assert.equal(Object.keys(B15.manifest).length, B15.input_count);
    assert.equal(B15.ordered_ids.length, B15.input_count);
    assert.equal(B15.script_input_count + B15.strategy_property_count, B15.input_count);
  });

  it('records the source revision it was cross-checked against', () => {
    assert.match(B15.derived_from.source_sha256, /^[0-9a-f]{64}$/);
    assert.ok(B15.derived_from.source_file.endsWith('build15.pine'));
    assert.equal(B15.derived_from.declarations, B15.script_input_count);
  });
});
