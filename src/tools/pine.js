import { z } from 'zod';
import { jsonResult, fromThrown } from './_format.js';
import * as core from '../core/pine.js';
import { pineInputsAssert, pineInputsSnapshot } from '../core/pine-inputs.js';

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor', {
    source: z.string().describe('Pine Script source code to inject'),
  }, async ({ source }) => {
    try { return jsonResult(await core.setSource({ source })); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart', {}, async () => {
    try { return jsonResult(await core.compile()); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('pine_save', 'Save the current Pine Script (Ctrl+S)', {}, async () => {
    try { return jsonResult(await core.save()); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes', {}, async () => {
    try { return jsonResult(await core.smartCompile()); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('pine_new', 'Create a new blank Pine Script', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
  }, async ({ type }) => {
    try { return jsonResult(await core.newScript({ type })); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('pine_open', 'Open a saved Pine Script by name', {
    name: z.string().describe('Name of the saved script to open (case-insensitive match)'),
  }, async ({ name }) => {
    try { return jsonResult(await core.openScript({ name })); }
    catch (err) { return jsonResult(fromThrown(err, { source: 'internal_api' })); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult(fromThrown(err)); }
  });

  server.tool(
    'pine_inputs_snapshot',
    'Read the study configuration that a measurement describes. ' +
      'Returns only the inputs that DIFFER from their compiled default, which is the set that actually identifies this build, plus a manifest_hash over all of them. ' +
      'Colour inputs read back as packed integers against CSS-string defaults, so they are normalised before comparison; without that most charts report a dozen false differences. ' +
      'Use include ["manifest"] to get the compact id-to-value map to pass to pine_inputs_assert or to backtest_run, and ["all"] for every input. ' +
      'pine_id and pine_version identify the SCRIPT: a manifest that matches on values while these differ is a false pass. ' +
      'build is the study title normalised, and it is part of an assertion rather than a label beside it.',
    {
      entity_id: z.string().optional().describe('Study entity ID. Defaults to the strategy on the chart.'),
      include: z
        .array(z.enum(['all', 'manifest']))
        .optional()
        .describe('"manifest" adds the id-to-value map; "all" lists every input including defaults (~8KB).'),
    },
    async ({ entity_id, include }) => {
      try {
        return jsonResult(await pineInputsSnapshot({ entityId: entity_id, include: include || [] }));
      } catch (err) {
        return jsonResult(fromThrown(err));
      }
    },
  );

  server.tool(
    'pine_inputs_assert',
    'Refuse to proceed unless the chart is carrying the configuration you meant. ' +
      'Compares a manifest against the live study and reports every difference BY NAME, not as a hash mismatch. ' +
      'A manifest may pin a handful of levers rather than all of them: ids absent from the manifest are counted and not failed. ' +
      'Ids in the manifest that the chart does not have DO fail, because that means the manifest was written against a different script. ' +
      'This exists because it is otherwise impossible to tell, after the fact, which configuration a recorded result described.',
    {
      manifest: z
        .record(z.any())
        .describe('Expected configuration: an id-to-value map, a whole pine_inputs_snapshot response, or a committed manifest file (its manifest field is used).'),
      build: z
        .string()
        .optional()
        .describe('Build the manifest describes, e.g. "b14". Compared against the study title for EQUALITY. Asserting one build against the manifest of another build is an error, not a mismatch report: the ids mean different things in a different script.'),
      entity_id: z.string().optional().describe('Study entity ID. Omit to resolve the strategy on the chart; refuses if more than one matches.'),
      pine_id: z.string().optional().describe('Also assert the script identity. Taken from the manifest if it is a full snapshot.'),
      pine_version: z.string().optional().describe('Also assert the script version.'),
      require_complete: z
        .boolean()
        .optional()
        .describe('Fail if the chart carries any input the manifest does not mention. Off by default so a partial manifest is usable.'),
    },
    async ({ manifest, build, entity_id, pine_id, pine_version, require_complete }) => {
      try {
        return jsonResult(
          await pineInputsAssert({
            manifest,
            build,
            entityId: entity_id,
            pineId: pine_id,
            pineVersion: pine_version,
            requireComplete: require_complete === true,
          }),
        );
      } catch (err) {
        return jsonResult(fromThrown(err));
      }
    },
  );
}
