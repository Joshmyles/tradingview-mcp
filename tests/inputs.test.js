/**
 * Study input manifests.
 *
 * Pure, so no live chart. Pinned because this is the thing that decides
 * whether a recorded performance figure describes the build it claims to: a
 * false pass here silently validates the wrong configuration, which is the
 * failure it was built to stop.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  annotate,
  buildKey,
  checkBuild,
  compareManifest,
  manifestHash,
  normaliseColour,
  readManifest,
  sameValue,
  toManifest,
} from '../src/internals/inputs.js';

// Shape as `getInputValues()` plus `metaInfo().inputs` give it, measured on
// the live B14 study 2026-09-11.
const INPUTS = [
  { id: 'in_0', name: 'Loopback Period', type: 'integer', group: null, value: 10, def: 10 },
  { id: 'in_323', name: 'Re-enter on the opposite CZ break', type: 'bool', group: null, value: true, def: false },
  { id: 'in_5', name: 'Zone low line', type: 'color', group: null, value: 4285982208, def: '#00E676' },
];

describe('normaliseColour', () => {
  it('unpacks TradingView colour integers as AABBGGRR', () => {
    // Measured: these two pairs are the same colour, and they fix the byte
    // order as the REVERSE of CSS. Guessing ARGB here would invert red and
    // blue and every colour would read as changed.
    assert.equal(normaliseColour('#F23645'), normaliseColour(4282726130));
    assert.equal(normaliseColour('#00E676'), normaliseColour(4285982208));
    assert.equal(normaliseColour('rgba(41,98,255,0.3)'), normaliseColour(1308582441));
  });

  it('handles short hex and rgb without an alpha', () => {
    assert.equal(normaliseColour('#f00'), normaliseColour('#FF0000'));
    assert.equal(normaliseColour('rgb(255,0,0)'), normaliseColour('#FF0000'));
  });

  it('returns null for something it cannot parse, rather than a wrong number', () => {
    // null never compares equal, so an unparseable colour is reported as a
    // difference instead of being waved through.
    assert.equal(normaliseColour('chartreuse'), null);
    assert.equal(normaliseColour(null), null);
  });
});

describe('sameValue', () => {
  it('treats a stringified value as equal, because a hand-written manifest has them', () => {
    assert.equal(sameValue(true, 'true'), true);
    assert.equal(sameValue(10, '10'), true);
  });

  it('does not treat a genuinely different value as equal', () => {
    assert.equal(sameValue(true, false), false);
    assert.equal(sameValue(10, 11), false);
    assert.equal(sameValue(null, false), false);
  });

  it('compares colours by value only when told the type', () => {
    // Without the type these are a number and a string and nothing can match
    // them; the type is what makes the comparison meaningful.
    assert.equal(sameValue(4285982208, '#00E676'), false);
    assert.equal(sameValue(4285982208, '#00E676', 'color'), true);
  });
});

describe('annotate', () => {
  it('marks which inputs sit at their default, colours included', () => {
    const a = annotate(INPUTS);
    assert.equal(a[0].is_default, true);
    assert.equal(a[1].is_default, false, 'in_323 is on against a default of off');
    assert.equal(a[2].is_default, true, 'the colour is unchanged despite the representation differing');
  });

  it('says null rather than false when there is no default to compare against', () => {
    const a = annotate([{ id: 'in_9', name: 'x', type: 'integer', group: null, value: 3, def: null }]);
    assert.equal(a[0].is_default, null);
  });
});

describe('manifestHash', () => {
  it('does not depend on the order the manifest was built in', () => {
    assert.equal(manifestHash({ in_1: 2, in_0: 1 }), manifestHash({ in_0: 1, in_1: 2 }));
  });

  it('changes when any value changes', () => {
    assert.notEqual(manifestHash({ in_0: 1 }), manifestHash({ in_0: 2 }));
    // Type matters: a manifest carrying "1" is not proof the chart carries 1.
    assert.notEqual(manifestHash({ in_0: 1 }), manifestHash({ in_0: '1' }));
  });
});

describe('compareManifest', () => {
  it('names the difference instead of reporting a hash mismatch', () => {
    const c = compareManifest({ in_323: false }, INPUTS);
    assert.equal(c.ok, false);
    assert.equal(c.mismatches.length, 1);
    assert.equal(c.mismatches[0].id, 'in_323');
    assert.match(c.mismatches[0].name, /opposite CZ break/);
    assert.equal(c.mismatches[0].expected, false);
    assert.equal(c.mismatches[0].actual, true);
  });

  it('passes a partial manifest, and counts what it did not pin', () => {
    const c = compareManifest({ in_0: 10 }, INPUTS);
    assert.equal(c.ok, true);
    assert.equal(c.checked, 1);
    assert.equal(c.not_in_manifest_count, 2);
  });

  it('fails a partial manifest when completeness is required', () => {
    assert.equal(compareManifest({ in_0: 10 }, INPUTS, { requireComplete: true }).ok, false);
  });

  it('fails an id the chart does not have, because that is a different script', () => {
    const c = compareManifest({ in_999: 1 }, INPUTS);
    assert.equal(c.ok, false);
    assert.deepEqual(c.missing_from_chart, ['in_999']);
    assert.equal(c.checked, 0, 'an input that is not there was not checked, it was missing');
  });

  it('does not fail a colour that only differs in representation', () => {
    assert.equal(compareManifest({ in_5: '#00E676' }, INPUTS).ok, true);
    assert.equal(compareManifest({ in_5: '#00E677' }, INPUTS).ok, false);
  });
});

describe('toManifest', () => {
  it('is the compact form, and round-trips through compareManifest', () => {
    const m = toManifest(INPUTS);
    assert.deepEqual(Object.keys(m).sort(), ['in_0', 'in_323', 'in_5']);
    assert.equal(compareManifest(m, INPUTS).ok, true);
  });
});

describe('buildKey', () => {
  it('normalises a title to the key a manifest is filed under', () => {
    assert.equal(buildKey(' B14 '), 'b14');
    assert.equal(buildKey('B14'), buildKey('b14'));
  });

  it('keeps two builds apart', () => {
    // The whole point. B14 and B15 can be loaded on one chart at once.
    assert.notEqual(buildKey('B14'), buildKey('B15'));
  });

  it('is exact, so a near-miss title is a different build', () => {
    // A fuzzy rule here would let "B14 copy" satisfy a B14 assertion, which is
    // the failure this exists to prevent.
    assert.notEqual(buildKey('B14 copy'), buildKey('B14'));
    assert.equal(buildKey(null), null);
    assert.equal(buildKey('   '), null);
  });
});

describe('readManifest', () => {
  it('accepts a bare id-to-value map', () => {
    const r = readManifest({ in_323: false });
    assert.equal(r.ok, true);
    assert.deepEqual(r.expected, { in_323: false });
    assert.equal(r.build, null, 'a hand-written map declares no build, and that is allowed');
  });

  it('accepts a whole snapshot and takes its identity too', () => {
    const r = readManifest({
      ok: true, title: 'B14', pine_id: 'USER;abc', pine_version: '0.46',
      manifest: { in_0: 1 }, non_default: [], count: 351,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.expected, { in_0: 1 });
    assert.equal(r.build, 'b14', 'the build falls out of the title when not stated separately');
    assert.equal(r.pine_id, 'USER;abc');
  });

  it('prefers an explicit build over the title', () => {
    const r = readManifest({ build: 'b14', title: 'B14', manifest: { in_0: 1 } });
    assert.equal(r.build, 'b14');
  });

  it('rejects a key that is not an input id', () => {
    // A typo in an envelope key would otherwise be read as an input id, fail
    // as missing_from_chart, and be diagnosed as the wrong script.
    const r = readManifest({ in_0: 1, buidl: 'b14' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_argument');
    assert.deepEqual(r.stray_keys, ['buidl']);
  });

  it('rejects a manifest that pins nothing', () => {
    assert.equal(readManifest({}).ok, false);
    assert.equal(readManifest(null).ok, false);
    assert.equal(readManifest([1, 2]).ok, false);
  });
});

describe('checkBuild', () => {
  it('passes when the study on the chart is the build the manifest describes', () => {
    assert.equal(checkBuild({ expectedBuild: 'b14', actualTitle: 'B14' }), null);
    assert.equal(checkBuild({ expectedTitle: 'B14', actualTitle: 'b14' }), null);
  });

  it('says nothing when the manifest declares no build', () => {
    // A hand-written map pinning one lever should not have to name a build.
    assert.equal(checkBuild({ actualTitle: 'B14' }), null);
  });

  it('refuses build 15 against build 14, as a category error', () => {
    const r = checkBuild({ expectedBuild: 'b14', actualTitle: 'B15' });
    assert.equal(r.reason, 'wrong_build');
    assert.equal(r.expected_build, 'b14');
    assert.equal(r.actual_build, 'b15');
    assert.match(r.error, /different script, not a different configuration/);
  });

  it('refuses when the study will not say what it is', () => {
    assert.equal(checkBuild({ expectedBuild: 'b14', actualTitle: null }).reason, 'wrong_build');
  });
});
