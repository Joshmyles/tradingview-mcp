# Provenance

This repository is a fork of [tradesdontlie/tradingview-mcp][upstream],
narrowed to one job: Pine Script v6 strategy development against a live
TradingView Desktop chart.

## Fork and pin

| | |
| --- | --- |
| `origin` | `git@github.com:Joshmyles/tradingview-mcp.git` |
| `upstream` | `git@github.com:tradesdontlie/tradingview-mcp.git` |
| Pinned upstream SHA | `c05b8f5755ed8e64ea242de88ddbf46aa24d56a4` (2026-07-28) |
| Position at Stage 0 | 5 ahead, 0 behind `upstream/main` |

Upstream is not merged wholesale. Cherry-pick only what a recipe needs.

Known upstream branch not merged: `fix/tab-switch-reattach`, which addresses the
broken `tab_switch`. Low priority — pick it up if and when tab handling is
needed.

## Environment this was built and verified against

| Component | Version |
| --- | --- |
| TradingView Desktop | 3.4.1.8194 (MSIX, `WindowsApps/TradingView.Desktop_3.4.1.8194_x64__n534cwy3pjxzj`) |
| Electron | 41.7.1 |
| Chrome / CDP | 146.0.7680.216 |
| V8 | 14.6.202.34 |
| Node | v22.12.0 |
| npm | 10.9.0 |
| Host OS | Windows 11 Pro for Workstations 10.0.26100 |

Reference chart: `ICMARKETS:XAUUSD`, 45S, study `xVbiv5` ("B14" / "Build 14").

## Tool count and profiles

**95 tools total, split across two profiles.**

| profile | entry point | tools | contents |
| --- | --- | --- | --- |
| workflow | `src/server.js` (default) | **65** | health 5, chart 12, pine 15, data 12, backtest 3, forensics 2, capture 1, indicators 4, replay 7, alerts 3, `ui_evaluate` 1 |
| diagnostic | `src/server-diag.js` | **95** | workflow plus ui 11, drawing 5, batch 1, pane 4, tab 5, watchlist 4 |

Was 84 at Stage 0. Stage 2b added `chart_await_settled`; Stage 4 added
`backtest_run` and `walk_forward`; the input-manifest stage added
`pine_inputs_snapshot`, `pine_inputs_assert`, `resolve_entity` and
`equity_curve`. The finishing stage added `pine_console_read`,
`replay_step_until`, `preflight` and `loss_autopsy` (61 -> 65).

The counts are **derived** in `src/profiles.js` by registering each profile
against a counting stub, not written down. A hand-maintained table was tried
first and was wrong within the hour: it claimed 85 for a profile that
registered 81, because a whole group had been left out of the registration
while its four tools stayed in the table.

Why the split is not cosmetic: this TradingView session has a live IC Markets
broker account attached. `ui_click`, `ui_mouse_click`, `ui_type_text` and
`ui_keyboard` can reach any control on the page, and the order panel is a
control on the page. The named `'trading'` target has been deleted outright,
but generic input synthesis cannot be narrowed by deletion without removing the
tool, so keeping it out of the default surface is the remaining lever.

`ui_evaluate` stays in the workflow profile. It is the route to the Pine Logs
and to historical bars beyond `data_get_ohlcv`'s reach, both load-bearing for
strategy work, and it evaluates an expression rather than synthesising a click.
That is a decision on the record, not an oversight.

## Internals

Every path into TradingView's own runtime lives in [`src/internals/`](src/internals/),
pinned to the TradingView build above and documented in
[`src/internals/README.md`](src/internals/README.md). Re-verify after every
TradingView update using the procedure at the end of that file.

`reportData` — the strategy report object — is an internal, not stable core. It
replaced DOM scraping because it survives CSS churn, not because it is
supported.

## Deletions

Code removed deliberately. Listed here so an upstream merge does not silently
reintroduce it.

### `'trading'` panel target — DELETED

`src/core/ui.js` carried a selector map entry:

```js
'trading': { dataNames: ['trading-button'], ariaLabels: ['Trading Panel'] },
```

