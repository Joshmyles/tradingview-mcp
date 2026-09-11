import { z } from 'zod';
import { jsonResult, fromThrown } from './_format.js';
import { preflight } from '../core/preflight.js';
import { lossAutopsy } from '../core/autopsy.js';

export function registerForensicsTools(server) {
  server.tool(
    'preflight',
    'Check that everything describing a build IS that build, and report pass/fail per check. NEVER remediates. ' +
      'Four checks: study (resolves to exactly one study, title equal to the manifest), source (committed .pine hashes to the manifest’s source_sha256), ' +
      'inputs (live study against the committed manifest), and alerts (every strategy alert on this script, compared from the alert’s OWN frozen input map — ' +
      'an alert runs what it was created with, not what the chart holds, so chart and live can differ). Alerts are read, never modified or recreated.',
    {
      build_tag: z.string().describe('Build to check, e.g. "b14". Loads manifests/<build_tag>.intended.json.'),
      manifest_path: z.string().optional().describe('Override the manifest file path.'),
      entity_id: z.string().optional().describe('Study to check. Default: the manifest title, resolved exactly; refuses on ambiguity.'),
    },
    async ({ build_tag, manifest_path, entity_id }) => {
      try {
        return jsonResult(await preflight({ buildTag: build_tag, manifestPath: manifest_path || null, entityId: entity_id || null }));
      } catch (err) {
        return jsonResult(fromThrown(err));
      }
    },
  );

  server.tool(
    'loss_autopsy',
    'One trade, one packet, from a pinned context: centres on the entry bar, captures the chart at three timeframes, and pulls the study’s Pine lines, labels and boxes ' +
      'within a time window around the entry. The point is determinism — every autopsy starts from the same context rather than whatever is on screen. ' +
      'CHANGES the chart (layout if given, resolution, zoom) and restores all of it on every exit path; restored.matches_as_found says whether that held. ' +
      'A named layout that does not exist is refused, never substituted. Each resolution change costs a 20-30s recompute on a seconds chart.',
    {
      trade_index: z.coerce.number().describe('Row index in the on-chart strategy report, from 0.'),
      entity_id: z.string().optional().describe('Strategy study. Resolved explicitly; refuses on ambiguity.'),
      layout: z.string().optional().describe('Saved layout to run the autopsy on, by exact name. Omit to use the current layout (the packet then reports layout_pinned: false).'),
      timeframes: z.array(z.string()).optional().describe('Resolutions to capture. Default ["45S", "5", "60"].'),
      bars_either_side: z.coerce.number().optional().describe('Window half-width in bars of the chart’s own resolution. Default 40.'),
      include_captures: z.coerce.boolean().optional().describe('Default true. False skips screenshots but still centres each view.'),
    },
    async ({ trade_index, entity_id, layout, timeframes, bars_either_side, include_captures }) => {
      try {
        return jsonResult(
          await lossAutopsy({
            tradeIndex: trade_index,
            entityId: entity_id || null,
            layout: layout || null,
            timeframes: timeframes ?? undefined,
            barsEitherSide: bars_either_side ?? undefined,
            includeCaptures: include_captures === undefined ? true : include_captures,
          }),
        );
      } catch (err) {
        return jsonResult(fromThrown(err));
      }
    },
  );
}
