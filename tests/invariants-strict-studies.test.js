/**
 * TVMCP_REPLAY_STRICT_STUDIES, decided Phase 0.7: ON for the replay profile,
 * OFF for workflow and diagnostic, and enforced against a CROSS-CHECKED
 * enumeration of the chart's studies.
 *
 * The fixture page is the chart as measured 2026-09-13: B15 visible, ten hidden
 * Pine studies, four built-in event sources, and three enumerations that agree.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnvironmentInvariantError,
  assertReplayEnvironment,
  crossCheckStudyEnumerations,
  resolveStrictStudies,
} from '../src/internals/invariants.js';

const HIDDEN = ['8uE6BI', '3qODoG', 'fLgsEX', 'm19xew', 'Tbo1Da', 'Aou1T7', 'yOAmH5', 'SVIL5Q', 'OMDJUm', '3qBoRm', 'hj5b3t'];
const ESD = ['ESD$TV_DIVIDENDS', 'ESD$TV_SPLITS', 'ESD$TV_EARNINGS', 'ESD$TV_ROLLDATES'];

function page({ hidden = HIDDEN, api = null, serialized = null, apiError = null } = {}) {
  const studies = [
    { entity_id: 'xVbiv5', is_strategy: true, is_pine: true, visible: true, description: 'Build 15', input_count: 353 },
    ...hidden.map((id) => ({ entity_id: id, is_strategy: false, is_pine: true, visible: false, description: `hidden ${id}` })),
    ...ESD.map((id) => ({ entity_id: id, is_strategy: false, is_pine: false, visible: true, description: id })),
  ];
  const allIds = ['xVbiv5', ...hidden];
  return {
    has_api: true, layout: 'Trial Ground', symbol: 'ICMARKETS:XAUUSD', resolution: '45S',
    non_studies: 34, studies,
    ...(apiError ? { api_studies_error: apiError } : { api_studies: api ?? allIds }),
    serialized_studies: serialized ?? allIds.map((id) => ({ id, type: id === 'xVbiv5' ? 'StudyStrategy' : 'Study', is_pine: true })),
  };
}

const deps = (p, env) => ({
  env,
  listTargets: async () => [{ id: 'CHART0001', type: 'page', url: 'https://www.tradingview.com/chart/R7HDoRZ2/' }],
  evaluateOn: async () => p,
});

describe('resolveStrictStudies', () => {
  it('is on for replay, off for workflow and diagnostic', () => {
    assert.equal(resolveStrictStudies({ profile: 'replay', env: undefined }), true);
    assert.equal(resolveStrictStudies({ profile: 'workflow', env: undefined }), false);
    assert.equal(resolveStrictStudies({ profile: 'diagnostic', env: undefined }), false);
  });

  it('lets =1 opt a non-replay profile in', () => {
    assert.equal(resolveStrictStudies({ profile: 'workflow', env: '1' }), true);
  });

  it('refuses =0 on the replay profile instead of honouring it', () => {
    assert.throws(() => resolveStrictStudies({ profile: 'replay', env: '0' }), /cannot disable strict studies/);
  });

  it('requires a profile rather than defaulting to lenient', () => {
    assert.throws(() => resolveStrictStudies({ env: undefined }), /requires profile/);
    assert.throws(() => resolveStrictStudies({ profile: 'replay-ish', env: undefined }), /requires profile/);
  });
});

describe('assertReplayEnvironment by profile, on the chart as measured', () => {
  it('replay refuses the ten hidden Pine studies and names them', async () => {
    await assert.rejects(
      assertReplayEnvironment({ profile: 'replay', _deps: deps(page()) }),
      (err) => err instanceof EnvironmentInvariantError
        && /11 extra Pine study\/studies/.test(err.message)
        && /Remove them/.test(err.message)
        && err.message.includes('hj5b3t'),
    );
  });

  it('workflow passes and still reports the hidden extras', async () => {
    const r = await assertReplayEnvironment({ profile: 'workflow', _deps: deps(page()) });
    assert.equal(r.strict_studies, false);
    assert.equal(r.extra_hidden_pine_studies.length, 11);
    assert.equal(r.enumerations_agree, true);
  });

  it('diagnostic passes', async () => {
    const r = await assertReplayEnvironment({ profile: 'diagnostic', _deps: deps(page()) });
    assert.equal(r.strict_studies, false);
  });

  it('replay passes on a chart where B15 is the only Pine study', async () => {
    const r = await assertReplayEnvironment({ profile: 'replay', _deps: deps(page({ hidden: [] })) });
    assert.equal(r.strict_studies, true);
    assert.deepEqual(r.extra_hidden_pine_studies, []);
    assert.equal(r.strategy.entity_id, 'xVbiv5');
  });

  it('a missing profile refuses before any CDP call', async () => {
    let touched = false;
    await assert.rejects(
      assertReplayEnvironment({ _deps: { ...deps(page()), listTargets: async () => { touched = true; return []; } } }),
      /requires profile/,
    );
    assert.equal(touched, false);
  });
});

describe('cross-checked enumeration', () => {
  it('the measured chart agrees across all three surfaces, with event sources excluded', () => {
    const c = crossCheckStudyEnumerations(page());
    assert.equal(c.agreed, true, JSON.stringify(c.disagreements));
    assert.equal(c.pine_ids.length, 12);
  });

  it('replay refuses when one surface sees a study the others do not, and names it', async () => {
    // The 29-vs-5 shape: one surface inflated by sources the others do not carry.
    const p = page({ hidden: [], api: ['xVbiv5', 'GHOST1'] });
    await assert.rejects(
      assertReplayEnvironment({ profile: 'replay', _deps: deps(p) }),
      (err) => /enumerations do not agree/.test(err.message) && err.message.includes('GHOST1')
        && err.message.includes('chart_api'),
    );
  });

  it('replay refuses when a surface could not be read, rather than trusting the remaining one', async () => {
    const p = page({ hidden: [], apiError: 'getAllStudies is not a function' });
    await assert.rejects(
      assertReplayEnvironment({ profile: 'replay', _deps: deps(p) }),
      /unavailable: chart_api/,
    );
  });

  it('replay refuses when the surfaces disagree about which studies are Pine', async () => {
    const p = page({
      hidden: [],
      serialized: [{ id: 'xVbiv5', type: 'StudyStrategy', is_pine: false }],
    });
    await assert.rejects(
      assertReplayEnvironment({ profile: 'replay', _deps: deps(p) }),
      /pine_studies: data_sources alone has \[xVbiv5\]/,
    );
  });

  it('workflow does not refuse on a disagreement but reports it', async () => {
    const p = page({ api: ['xVbiv5'] });
    const r = await assertReplayEnvironment({ profile: 'workflow', _deps: deps(p) });
    assert.equal(r.enumerations_agree, false);
    assert.ok(r.enumeration_disagreement.disagreements.length > 0);
  });
});