`ui_open_panel({ panel: 'trading' })` opened the order panel of the connected
live broker account. Both the map entry and the `'trading'` member of the tool's
`z.enum` are gone, and `openPanel` now throws on an unknown panel rather than
dereferencing `undefined`.

Removed, not flagged. There is nothing here to switch back on. If an upstream
merge reintroduces the map entry, the enum will still reject the value and the
throw will still fire — but delete it again anyway.

### Response-shape changes made deliberately

Not deletions, but contract changes an upstream merge could undo:

- `chart_ready` is **gone** from every mutation response. It asserted a
  readiness that was never verified: measured, `chart_set_timeframe` returned
  `chart_ready: true` at ~3s while the strategy recomputed until 21.6s.
  Mutations now return `{ applied: true, settled: false, fence }`.
- The 6-second `ensureStrategyTesterReady` poll is **gone**, not tuned. It was
  a weaker version of the barrier that now exists.
- Every tool error is now `{ ok: false, success: false, error: { code, message,
  retry, ... } }`. `error` used to be a bare string in 84 hand-written catch
  blocks. `success` is retained as a mirror of `ok` for existing callers.

## Corrections to the design rationale

Recorded because the brief cited them as justification, and they turned out not
to hold.

- **Entity-ID churn across sessions: refuted.** A full TradingView Desktop
  restart on 2026-09-10 left study `xVbiv5` / "B14" with the *same* id. Entity
  ids are stable across restarts. `resolve_entity` is still worth building —
  removing and re-adding a study does mint a new id, and a stale study from a
  previous session still needs catching — but the restart argument must not be
  used to justify it.

  (During the restart's load phase, `dataSources()` briefly reported unfamiliar
  ids with no resolvable study object. Those are pre-load placeholders, not the
  study's identity. Do not sample identity before the chart has settled.)

## Hazards

- **TradingView Desktop runs several page contexts per chart, and more than
  one can look like the chart at once.** Measured 2026-09-10, `/json/list`
  reported four chart pages:

  | id | layout | vis | inner | outer | screenXY | focus |
  | --- | --- | --- | --- | --- | --- | --- |
  | `09EBFD9A` | Trial Ground | visible | 1920x1044 | **1920x1080** | -1920, 0 | **true** |
  | `962BE3C0` | Trial Ground | visible | 1920x1044 | 1920x1044 | 0, 0 | false |
  | `67BD8A45` | Esemble | hidden | 500x318 | 0x0 | 0, 0 | false |
  | `8AF118B4` | Esemble | hidden | 500x318 | 0x0 | 0, 0 | false |

  None of the extras are stubs — each carries a complete `TradingViewApi`, its
  own model, symbol and resolution, and for the same-layout duplicate the same
  study ids. And they are not the same chart: sampled in the same second, the
  two Trial Ground contexts held **329 bars over `[-16, 312]`** against **381
  bars over `[0, 380]`**, with different visible ranges. On a 45S chart the
  backtest window follows the loaded bar count, so attaching to the wrong one
  is a correctness hazard.

  **`visibilityState` is not the discriminator, and an earlier version of this
  file said it was.** Two corrections, both measured:

  - The same-layout duplicate reports `visible`. It reported `hidden` at
    500x318 an hour earlier — it is re-used as the layout preview renderer and
    returns to full size afterwards, so its visibility and viewport both change
    while nobody touches the chart.
  - Minimising the real window does **not** make it hidden. Driven through
    user32 `ShowWindow(SW_MINIMIZE)`, the real context still reported
    `visible`; only its OS geometry moved, to outer `[199, 34]` at
    `[-32000, -32000]`. So the feared failure mode — every read refused against
    a minimised TradingView — does not occur on this build, and the fallback
    that was specified for it is not needed for that reason.

  What does separate them: `document.hasFocus()` (definitive when TradingView
  is foreground) and OS window chrome (`outerHeight` differing from
  `innerHeight`; the duplicate's outer is permanently equal to its inner and
  the previews report `[0, 0]`). `selectTarget()` tries `focused`,
  `os_window`, `visible_largest`, `largest_viewport` in order, records the
  winner as `selected_by`, and **refuses when no rule leaves a unique winner**
  rather than picking one. `TV_CDP_TARGET` pins outright; `TV_CDP_LAYOUT`
  narrows by layout name.

  While this was unknown it produced two false findings — a chart diagnosed as
  wedged at 0 bars with no error on any channel, and a probe recording zero
  fires from the series event bus. Both were reads of a preview.

- **`npm test`'s e2e suite is destructive against the working chart.** On
  2026-09-10 it left four indicators behind (EMA, RSI, ATR, MACD) and wedged
  symbol resolution chart-wide: `seriesErrorMessage() === 'resolve error'`, 0
  bars, every study at `status().type === 3`, with the UI showing "This symbol
  doesn't exist". `setSymbol`, `rerequestData()` and switching to a known-good
  symbol all failed to clear it; only an application restart recovered it.

  **Resolved.** `npm test` now runs the unit suites only and touches no live
  chart. The e2e and smoke suites run only against a dedicated fixture layout
  (`MCP-FIXTURE`) and only with `TV_MCP_ALLOW_DESTRUCTIVE=1`; the guard in
  `tests/_fixture-guard.js` additionally requires the attached context to be
  the visible one and refuses the live research layout by name. See
  `tests/fixtures/README.md`.

## Measurement provenance after the multi-context finding

Every measurement taken before `connection.js` pinned a context came from a
target chosen by URL match alone, from a pool of four. The prior evidence was
split deliberately rather than re-run wholesale.

### Carried forward, not re-measured

Units net of commission; `rn`/`dd` unsigned with direction in `e.tp`;
MAE-measured-from-entry; the 12-fill derivation; per-leg attribution. These
were established by internal consistency across 105 rows — the book was
self-consistent, therefore real — and conclusions about the DATA MODEL do not
depend on which context produced the data.

### Re-measured on the pinned visible context, 2026-09-10

Sampled in-page at 4ms intervals so neither CDP round-trip latency nor
hidden-page timer throttling is inside the number.

| figure | before | after | verdict |
| --- | --- | --- | --- |
| settle window, 45S->30S | 21.3 / 28.4 / 19.2s | **30.2s** | reproduces; not throttle |
| settle window, 30S->45S | — | **21.6s** | reproduces the 21.3s figure |
| series staleness after mutation | ~525ms | **139-380ms** | reproduces; variable, so no fixed sleep is safe |

Two things the re-measurement added that the original missed:

- **`completed` fires TWICE per rebuild.** An initial load
  (`loading`+`cleared`+`completed`, bars -> 300) and then a second
  `loading`/`completed` 6-8s later for the deeper history (bars -> 316). The
  gate is safe only because `seriesRebuilt` also requires
  `isLoading() === false`; dropping that conjunct as redundant would reintroduce
  the bug with an 8-second window.
- **The recompute is not one-shot.** On a live streaming chart the study drops
  back to LOADING on every new bar and takes another full recompute to reach
  READY — measured 13.1s and 21.4s inside a 45s bar period. A barrier that
  samples once and finds LOADING may simply have arrived mid-cycle.

### Re-derived on the pinned visible context

The full book and every figure drawn from it. **Bit-identical** to the
carried-forward values: 105 trades, net 177.21, PF 1.5982, gross 473.47 /
296.26, window from 1787695320000, `rows_explained: true`,
`pnl_identity.max_abs_error: 0`, MAE distributions, the BASE/ADD split, the
counterfactual table and the concentration measures all reproduce exactly.
Re-derived again after a 45S->30S->45S round trip: unchanged.

So no recorded figure inherits a preview reading. The concern was correct to
raise and the answer is that this particular book was never taken from one.

## Probed and not found

Recorded so the next attempt does not repeat the search.

### `dateRange.backtest` is not settable

The walk-forward was specified against `dateRange.backtest`. It is engine
OUTPUT, not a setting: `reportData().settings.dateRange` describes the range
the strategy actually ran over, which follows the loaded bar history. The
study's property tree carries only `strategy.orders.{showLabels,showQty,
visible}`, and nothing matching `date`/`range`/`backtest` is writable on the
chart widget, the model, or the study. There is nothing to set.

**What exists instead: Deep Backtesting**, which takes an explicit
`(from, to)` and runs server-side. Reached by walking React fibers for a
`memoizedProps.value` carrying `_deepBacktestingManager` — see
`src/internals/deepbt.js`. Measured: a 7-day 45S window returns in 13-20s and
does not touch the chart at all. This is better than the specified mechanism
for the purpose, and `backtest_run({ window })` / `walk_forward` are built on
it.

Two traps recorded there, both measured:

- **The deep report stays cached and keeps reporting status 2 for the previous
  window.** `resetDeepBacktestingReportData()` does NOT clear it. Only a
  `done` EDGE counted since the request proves the report is this one's.
- **TradingView snaps a requested window to available data.** Asking for
  `1787695320000..1788300000000` returned `1787616030000..1788220785000`. Two
  different requests snapped to the same window, so window equality — and even
  window overlap — cannot distinguish a fresh report from the cached one.
  Always read the returned window; never assume the requested one was used.

### There is no intrabar-detail correction to make: excursions are resolution-invariant

Worth stating at length because it was assumed to exist for months and the
assumption shaped a stop-level analysis.

A deep run over the same window as the on-chart book, matched trade-for-trade,
gave **99 identical MAE values out of 100**. That was recorded as "Deep
Backtesting is not the detalization fix". The real finding is stronger: the
identical result was not a property of Deep Backtesting, it was arithmetic.

Re-running the validated 45S excursion scanner against **5S** bars (15 legs
covered) and **1S** bars (6 legs) on 2026-09-11 gave deltas of **exactly zero**
on every leg, for both MAE and MFE. A coarse bar's high *is* the maximum of the
fine bars' highs inside it, and every entry and exit in the book falls on a 45S
bar boundary (101 of 101), so the ends contribute nothing either.

Consequences:

- **Reported MAE is already the true worst excursion.** A stop level fitted
  against it needs no detalization uplift, and the flip-factor hedging recorded
  against `mae-stop-level-from-book` was guarding against an understatement
  that does not exist.
- What resolution *does* govern is fill **sequencing** within a bar — whether a
  stop or a target filled first. That is an execution question;
  `tighteningBenefit` brackets it with `same_bar_can_stop` rather than assuming
  an answer.
- What finer bars *do* buy is the excursion **path**: `mae_at`/`mfe_at` are
  quantised by the leg's bar count, so short legs are badly resolved at 45S.

Seconds history is capped by **bar count, not span** — about 21,000 bars at
every resolution, so 45S reaches 366h, 5S 30.5h and 1S 6.5h, each on
`endOfData`. Finer resolution buys detail by spending coverage.

### The price series is a viewport cache, not the backtest range

Measured on the live 45S chart: **372 bars loaded** against a **21,518-bar
book**, in the same instant. Two traps follow, both silent, both recorded in
`src/internals/README.md`:

- **The bar index spaces differ.** `trades[].e.b` counts from the study's first
  bar; `bars().firstIndex()` is negative and rebases on load. Joining on index
  reads the wrong bars and produces a plausible answer. Join by time.
- **History must be pulled in first.** `requestMoreData(n)` works — 372 to
  21,675 bars in 3.8s — but it moves `dateRange.backtest.from`, so any report
  read before it describes a different book. Re-read afterwards.

### `dd`/`rn` are leg-equity excursions, not price excursions

Reconstructing them from bar extremes matched **0 of 106**. Adding the
entry-side commission, clipping the exit bar to its exit price, and flooring at
zero takes it to **106 of 106**. A price stop triggers on a move **0.11 smaller
than the reported MAE** — see `mae_price_only`.

## Known gaps

- **Sharpe: reconstructed, and the TradingView figure is now IDENTIFIED rather
  than merely different.** `reportData.equity` and `.equityChart` still do not
  exist, and `data_get_equity` still returns a **per closed trade** curve that
  must never be compared against `maxStrategyDrawDown`.

  `equity_curve` (B4) builds a per-bar mark-to-market curve from the trade legs
  joined against price bars **by time**, with the method stated in
  `src/internals/equity.js` and validated on every run by recomputing each
  leg's MAE and MFE from the same bars — 106 of 106 on 2026-09-10, and 101 of
  101 on a rolled book the next day, which is the stronger evidence: the model
  was not refitted.

  Position state comes from the trade rows, **not** from `filledOrders` as
  originally specified: a filled order's `tm` is a bar sequence number, and a
  join needs a time. The rows are a complete leg-level ledger, so nothing is
  lost by the substitution.

  **TradingView reports a non-annualised DAILY Sharpe.** Measured 2026-09-11
  against a reported 0.3701: daily un-annualised on the reconstructed curve is
  0.3507 (sample sd) / 0.3640 (population sd), and 0.25–0.37 across every day
  boundary tried, while per-bar is 0.0064, hourly 0.0572 and per-trade 0.1229.
  The interval is identified; the residual is the day boundary and the sd
  convention, neither exposed. The conversion is `sqrt(252)` ≈ 15.9.

  So the earlier reading — "4.3 to 7.1 here against 0.52 there, unexplained" —
  was an annualisation difference, not a method dispute. **A Sharpe threshold
  must still name its method**, and for the opposite reason to the one first
  recorded: a bar of 2.3 asserted against the TradingView display demands about
  **36 annualised**, which nothing real reaches.

- **`maxStrategyDrawDown` is not reconcilable with TradingView's own run-up.**
  `maxRunUp` 275.04 matches the intrabar envelope of the reconstructed curve
  (275.82) and cannot come from the closed-trade curve (213.65), which
  identifies TradingView's curve as per-bar, intrabar, including open
  positions. On that same curve the drawdown is **121.96** against a reported
  **60.68** — a factor of 2.01. The closed-trade curve gives 57.95, close but
  not equal, so a closed-trade basis does not explain it either.

  Not a defect in either curve that has been demonstrated; it is an internal
  inconsistency in the reported figures, measured two ways. Treat the envelope
  as what the position experienced and the reported drawdown as an
  understatement of roughly half.

- **The live study was found carrying levers recorded as refuted.** Measured
  2026-09-11 with the new `pine_inputs_snapshot`, the B14 study (`xVbiv5`) had
  `in_323` (re-enter on the opposite CZ break), `in_315` (take the opposite
  side after a hard stop) and `in_278` (add on same-direction CZ breaks) all
  **true** against compiled defaults of false, and `in_344` (Bar Magnifier)
  true. The first two are recorded elsewhere as measured and switched off.

  This is exactly the failure `pine_inputs_snapshot` / `pine_inputs_assert` were
  built for, and it means every figure taken from this chart before that date -
  including the equity-curve and concentration work of 2026-09-10/11 - describes
  a configuration that was not the intended one. The numbers are internally
  valid; what they describe was not verified. Pass `manifest` to `backtest_run`
  from now on.

  **Corrected 2026-09-11**: the three levers were set to their defaults, the
  study now asserts 334 of 334 against `manifests/b14.intended.json`, and both
  configurations were measured over the same eight windows. See "The drift is
  measured" below for what it was worth.

  A note on reading such a book: with `in_278` on, TradingView pairs exits FIFO,
  so per-ROW attribution within a pyramided stack is TradingView's construct
  rather than a per-decision truth. Aggregates over the book are unaffected;
  statements about *which* row was the winner inherit the pairing.

- **The drift is measured, and it was churn.** Build 14 was found carrying
  `in_323` (OPPX), `in_315` (RVX) and `in_278` (PYRX) on against compiled
  defaults of false. The as-found configuration is preserved in full at
  `manifests/b14.as-found.2026-09-11.json` so every figure that describes it
  stays re-derivable; the reference configuration is
  `manifests/b14.intended.json`, derived from source.

  The same eight disjoint 7-day deep windows, run at both configurations:

  | | drifted | intended |
  |---|---|---|
  | legs | **348** | **177** |
  | pooled net | **405.46** | **400.95** |
  | windows net-positive | 7 of 8 | 6 of 8 |
  | PF range | 0.65 – 3.12 | 0.66 – 4.33 |
  | top-3 share of gross win | 33 – 73% | **51 – 88%** |
  | gini of winners | 0.53 – 0.74 | 0.53 – 0.70 |

  Three levers, 171 extra legs, **−4.51 net**. At 0.22 round-trip they cost
  about 37 in commission alone to return nothing. Per-window P&L moved
  substantially — the worst drifted week (−93.56) becomes +7.01, and two
  positive weeks become negative — which is what a coin-flip mechanic does.

  **The concentration is a property of build 14, not of the drift.** The
  hypothesis was that re-entry plus stacking generates the long-tail-of-small-
  losses profile. Measured, removing them makes concentration MORE extreme, not
  less, and these rows are unambiguous: with PYRX off nothing stacks, the `ADD`
  token disappears from the book entirely (60 legs to 0), and no exit is paired
  FIFO across legs.

  A caution that cuts the other way: pooled across the drifted windows the
  `ADD` rows show +221.48 over 60 legs against +219.84 over 288 non-ADD rows,
  which reads as though pyramiding carried the book. It cannot be read that
  way. That split is precisely the FIFO attribution TradingView invents inside
  a stack, and the aggregate — which does not depend on the pairing — says the
  three levers were worth −4.51.

- **A live alert carries its own frozen configuration, and this one is
  drifted.** The active strategy alert on B14 (`5574059086`) embeds a complete
  351-entry input map at `pine_version 0.43` against the chart's `0.46`, with
  all three levers still on. Correcting the study did not change it and cannot:
  an alert runs what it was created with. Three configurations can differ at
  once — chart, backtest, live — and only the alert's own map describes live
  orders.

- **`in_N` is a position, and the properties are not in the source.**
  `in_0..in_325` are B14's `input.*` declarations, `in_326`/`in_327` do not
  exist, and `in_328..in_352` are TradingView's strategy properties. The array
  index of `getInputValues()` is not the id. Full table in
  `src/internals/README.md`.

- **Recorded build results have mixed provenance.** Any performance figure
  collected through the tool path after a mutation, before the barrier existed,
  is unverified — it may describe the previous chart state. Which recorded
  results came through which path has not yet been established, and none of
  them should be used as a baseline until it has.


## Finishing stage — 2026-09-11

Four tools added, each verified against the live chart (B14, `xVbiv5`,
ICMARKETS:XAUUSD 45S) through a direct CDP harness running the code on disk,
because the MCP server process predates them.

| tool | live verification | status |
| --- | --- | --- |
| `pine_console_read` | all three collection states (`absent` on a non-logging study, `disabled` as found, `present` with 1,267 rows); prefix/level filters (CENSUS 1119, CFG 2, TELX 116); 4 cursor pages = 1,267 rows, 0 duplicates, full coverage; invalid/stale/beyond-end cursors refused; ambiguity refused; read left the log intact (1,267 -> 1,267); mask restored | **verified** |
| `replay_step_until` | six argument refusals before touching replay; refuses when replay not started; `already_true`; 6 bars to a time predicate in 2.3s (median step 367ms); `max_bars`; `any` + `changed`; 900-char payload for 6 bars | **verified** |
| `preflight` | study PASS (exact title), source PASS (sha256 `ec851a5f…` matches), inputs FAIL 333/334 (`in_315` true — see below), alerts FAIL (`5574059086` active, v0.43 vs chart v0.46, `in_278`/`in_315`/`in_323`); nothing modified | **verified** |
| `loss_autopsy` | trade 0 (short, `B CZX DN`, -7.26): three views centred and captured (45S/5/60), history extended where not loaded, chart restored `matches_as_found: true` in 62s; **drawings not joinable** — x space unidentified | **partial** |

Defects found and fixed on the way:

- `chart_scroll_to_date` read `45S` as 45 **minutes** (`parseInt('45S') * 60`) —
  a 60-fold wrong window on the reference resolution. `resolutionSeconds()`
  now parses the `S` suffix.
- **`replay_stop` left a saved replay session in the layout.** `stopReplay()`
  mid-history saves one, and TradingView then blocks the chart with "Continue
  your last replay?" on the next load. Every programmatic replay did this. It
  now clears the session and verifies the clear.
- The old `pine_get_console` opened the Pine Editor as a side effect;
  `pine_console_read` reads the study's own log collection instead.

Re-verified through the MCP surface after the server restart — the harness
ran the core modules but never the registration, the zod schemas, or
`jsonResult`, and that is where every difference below lived:

- **Registration: `tools/list` failed for the WHOLE server.** Four schemas used
  `z.record(z.any())`; under zod 4 the one-argument form leaves the value type
  undefined and the SDK's JSON-Schema conversion threw "Cannot read properties
  of undefined (reading '_zod')". Every tool was invisible to the client, not
  just the new one — three of the four (`pine_inputs_assert.manifest`,
  `backtest_run.manifest`, `walk_forward.manifest`) predate this stage, so the
  listing had been broken since the manifest work. Stub counting never converts
  a schema; `tests/tool-listing.test.js` now lists both profiles through a real
  `McpServer`.
- **Envelope: `pine_console_read.level`** was a `z.enum`, so a bad level came
  back as a bare SDK `-32602` instead of the standard `invalid_argument`
  envelope. Now a string, validated by the core.
- **Budget: two truncation layers disagreed and lost rows.** `limit: 500` built
  a 119,651-char page; the global response budget dropped 43 rows off its end
  while `next_cursor` still pointed past them, so paging silently skipped 43
  rows. Claude Code also rejected that result outright as over its per-result
  limit. Pages are now capped inside the tool at three quarters of the
  response budget (`truncation.reason: 'size'`), so the global trim never
  touches them.
- Logic, found on the way: an invalid `since_cursor` was accepted whenever the
  collection was disabled or absent; now refused first.
- `loss_autopsy` layout pinning: `loadChartFromServer({ id })` rejects —
  TradingView needs its saved-chart entry — and `switchLayout` returned on the
  OLD layout's name. Both fixed; the switch itself is not live-verified, because
  no second saved layout carries B14 (that is what `MCP-FIXTURE` is for).

- `loss_autopsy` did not restore the viewport: run through the surface on trade
  0 it came back on the right layout and resolution but two weeks in the past,
  and still reported `matches_as_found: true`, because the check never
  compared the visible range. It now records the range by time, restores it
  with the existing `setVisibleRange`, and fails `matches_as_found` if the view
  is not back within two bars. The chart was put back by hand with
  `chart_set_visible_range` this time.

Through the surface: `preflight` output identical to the harness;
`replay_step_until` 7 bars to a time predicate in 2.7s (median step 387ms),
report-tier predicate refused before stepping, `replay_stop` cleared a saved
session; `pine_console_read` filters, refusals and envelope as specified.

Found and NOT fixed, by design:

- **`in_315` (RVX) drifted back to `true`** on the live study after G1 set it
  false and asserted 334/334. Nothing in the bridge wrote it. **Mechanism
  identified:** an API input write never marks the layout dirty, so it is not
  saved, and a reload restores the saved copy — which holds `in_315` true and
  `in_278`/`in_323` false. See `src/internals/README.md`, "Input writes live in
  memory until something else saves the layout", and the correction procedure
  in `manifests/README.md`. Left as found.
- **Live alert `5574059086` still runs the drifted configuration.** Reported,
  not recreated — that is a live-execution change for the account owner.

Three corrections before the freeze, same day:

- **Response budget default lowered from 120,000 to 40,000 characters, in two
  steps.** The 120,000 sat above the client's cap, and the client does not
  trim — it refuses: measured through Claude Code, 119,651 and 86,118
  characters of pretty-printed JSON were both replaced by an error, 20,633
  accepted. The first correction set 60,000, reasoning from those two points
  that the cap (25,000 tokens) bites under 3.5 characters a token. **That was
  wrong, and the surface said so:** after the server restart, a
  `pine_inputs_snapshot` trimmed to 59,539 characters by the new default was
  refused as well. A crude tokeniser puts every one of the refused payloads at
  2.27–2.37 characters a token (the 59,539 one at 26,195 tokens), so the cap
  bites near 57,000 on this bridge's JSON and 60,000 sat above it. The default
  is now 40,000 — about 17,500 tokens by the same count — and the module
  comment carries the table. A ceiling above the client's cap turns a large
  answer into no answer. A whole trade book cannot reach the client at any
  setting, so the old ceiling served only the direct harness, which sets
  `TV_MAX_RESPONSE_CHARS=120000` for itself. The `pine_console_read` page cap
  is derived from the budget (three quarters of it) and sized on the
  pretty-printed rows the client receives, so the two truncation layers cannot
  drift apart again. Writing bulk rows to a file is parked.
- **"As found" is now an enumerated list.** `loss_autopsy` compares layout,
  symbol, resolution and the visible range by time — `AS_FOUND` in
  `src/core/autopsy.js`, asserted by the unit test and printed in every packet
  as `restored.as_found` with found and left values. The list also says what
  is deliberately not restored (history depth, bar-index range, replay,
  visibility, drawings, chart type) and why.
- **The saved baseline was re-anchored.** The 08:17:22 save persisted whatever
  was in memory, so `manifests/b14.saved.2026-09-11.json` records the B14
  configuration the saved layout now holds (hash `d6707b26`, 351 inputs, 16
  non-default), with its own diffs: against as-found, `in_278` and `in_323`
  went true → false; against intended, `in_315` alone. Read from memory 29
  minutes after the save with both dirty flags false and no API write in
  between; not confirmed by a reload, and the file says so.
- **Smoke now includes tools/list through the real entry points.** Both
  `src/server.js` and `src/server-diag.js` are spawned over stdio and must
  list every tool of their profile. "Smoke is green" therefore includes the
  surface a client sees, which the unit suite provably cannot.

Still outstanding against the definition of done:

- **Smoke suite against `MCP-FIXTURE`: blocked.** The layout does not exist
  (saved layouts: Josh, Trial Ground, Esemble, Unnamed). It is created by hand
  by design — `tests/fixtures/README.md` — and was not provisioned here. It
  now blocks three things: smoke, the `loss_autopsy` layout-switch path, and
  the tag.
- **Live verification through the surface, after the restart.** The server
  was restarted onto the 60,000 default and the budget was checked first: a
  `pine_inputs_snapshot` with `include: ["all","manifest"]` came back trimmed
  to 59,539 characters (`response_budget.applied: true`, 351 → fewer inputs)
  and Claude Code refused it anyway. That is the finding that lowered the
  default to 40,000; the running server does not have 40,000 until it is
  restarted again, and the check is then the same call, which must arrive
  inline. Two things could not be verified on Trial Ground: the console page
  cap, because B14's log collection is switched off there (`log_level_mask`
  all false) and turning it on is an input write to the live layout; and the
  autopsy view restore, which changes the chart. Both run on `MCP-FIXTURE`.
  `data_get_trades` without `max_trades` returns at most 20 rows by its own
  cap, so it exercises no budget. Read-only calls only; the chart was left as
  found (Trial Ground, XAUUSD 45S).
- **`loss_autopsy` drawings.** Needs the primitive index space identified.
- Commit and version tag await explicit authorisation.

## Standing constraints

- **No live order execution belongs in this bridge.** Orders route via alert
  webhook to a separate execution service against the cTrader API. Any code path
  that can place a live order is to be deleted, not disabled — removing the code
  is the guarantee, a flag is not.
- The TradingView session in use has a live IC Markets broker account attached.
  Treat any UI-reaching capability accordingly.
- **Never re-fit a stop parameter on the output of a build that already carries
  a stop.** Reported MAE is truncated at the stop by construction (this is what
  correction #2 in the excursion model is), so a stopped build reports a
  censored MAE distribution. Keep the no-stop run as the reference distribution
  and go back to one for any re-fit; otherwise each iteration fits to its
  predecessor's censoring and the error compounds. The current 45S book is
  already stopped -- 31 of 101 exits `HS`, 29 `RT` -- so it can measure what an
  ADDITIONAL rule would have cost and cannot fit a stop level.

- **A manifest is derived from the build's source plus an explicit override
  list, never from a chart snapshot.** The chart is what a manifest checks;
  deriving the reference from it makes the check vacuous, which is how an
  unintended configuration became the baseline in the first place. Manifests
  are keyed per build and do not carry forward: `in_N` is a position, so the
  same id means something different in a script with a different set of
  declarations. Asserting one build against another build's manifest is an
  error, not a mismatch report.
- **Build 14 is frozen.** No edit to `build14.pine`. Any change to the Pine
  source forks to build 15. Setting inputs, running windows, snapshotting and
  asserting manifests are not script changes and stay on build 14.

[upstream]: https://github.com/tradesdontlie/tradingview-mcp
