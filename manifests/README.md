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
| `b14.saved.2026-09-11.json` | **The saved layout's baseline** after the explicit save of 08:17:22 UTC — what a reload restores. Carries its own diffs: against as-found (`in_278`, `in_323` now false) and against intended (`in_315` only). Never assert against it; diff against it to catch the next drift. |

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

## Correcting a study to its manifest: save the layout, then re-assert

An input written through the API is **not saved**. Measured 2026-09-11 on
Trial Ground, autosave on: `setInputValues` (what `indicator_set_inputs` and
every scripted correction use) changes the study in memory, but neither dirty
flag moves (`_saveChartService.hasChanges()`,
`_chartWidgetCollection.hasChanges()`), so autosave never fires and the
server copy is unchanged. A layout reload then restores the server copy: `in_44`
written `false` came back `true` after a reload that genuinely rebuilt the
study.

The write is not lost for certain, either. Any later change that DOES mark the
layout dirty — a resolution change, for one — lets autosave save everything in
memory, the API writes included. So whether a correction outlives a reload
depends on what happened after it, and is not knowable from the correction
itself.

Procedure, every time a study is corrected to its manifest:

1. Write the corrections.
2. `pine_inputs_assert` against the manifest; it must pass.
3. **Save the layout explicitly** (`TradingViewApi.saveChartToServer()`), and
   confirm the saved layout's `modified` stamp moved.
4. Reload the layout and run `preflight` again. Only a pass *after a reload*
   says the correction is on the server rather than in memory.
5. `pine_inputs_snapshot` with `include: ["all", "manifest"]`, and record it as
   `<build>.saved.<date>.json`. A save persists everything in memory at that
   moment, so every save moves the baseline the next drift will be measured
   against; without the snapshot, "it drifted" has nothing to be measured from.
   The 2026-09-11 save was taken this way (the snapshot was read from memory
   with both dirty flags false after the save, not after a reload — the file
   says so).

Why the as-found and saved files both exist: the as-found file is what the
figures taken before the correction describe; the saved file is what the chart
will hold after any reload from now on. On 2026-09-11 they differ in two
levers, because the 08:17 save caught `in_278` and `in_323` corrected and
`in_315` not — a reload had already put `in_315` back before the save.

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
