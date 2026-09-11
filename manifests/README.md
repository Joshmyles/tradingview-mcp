# Manifests

A manifest states which configuration a performance figure describes. Without
one, every number in this repository describes whatever the study happened to
be set to when it was read — which is not hypothetical: build 14 was found
carrying three levers recorded as refuted, and every figure taken before
2026-09-11 describes them.

## The files

| file | what it is |
| --- | --- |
| `b14.overrides.json` | The only hand-written file. Every deliberate departure from the source default, with a reason for each. |
| `b14.intended.json` | **Build 14's reference.** Generated from `build14.pine` plus the overrides. Assert against this. |
| `b14.as-found.2026-09-11.json` | The drifted configuration, recorded in full before it was corrected, so the figures that describe it stay re-derivable. Never assert against it. |

## Regenerating

```
node scripts/make-manifest.mjs manifests/b14.overrides.json
```

Edit `b14.overrides.json` and regenerate; never hand-edit `b14.intended.json`.

## Two rules, both load-bearing

**Derived from source, never from a chart.** The chart is what a manifest
checks. Building the reference from a snapshot of the chart makes the check
vacuous — it can only ever confirm that the chart equals itself. Defaults come
from the `input.*` declarations in the Pine source; anything else is an
override and carries a reason.

**One manifest per build.** `in_N` is a POSITION, not a name: TradingView
numbers inputs by the order their `input.*` calls appear. Deleting one input
renumbers every input after it, so build 14's manifest asserts nothing
meaningful about build 15 — it asserts the wrong inputs, confidently. Hence the
`source_sha256` on every generated manifest, and hence `pine_inputs_assert`
returning `wrong_build` rather than a mismatch report when the title does not
match.

## What a manifest cannot cover

- **Colour inputs whose source default is an expression** (`color.new(...)`).
  They have no value until the script compiles, so they are left unpinned
  rather than guessed — 17 of them on build 14. A partial manifest is legal;
  `pine_inputs_assert` counts what it did not pin instead of failing on it.
- **The strategy properties** (`in_328..in_352` — commission, slippage,
  pyramiding, Bar Magnifier, FIFO, risk-free rate) are not in the Pine source
  at all. They decide what a backtest *means*, so they are pinned by hand in
  the overrides file with a reason each.
- **Live behaviour.** A TradingView alert embeds its own frozen copy of the
  inputs at the moment it was created. Asserting the chart says nothing about
  what a running alert executes; read the alert's own map for that.
