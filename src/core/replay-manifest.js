/**
 * The §6 loop precondition: is the chart still carrying the program and the
 * configuration the run was specified against?
 *
 * This replaces the original brief's check, which read B14's `in_273`–`in_280`
 * and compared them to expected values. That check cannot be carried forward:
 * input ids are POSITIONAL, B15 declares a different set, and `in_273`–`in_280`
 * mean something else in it. More importantly the shape was wrong — eight ids
 * out of 353 is a spot check, and the failure it was written to catch (a silent
 * study reload resetting inputs to defaults) moves all of them.
 *
 * WHAT IT DOES INSTEAD. One hash over every input, in id order, compared to
 * manifests/b15.manifest.json. Equal — proceed. Different — ABORT, with the
 * per-input diff of what moved. The manifest also pins `pine_id` and
 * `pine_version`, which are checked first and short-circuit, because a
 * different script is not a different configuration and enumerating three
 * hundred input differences would bury that.
 *
 * IT NEVER COERCES. There is no "restore the expected values and continue"
 * path here and there must not be one: writing inputs back would (a) make the
 * check vacuous, and (b) not even persist — API input writes set no dirty flag,
 * so TradingView does not autosave them and a reload restores the saved copy.
 * The operator fixes the chart; the harness only refuses.
 *
 * WHY THE MANIFEST IS NOT TRUSTED BY ID. Entity `xVbiv5` and pine id
 * `USER;e003abfb…` have now carried three different programs — B14 (pine 0.46,
 * 351 inputs), "Base 2.0.36" (0.49, 25 inputs) and Build 15 (0.51, 353 inputs)
 * — all answering to the same ids. Identity here is content, and only content.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pineInputsAssert } from './pine-inputs.js';
import { assertReplayEnvironment } from '../internals/invariants.js';

export const DEFAULT_MANIFEST_PATH = fileURLToPath(
  new URL('../../manifests/b15.manifest.json', import.meta.url),
);

/** A refusal that carries the diff, so the caller can print what moved. */
export class ManifestMismatchError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ManifestMismatchError';
    this.detail = detail;
  }
}

export function loadManifest(path = DEFAULT_MANIFEST_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw?.manifest || !raw.manifest_hash) {
    throw new ManifestMismatchError(
      `${path} is not a manifest: it carries no input map or no manifest_hash.`,
      { path },
    );
  }
  return raw;
}

/**
 * Assert the chart carries the manifest's program AND configuration.
 *
 * Returns the manifest identity on success. Throws ManifestMismatchError with
 * `detail.mismatches` (id, name, expected, actual) on any difference.
 *
 * `requireComplete` defaults TRUE: an input the manifest does not pin is an
 * input the program did not have when the manifest was taken, which means the
 * program changed. Recompiling with one extra `input.*` call is exactly that
 * case, and it renumbers everything after it.
 */
export async function assertStrategyManifest({
  manifestPath = DEFAULT_MANIFEST_PATH,
  requireComplete = true,
  skipEnvironment = false,
  _deps,
} = {}) {
  const manifest = loadManifest(manifestPath);

  // The environment check first: asserting against an ambiguous chart would
  // assert against whichever study came first out of dataSources().
  let env = null;
  if (!skipEnvironment) {
    env = await assertReplayEnvironment({ expectStrategyTitle: manifest.description || null });
  }

  const res = await pineInputsAssert({
    manifest,
    entityId: env?.strategy?.entity_id ?? manifest.chart?.entity_id ?? null,
    requireComplete,
    _deps,
  });

  if (!res.ok) {
    const kind = res.reason === 'script_drift'
      ? 'The SCRIPT on the chart is not the one this manifest was taken against'
      : `${res.mismatches?.length ?? 0} input(s) differ from the manifest`;
    throw new ManifestMismatchError(
      `${kind}. Expected hash ${manifest.manifest_hash}, chart reads ${res.manifest_hash ?? 'unknown'}. `
      + 'Aborting rather than continuing: any result recorded now would describe a different configuration. '
      + 'Nothing has been written to the chart.',
      {
        reason: res.reason,
        expected_hash: manifest.manifest_hash,
        actual_hash: res.manifest_hash ?? null,
        expected_pine_version: manifest.pine_version,
        actual_title: res.title ?? null,
        script_drift: res.script_drift ?? null,
        mismatches: res.mismatches ?? [],
        missing_from_chart: res.missing_from_chart ?? [],
        not_in_manifest: res.not_in_manifest ?? [],
        not_in_manifest_count: res.not_in_manifest_count ?? 0,
        error: res.error ?? null,
        manifest_path: manifestPath,
      },
    );
  }

  return {
    ok: true,
    manifest_path: manifestPath,
    build: manifest.build,
    title: res.title,
    entity_id: res.entity_id,
    pine_id: manifest.pine_id,
    pine_version: manifest.pine_version,
    symbol: res.symbol,
    resolution: res.resolution,
    manifest_hash: res.manifest_hash,
    inputs_checked: res.checked,
    source_sha256: manifest.derived_from?.source_sha256 ?? null,
    ...(env && { environment: { layout: env.layout, target_id: env.target_id } }),
  };
}
