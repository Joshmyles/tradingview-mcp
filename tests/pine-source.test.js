/**
 * Deriving a manifest from Pine source.
 *
 * Pure, so no live chart. Pinned because the positional `in_N` mapping is the
 * whole load-bearing claim: if the parser drops or invents one declaration,
 * every id after it shifts and a manifest built from it asserts the wrong
 * input at every position while looking perfectly well-formed.
 *
 * The live evidence that the mapping is right is in `verifyAgainstMeta`, which
 * joins against TradingView's own `metaInfo().inputs` — measured 326 of 326
 * titles and 309 of 309 literal defaults on build 14, 2026-09-11.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  manifestFromSource,
  maskSource,
  parseInputDeclarations,
  verifyAgainstMeta,
} from '../src/internals/pine-source.js';

describe('maskSource', () => {
  it('blanks comments and string contents without moving any index', () => {
    const src = 'a = 1 // input.bool(true, "x")\nb = "input.int(9)"\n';
    const m = maskSource(src);
    assert.equal(m.length, src.length, 'indices must still line up with the original');
    assert.equal(m.includes('input.bool'), false, 'a commented-out declaration is not a declaration');
    assert.equal(m.includes('input.int'), false, 'a declaration inside a string literal is not one either');
    assert.equal(m.slice(0, 5), 'a = 1', 'code outside comments and strings is untouched');
  });

  it('does not swallow the line after a trailing comment', () => {
    // Regression: consuming the newline inside the comment scan skipped the
    // first character of the next line, which silently dropped declarations.
    const decls = parseInputDeclarations('// lead comment\nx = input.bool(true, "Kept")\n');
    assert.equal(decls.length, 1);
    assert.equal(decls[0].title, 'Kept');
  });
});

describe('parseInputDeclarations', () => {
  const SRC = [
    'czPrd = input.int(10, "Loopback Period", minval = 2, group = "CZ")',
    'paint = input.bool(true, "Paint Area ", group = "CZ")',
    'col   = input.color(color.new(color.blue, 70), "Zone Color", group = "CZ")',
    'sess  = input.session("0000-2400", "Session", group = "SESX")',
    'named = input.float(defval = 1.5, title = "Named Args")',
  ].join('\n');

  it('numbers by position, because the index IS the id', () => {
    const d = parseInputDeclarations(SRC);
    assert.deepEqual(d.map((x) => x.id), ['in_0', 'in_1', 'in_2', 'in_3', 'in_4']);
  });

  it('reads literal defaults and titles, including named arguments', () => {
    const d = parseInputDeclarations(SRC);
    assert.equal(d[0].default, 10);
    assert.equal(d[0].title, 'Loopback Period');
    assert.equal(d[0].group, 'CZ');
    assert.equal(d[1].default, true);
    assert.equal(d[1].title, 'Paint Area ', 'trailing space in a title is significant — it is what the chart reports');
    assert.equal(d[3].default, '0000-2400');
    assert.equal(d[4].default, 1.5, 'defval = ... is the same thing as the first positional');
    assert.equal(d[4].title, 'Named Args');
  });

  it('refuses to guess a default it would have to compile', () => {
    // `color.new(color.blue, 70)` has no value until the script compiles.
    // Inventing one would put a wrong value in a manifest that is then
    // asserted against a live chart.
    const d = parseInputDeclarations(SRC);
    assert.equal(d[2].default_literal, false);
    assert.equal(d[2].default, undefined);
    assert.equal(d[2].default_expr, 'color.new(color.blue, 70)');
    assert.equal(d[2].title, 'Zone Color', 'the title is still readable even when the default is not');
  });

  it('splits arguments at top-level commas only', () => {
    // The comma inside color.new(...) must not end the argument, or the title
    // would be read as "70" and every id after it would still be right while
    // this one silently described the wrong thing.
    const d = parseInputDeclarations('c = input.color(color.rgb(1, 2, 3), "Title, with comma")');
    assert.equal(d.length, 1);
    assert.equal(d[0].title, 'Title, with comma');
  });
});

describe('verifyAgainstMeta', () => {
  const decls = parseInputDeclarations('a = input.int(1, "One")\nb = input.bool(false, "Two")');

  it('passes when the chart agrees, and counts what the source does not declare', () => {
    // in_328.. are TradingView's strategy properties — Initial Capital,
    // Commission Value, Use Bar Magnifier and the rest. They are real inputs
    // on real ids and they are NOT in the Pine source, so they are reported,
    // not failed.
    const v = verifyAgainstMeta(decls, [
      { id: 'in_0', name: 'One' },
      { id: 'in_1', name: 'Two' },
      { id: 'in_328', name: 'Initial Capital' },
    ]);
    assert.equal(v.ok, true);
    assert.equal(v.matched, 2);
    assert.equal(v.undeclared_count, 1);
    assert.deepEqual(v.undeclared_on_chart, [{ id: 'in_328', name: 'Initial Capital' }]);
  });

  it('joins by id and not by array position', () => {
    // Measured on B14: getInputValues() is ordered, but its index is NOT the
    // id — in_326 and in_327 do not exist, so position 326 carries in_328.
    // Joining by position reported the strategy properties two ids early and
    // read perfectly plausibly.
    const v = verifyAgainstMeta(parseInputDeclarations('a = input.int(1, "One")'), [
      { id: 'in_9', name: 'Something Else' },
      { id: 'in_0', name: 'One' },
    ]);
    assert.equal(v.ok, true, 'order in the array must not matter');
    assert.equal(v.matched, 1);
  });

  it('fails, naming the id, when a title disagrees', () => {
    const v = verifyAgainstMeta(decls, [
      { id: 'in_0', name: 'One' },
      { id: 'in_1', name: 'Shifted' },
    ]);
    assert.equal(v.ok, false);
    assert.equal(v.mismatches[0].id, 'in_1');
    assert.equal(v.mismatches[0].source_title, 'Two');
    assert.equal(v.mismatches[0].chart_title, 'Shifted');
  });

  it('fails when the chart lacks an id the source declares', () => {
    const v = verifyAgainstMeta(decls, [{ id: 'in_0', name: 'One' }]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing_from_chart, [{ id: 'in_1', source_title: 'Two' }]);
  });
});

describe('manifestFromSource', () => {
  const decls = parseInputDeclarations(
    'a = input.int(1, "One")\nb = input.bool(false, "Two")\nc = input.color(color.red, "Three")',
  );

  it('pins every literal default and leaves the unevaluable ones out', () => {
    const m = manifestFromSource(decls);
    assert.deepEqual(m.manifest, { in_0: 1, in_1: false });
    assert.deepEqual(m.unpinned.map((u) => u.id), ['in_2']);
  });

  it('applies overrides and records what each one changed', () => {
    const m = manifestFromSource(decls, { in_1: { value: true, why: 'measured' } });
    assert.equal(m.manifest.in_1, true);
    assert.deepEqual(m.overrides, [
      { id: 'in_1', title: 'Two', from: false, to: true, why: 'measured' },
    ]);
  });

  it('reports an override for an id the source does not declare', () => {
    // That means the override list was written against a different revision of
    // the script — which is the renumbering hazard, not a typo to wave through.
    const m = manifestFromSource(decls, { in_99: { value: 1, why: 'stale' } });
    assert.deepEqual(m.unknown_overrides, ['in_99']);
    assert.equal('in_99' in m.manifest, false);
  });
});
