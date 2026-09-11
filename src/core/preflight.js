/**
 * preflight — is everything that describes this build the build?
 *
 * Four checks, each reported pass/fail on its own:
 *
 *   study      the study resolves to exactly one entity and its title equals
 *              the manifest's, character for character after normalisation
 *   source     the committed .pine hashes to the manifest's source_sha256
 *   inputs     the live study's inputs match the committed manifest
 *   alerts     every strategy alert on this script runs the manifest's
 *              configuration — read from the alert's OWN frozen map, because
 *              an alert runs what it was created with, not what the chart holds
 *
 * It NEVER remediates. A preflight that fixed what it found would erase the
 * evidence of the drift it exists to catch, and the alert fix in particular is
 * a live-execution change on a broker-attached account. It reports.
 *
 * Webhook and broker checks are out of scope: there is no execution service
 * to check against.
 */
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { evaluate } from '../connection.js';
import { requireSettled } from '../settle.js';
import { resolveEntity } from './pine-inputs.js';
import { list as listAlerts } from './alerts.js';
import { buildKey, checkBuild, compareManifest, inputsSnapshotJs, readManifest } from '../internals/inputs.js';
import { strategyAlertConfigs } from '../internals/alert-config.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Load the committed manifest for a build. */
function loadManifest(buildTag, manifestPath) {
  const path = manifestPath ? resolve(manifestPath) : join(REPO, 'manifests', `${buildTag}.intended.json`);
  if (!existsSync(path)) {
    return { ok: false, reason: 'not_found', error: `No committed manifest at ${path}. Generate it with scripts/make-manifest.mjs.`, path };
  }
  try {
    return { ok: true, path, file: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { ok: false, reason: 'invalid_argument', error: `Manifest at ${path} is not valid JSON: ${err.message}`, path };
  }
}

function check(name, pass, detail) {
  return { check: name, pass, ...detail };
}

export async function preflight({ buildTag, manifestPath = null, entityId = null, _deps } = {}) {
  const ev = _deps?.evaluate || evaluate;
  const alertsList = _deps?.listAlerts || listAlerts;
  const settle = _deps?.requireSettled || requireSettled;
  const readFile = _deps?.readFile || ((p) => readFileSync(p));

  const tag = buildKey(buildTag);
  if (!tag) return { ok: false, reason: 'invalid_argument', error: 'build_tag is required, e.g. "b14".' };

  const loaded = _deps?.manifestFile
    ? { ok: true, path: '(injected)', file: _deps.manifestFile }
    : loadManifest(tag, manifestPath);
  if (!loaded.ok) return loaded;
  const file = loaded.file;
  const parsed = readManifest(file);
  if (!parsed.ok) return { ...parsed, manifest_path: loaded.path };
  if (parsed.build && parsed.build !== tag) {
    return {
      ok: false,
      reason: 'invalid_argument',
      error: `build_tag is "${tag}" and the manifest at ${loaded.path} declares "${parsed.build}". One manifest describes one build.`,
    };
  }

  const checks = [];

  // --- study: resolves unambiguously, title equal.
  const r = await resolveEntity({ hint: entityId ?? parsed.title ?? null, _deps });
  let entity = null;
  if (!r.ok) {
    checks.push(check('study', false, {
      reason: r.reason === 'ambiguous' ? 'ambiguous_entity' : r.reason,
      error: r.error,
      candidates: (r.candidates || []).map((c) => ({ entity_id: c.entity_id, title: c.title })),
    }));
  } else {
    entity = r.resolved;
    const wrong = checkBuild({ expectedBuild: tag, expectedTitle: parsed.title, actualTitle: entity.title });
    checks.push(check('study', !wrong, {
      entity_id: entity.entity_id,
      title: entity.title,
      expected_title: parsed.title,
      matched_by: r.matched_by,
      ...(wrong && { reason: wrong.reason, error: wrong.error }),
    }));
  }

  // --- source: committed .pine hashes to what the manifest was derived from.
  const derived = file.derived_from || {};
  if (!derived.source_file || !derived.source_sha256) {
    checks.push(check('source', false, {
      reason: 'unpinned',
      error: 'The manifest records no source_file / source_sha256, so the revision it describes cannot be checked. Regenerate it with scripts/make-manifest.mjs.',
    }));
  } else {
    const srcPath = resolve(dirname(loaded.path === '(injected)' ? join(REPO, 'manifests', 'x') : loaded.path), derived.source_file);
    try {
      const sha = createHash('sha256').update(readFile(srcPath)).digest('hex');
      checks.push(check('source', sha === derived.source_sha256, {
        path: srcPath,
        expected_sha256: derived.source_sha256,
        actual_sha256: sha,
        ...(sha !== derived.source_sha256 && {
          error: 'The committed source is not the revision this manifest was derived from. Input ids are positional, so the manifest may now name the wrong inputs. This is a different build, not drift — fork and regenerate.',
        }),
      }));
    } catch (err) {
      checks.push(check('source', false, { path: srcPath, reason: 'unreadable', error: err.message }));
    }
  }

  // --- inputs: the live study against the manifest. Needs a settled study.
  let chartInputs = null;
  if (entity) {
    const gate = await settle({ entityId: entity.entity_id, scope: 'target' });
    if (!gate.ok) {
      checks.push(check('inputs', false, { reason: gate.reason, error: gate.error }));
    } else {
      const raw = await ev(inputsSnapshotJs(JSON.stringify(entity.entity_id)));
      if (!raw?.ok) {
        checks.push(check('inputs', false, { reason: raw?.reason || 'no_result', error: raw?.error || 'The page returned nothing.' }));
      } else {
        chartInputs = raw;
        const cmp = compareManifest(parsed.expected, raw.inputs);
        checks.push(check('inputs', cmp.ok, {
          checked: cmp.checked,
          matched: cmp.matched,
          mismatches: cmp.mismatches,
          missing_from_chart: cmp.missing_from_chart,
          pine_id: raw.pine_id,
          pine_version: raw.pine_version,
        }));
      }
    }
  } else {
    checks.push(check('inputs', false, { reason: 'no_study', error: 'Not checked: the study did not resolve.' }));
  }

  // --- alerts: each strategy alert on THIS script, from its own frozen map.
  try {
    const listed = await alertsList();
    if (listed?.error && !listed?.alerts?.length) {
      checks.push(check('alerts', false, { reason: 'unavailable', error: `Could not list alerts: ${listed.error}` }));
    } else {
      const all = strategyAlertConfigs(listed?.alerts || []);
      const pineId = chartInputs?.pine_id ?? null;
      const mine = pineId ? all.filter((a) => a.pine_id === pineId) : all;
      // Types come from the chart, so colours compare as colours. The alert map
      // carries values only.
      const typed = new Map((chartInputs?.inputs || []).map((i) => [i.id, i]));
      const rows = mine.map((a) => {
        const asInputs = Object.entries(a.inputs).map(([id, value]) => ({
          id,
          value,
          type: typed.get(id)?.type ?? null,
          name: typed.get(id)?.name ?? null,
        }));
        const cmp = compareManifest(parsed.expected, asInputs);
        const versionDrift =
          chartInputs?.pine_version && a.pine_version && a.pine_version !== chartInputs.pine_version;
        return {
          alert_id: a.alert_id,
          active: a.active,
          resolution: a.resolution,
          pine_version: a.pine_version,
          chart_pine_version: chartInputs?.pine_version ?? null,
          ...(versionDrift && {
            script_drift:
              `The alert was created against pine_version ${a.pine_version} and the chart runs ${chartInputs.pine_version}. ` +
              'Input ids are positional, so if an input was added or removed between the two, the ids below name different inputs.',
          }),
          matches_manifest: cmp.ok && !versionDrift,
          checked: cmp.checked,
          mismatch_count: cmp.mismatches.length,
          mismatches: cmp.mismatches.slice(0, 20),
          missing_from_alert: cmp.missing_from_chart.slice(0, 20),
        };
      });
      const liveDiverged = rows.filter((x) => x.active && !x.matches_manifest);
      checks.push(check('alerts', liveDiverged.length === 0, {
        strategy_alerts: rows.length,
        active: rows.filter((x) => x.active).length,
        diverged_active: liveDiverged.map((x) => x.alert_id),
        diverged_inactive: rows.filter((x) => !x.active && !x.matches_manifest).map((x) => x.alert_id),
        alerts: rows,
        ...(!pineId && { warning: 'The study pine_id was not available, so alerts were not narrowed to this script.' }),
        ...(rows.length === 0 && { note: 'No strategy alert runs this script. Nothing live to compare.' }),
        ...(liveDiverged.length && {
          error:
            `${liveDiverged.length} ACTIVE alert(s) run a configuration that is not this manifest. Live orders come from the ` +
            "alert's frozen map, not from the chart, so what the chart says is not what executes. Not modified — recreating " +
            'an alert is a live-execution change for its owner.',
        }),
      }));
    }
  } catch (err) {
    checks.push(check('alerts', false, { reason: 'unavailable', error: err.message }));
  }

  const failed = checks.filter((c) => !c.pass).map((c) => c.check);
  return {
    ok: true,
    pass: failed.length === 0,
    build: tag,
    manifest_path: loaded.path,
    failed,
    checks,
    note:
      'Each check stands alone; ok means preflight ran, pass means every check held. Nothing was changed. ' +
      'An alert runs the configuration it was created with, so the alerts check reads each alert’s own frozen map.',
  };
}
