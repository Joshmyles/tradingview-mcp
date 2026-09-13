# Phase 0.6 — Recovery, the Silent-Success Sweep, and the First Order

Measured 2026-09-12 against TradingView Desktop 3.4.1.8194, layout `R7HDoRZ2` ("Trial Ground"),
`ICMARKETS:XAUUSD` 45S, strategy `xVbiv5` = Build 15.

Everything below is tagged **FINDING** (measured), **ASSUMPTION** (reasoned, not measured) or
**UNKNOWN**. Assumptions are collected separately in §8.

---

## 0. Summary

All six tasks completed. The session is recovered, the order ran, and five of seven pre-registered
predictions held.

**Three corrections to things Phase 0.5 or the prompt stated as fact:**

1. **The chart has 5 drawings, not 29.** The 29 are `AlertLabel` sources — one per active alert,
   rendered from the alert service and absent from the saved layout. Phase 0.5 counted them as
   drawings and priced the reload risk off that number. The reload risk was roughly six times smaller
   than reported.
2. **Autosave was ON and there were zero unsaved changes** before the reload. Phase 0.5 said it could
   not verify the autosave setting; it is readable at
   `_saveChartService.autoSaveEnabled()` / `.hasChanges()`.
3. **`TradingViewApi.saveChart()` is not a save.** Its body serialises to JSON and hands the result to
   a callback; it never reaches the server. The real path is `_saveChartService.saveExistentChart()`.
   Calling the first and reporting "layout saved" would have been this phase's own defect class.

**Nothing was lost.** The five drawings came back byte-identical — same ids, points and properties —
and the B15 manifest hash is unchanged at `b8d3b7ff`.

**The order filled.** One market order, qty 1, `order_2481ed79-1dc0-4828-9e3d-dc5bb0ec82c8`, entry
4452.39, exit 4451.39, commission 0.22 round turn, net −1.22. The account is flat.

**The headline measurement: $1.00 of P&L per $1.00 of price at qty 1, confirmed three times.
One contract = one ounce. A2 is settled.**

---

## 1. Task 1 — preserve chart state

### FINDING — the drawing count was wrong, and by a lot

Three independent enumerations agree on **5**:

| surface | result |
|---|---|
| `chartWidget.getAllShapes()` | 5 |
| model line-tool scan (`toolname` starting `LineTool`) | 5 |
| saved-layout serialization `model().state(true).panes[].sources[]` | 5 |

The five: `LineToolRiskRewardLong`, `LineToolRiskRewardShort`, `LineToolTrendLine`,
`LineToolCallout` ×2.

The 29 are a different family entirely — `AlertLabel` sources, one per active price alert. They do
**not** appear in the saved layout (`layout_source_types` = MainSeries 1, Study 11, StudyStrategy 1,
plus the five line tools), because they are re-rendered from the alert service on load. They came
back after the reload, as expected.

**Why this matters beyond bookkeeping:** the reload was held back in Phase 0.5 on the strength of "29
drawings at risk". The real exposure was five drawings, on a layout with autosave on and no unsaved
changes.

### What was built

- **`scripts/dump-chart-state.mjs`** — dumps every drawing three ways (TradingView's own
  `state(true)` serialization, the model's live points, resolved properties), plus studies and alert
  labels as context. It **refuses to call itself a backup** unless every drawing has an id, a
  toolname, a usable state, points and properties, *and* the model and widget enumerations agree on
  the same id set. On refusal it writes a `.REJECTED.json` so the failure is inspectable.
- **`scripts/save-chart-layout.mjs`** — the real save, with the `_doSave` navigation hazard
  (`location.pathname === '/chart/'` assigns `location.href`) checked **before** calling rather than
  discovered after. Reports the observed before/after change state.
- **`scripts/reload-chart.mjs`** — refuses to run without a verified dump on disk, then polls for
  genuine readiness (main series has bars) rather than for the load event.
- **`scripts/compare-chart-state.mjs`** — diffs two dumps on points and properties, not just ids,
  and prints which fields it excluded as volatile.

Dump verified: 29,038 bytes, re-read from disk and re-parsed. Layout saved, server returned uid
`R7HDoRZ2`. Reload completed and the chart became usable in 44.7 s.

---

## 2. Task 2 — verify recovery

### FINDING — recovered, on all four checks

| check | result |
|---|---|
| `doStep()` settles | yes, 496 / 548 / 589 ms |
| cursor advances | yes, 1788220799 → …829 → …874 → …919 |
| autoplay moves | yes, +225 s in ~6 s at 1000 ms delay = 5 bars |
| `replay_step` throws on an unchanged cursor | pinned by `tests/replay.test.js`, passing |
| drawings survived | **identical** — 5/5, same ids, points, properties |
| manifest hash | **`b8d3b7ff`**, unchanged; 353 inputs, pine 0.51 |

### FINDING — step granularity at 45S is genuinely per-bar. This closes the Phase 0.5 UNKNOWN.

Recorded as unknown in Phase 0.5 §4.2 because the session wedged before it could be measured. The
recovery run measured it incidentally: consecutive cursors 1788220829 → 1788220874 → 1788220919 are
**exactly 45 s apart**, and autoplay advanced 225 s = 5 × 45 s. The first step from the start cursor
was 30 s because the start instant (`…799`, 23:59:59) is not on a bar boundary; it snaps, then steps
one bar at a time.

### FINDING — the reload cleared the wedge by ending replay outright

Post-reload the session was gone, not repaired: `is_replay_started false`, `is_in_replay false`,
`current_broker null`. Replay had to be restarted from scratch. Worth knowing for any future
recovery: the reload is not a "resume", and a saved replay session does not survive it here.

---

## 3. Task 3 — the silent-success sweep

Audited all **94 tools** (65 workflow + 29 diagnostic-only, now 95/65 with `replay_health`) against:

> A tool may report success only if it has observed the state change it claims to have caused.

The full inventory is **`tests/fixtures/silent-success-audit.json`** — every `success: true` site in
`src/core/*.js` with a classification and a written reason, including the sites that passed.
`tests/silent-success.test.js` fails if a site appears in the code without an entry, if an entry is a
placeholder, if an entry is stale, or if any of the fixed mutations reverts to a bare success.

### FINDING — the dominant pattern is *evidence computed, then ignored*

**Eight of the defects already had the observation in hand and simply did not consult it.** This is
the `pine_inputs_assert` shape again and it is the reason the fix is structural rather than a list of
patches:

| tool | the evidence it already had | what it returned |
|---|---|---|
| `draw_shape` | before/after shape-id diff | `success: true` with `entity_id: null` |
| `draw_remove_one` | `removed: !stillExists` | `success: true` regardless |
| `indicator_toggle_visibility` | `study.isVisible()` read back | `success: true` regardless |
| `chart_set_visible_range` | `actual` range re-read | `success: true` regardless |
| `pane_set_layout` | full re-read of the pane list | `success: true`, never compared |
| `pine_smart_compile` | `study_added` from a study-count delta | `success: true` regardless |
| `watchlist_remove` | `verified: stillPresent.length === 0` | `success: true` regardless |
| `tv_launch` | `cdp_ready: false` | **`success: true`** |

### FINDING — the most consequential defect is `indicator_set_inputs`

It returned `updated_inputs: updatedKeys` — **the values that were requested**, never read back.
TradingView silently ignores a value outside an input's declared range, so a rejected write was
indistinguishable from an applied one. For this project that is the worst possible place for the
defect to live: it means running a strategy on a configuration that exists only in the caller's head.
It now reads `getInputValues()` back, compares per id, and refuses with `rejected` / `missing` lists.

This also sharpens the standing memory note that "`set_inputs` reads STALE" and that API input writes
are not saved: the *write* was never confirmed either.

### Defects fixed

Read-backs added: `chart_set_type`, `chart_manage_indicator` (remove — it also could not tell a
non-existent id from a successful removal), `chart_scroll_to_date` (clamping to loaded history was
invisible), `chart_set_visible_range`, `indicator_set_inputs`, `indicator_toggle_visibility`,
`draw_shape`, `draw_remove_one`, `draw_clear`, `pane_set_layout`, `pane_focus`, `pane_set_symbol`,
`pine_set_source`, `pine_new`, `pine_smart_compile`, `ui_open_panel`, `layout_switch` (reported
`switched` before `loadChartFromServer` had loaded anything; now polls `layoutId()`),
`watchlist_remove`, `tv_launch`.

Declared **unobservable** — success means "I dispatched it", and the payload now says so instead of
implying more: `ui_click`, `ui_keyboard`, `ui_type_text`, `ui_hover`, `ui_scroll`, `ui_mouse_click`,
`ui_fullscreen`, `pine_compile`, `pine_save`, `capture_screenshot` (method `api` only — the `cdp`
method writes a verifiable file).

### The structural guard

**`src/internals/verdict.js`** — `observed(evidence, detail)`, `refused(reason, detail)`,
`unobservable(why, detail)`. The verdict key is written **last** and the object is frozen, and a
`detail` carrying a reserved key (`success`, `observed`, `reason`, `evidence`, `observation`) is a
**throw**, not a silent override. `observed()` refuses empty evidence; `unobservable()` refuses an
empty reason, so "I could not be bothered to check" cannot masquerade as "it is not checkable".

### FINDING — the guard caught me twice while I was building it

Both worth recording, because they are the argument for the guard rather than anecdotes about it:

1. The audit test failed on my own thin justifications ("Returns symbolExt() as read.") — the
   minimum-length rule works.
2. **`replay_health`, which I wrote in Task 4, had the exact overwrite defect.** It spread the verdict
   and *then* assigned the raw reading under `state`, so `state` came back as the reading object
   where `'healthy'` belonged. Written by the same hand that had fixed `pine_inputs_assert` an hour
   earlier. Knowing about a defect shape demonstrably does not prevent writing it; that is why it now
   has to be impossible rather than merely known. Pinned by a regression test.

---

## 4. Task 4 — transport single-flight

**`src/internals/replay-transport.js`.** All replay transport — `selectDate`, step, play, pause, stop
— is serialised behind one module-scoped lock.

- Operations **queue** rather than fail, because replay work is naturally sequential and making
  callers retry would just move serialisation into every call site.
- **`selectDate` while a step is in flight is refused outright**, not queued. That is the specific
  pattern that preceded the wedge, and the refusal is checked at call time against what is in flight
  *now* — checking after queueing would be vacuous, since the step it must not race has finished by
  then.
- Every call is bounded, and a timeout raises **`ReplayWedgeError`** naming the condition and the
  recovery (reload), not a generic stall. A slow-but-working step and a wedged session need different
  responses, so they get different names. The lock budget is deliberately wider than the step's own
  polling budget so a slow step is not mislabelled.
- A failed operation does not poison the queue.

**Honest limit, stated in the module:** a lock inside one Node process does not make the chart safe.
A second harness process, or the user's own hand on the TradingView UI, is outside it. This narrows a
window; it does not close one.

### `replay_health` (new tool — workflow profile, 64 → 65 tools; diagnostic 94 → 95)

The wedged session reported `sessionState 2`, `connected true`, `isReplayStarted true`,
`isReplayFinished false` — **every flag a caller would naturally check said it was fine.** So no flag
distinguishes the two states, and `classifyHealth` refuses to answer `healthy` from flags alone: with
no probe the honest verdict is `armed_unprobed`. With `probe: true` it attempts one step (which moves
the cursor by one bar, so it must be asked for) and separates:

- `healthy` — the cursor advanced
- `wedged` — `doStep()` never settled *and* the cursor did not move
- `stalled` — `doStep()` settled but the cursor did not move

`classifyHealth` is pure and is tested against the state **actually measured** on the wedged session,
because reproducing a wedge deliberately costs a reload.

---

## 5. Task 5 — bar integrity at depth

### FINDING — the deep bars are genuine 45-second bars, not derived or upsampled

The worry was well founded in principle: 45S is a constructed interval and seconds history is
normally far shallower than 21 months. Every discriminator tested came back clean, and at the floor
behaves identically to a recent window.

| test | at the floor (2023-12) | recent (2026-08/09) | reads as |
|---|---|---|---|
| consecutive deltas exactly 45 s | 99.0 % | 99.8 % | genuine |
| non-45 s deltas | `90 s ×2`, `3915 s ×1` | `3825 s ×1` | session breaks + 2 no-tick bars |
| repeated OHLC (forward-fill signature) | **0 %** | **0 %** | genuine |
| open ≠ previous close | yes | yes | real tick data |
| price level | **$2039.16** on 2023-12-20 | $4452 | correct for the date |

The `90 s` deltas at depth are **skipped bars** — 45 s windows in which no tick printed. An upsample
never skips; it interpolates. That single observation is the strongest evidence against synthesis.

Median 45 s range as a fraction of price rises with time — 0.0093 % (Dec 2023), 0.0107 % (Jan 2024),
0.0146 % (Jun 2024), 0.0194 % (Jun 2025), 0.0164 %–0.0249 % (2026). Read that as the market's own
regime rather than a data-quality gradient: **the within-2026 spread is as wide as most of the
cross-era gaps**, gold more than doubled over the period, and late December is the thinnest week of
the year.

**So there is no depth at which the bars "stop looking synthetic" — they never start.** The usable
depth is the full seek depth.

### The memory note is re-scoped, not deleted

`fortyfive-second-history-ceiling.md` was right about **chart-load depth** (~20k bars rolling, ~11
trading days) and that still governs the on-chart book, the Strategy Tester, and any capture. What it
over-claimed is the sentence "there is no earlier period to hold out, no reserve to spend, and no way
to buy sample except forward time" — false as a statement about the instrument. A **~21-month
out-of-sample reserve exists via replay**, bought in step count rather than calendar time.

**UNKNOWN, and it gates using that reserve:** whether a study computes a *correct* book at a deep
replay start. Replay serves only ~300–600 bars around the cursor, while build15 declares
`max_bars_back = 3000` and PS runs `ta.sma(iofAtrVal, 100)`. A deep start is under-warmed exactly as
the first ~50 bars of a chart window are, and how many bars of stepping it takes to warm has not been
measured. **Do not read a deep-replay book as out-of-sample evidence until it has.**

---

## 6. Task 6 — the order

Session armed explicitly and **read back verified** — this also settles assumption A6:

| setting | was | set to | read back | took |
|---|---|---|---|---|
| `initial_capital` | 1000000 | 100000 | 100000 | yes |
| `currency` | `NONE` | `USD` | `USD` | yes |
| `commission_type` | `percent` | `cash_per_contract` | `cash_per_contract` | yes |
| `commission_value` | 0 | 0.11 | 0.11 | yes |

Independently confirmed: `equityCapability.getEquity()` moved 1000000 → 100000, so the write reaches
the session and not merely the property bag. **A6 settled.**

Interlock asserted immediately before the call: `REPLAYBROKER` / `isInReplay true` /
`isReplayStarted true`, account `primary`, type `demo`.

### The trade

Buy 1 @ **4452.39**, closed @ **4451.39** three bars later. Commission **0.22** round turn
(2 × 0.11 — exactly what `build15.pine` models). Gross −1.00, **net −1.22**. Equity
100000 → 99998.78. `maxContractsHeld: 1`, `totalTrades: 1`, `totalOpenTrades: 0`.

### Actual against the seven pre-registered predictions

| # | prediction | outcome |
|---|---|---|
| **P1** | `placeOrder` resolves `{orderId: "order_<guid>", label}` | **PARTLY WRONG.** Resolves `{orderId: "order_2481ed79-…", result: 0}`. There is **no `label`**; there is a `result` field. The guid id is right. |
| **P2** | order accepted as `{symbol, side: Side.Buy, type: OrderType.Market, qty: 1}` | **CONFIRMED.** Accepted exactly. `side` and `qty` are now *measured* field names, not assumed. **A1 settled.** |
| **P3** | `positions()` shows one position, qty 1 | **CONFIRMED.** `{avgPrice: 4452.39, qty: 1, side: 1, unrealizedPl: 0}` |
| **P4** | `executions()` reports one fill | **REFUTED — but the data exists elsewhere.** `executions({symbol})` returned **`[]`** after the fill and stayed empty. **`allExecutions()`** returns both fills in full: `{id, symbol, qty, side, price, time}`. The harness must use `allExecutions()`. |
| **P5** | **P&L moves $1.00 per $1.00 of price ⇒ 1 contract = 1 oz** | **CONFIRMED, three times over.** Δprice −2.51 → ΔP&L −2.51; −3.59 → −3.59; −1.00 → −1.00. And the round trip: entry−exit = 1.00, `grossLossWC` = 1.00. **A2 settled by measurement, not inference.** |
| **P6** | a replay strategy appears and `getActiveChartTradingData()` stops returning `null` | **CONFIRMED.** `null` before; afterwards a full report with `filledOrders`, `performance`, `position`, `currency: "USD"`. |
| **P7** | `getEquity()` moves by the position's unrealised P&L | **REFUTED.** Equity moved to 99999.89 at entry (the 0.11 commission) and then **did not move at all** while unrealised P&L ran −2.51 → −3.59 → −1.00. It moved again only on the close. **`getEquity()` tracks realised P&L and commission, not unrealised.** |

### FINDING — `placeOrder` returns a promise, not a synchronous id

`returned_synchronously: false`; resolved in 701 ms. So the generated `order_<guid>` is **not**
available before the call completes. Consequence for §7's single-flight/reconciled design: the id is
still a sound reconciliation handle *after the fact*, but there is no way to know it for an in-flight
submit whose response is lost. The pre-submit snapshot plus re-read on ambiguity remains necessary —
this measurement does not soften it.

### FINDING — a closed position keeps its row, and it is a trap

`closePosition()` leaves the row in `positions()` with `qty: 0`, `avgPrice: null` and the **side
flipped** to −1. My first flatten check was `positions().length === 0`, and it therefore reported
`flattened: false` for an account that was genuinely flat. **Flat means every row has `qty === 0`,
never an empty array.** Corrected, and confirmed flat: `rows: 1, open_qty: 0, flat: true`.

This is the silent-success rule in its mirror image — a false *negative* from checking the wrong
observable — and it would have made a Phase 1 flatten-and-verify loop hang forever.

### Order-object wire format, now observed

`reportData.filledOrders` confirms the Phase 0.5 predicted shape:
`{b: true, c: "Buy market order", id, p: 4452.39, q: 1, tp: "MARKET", utm: 1788220785000}`.

---

## 7. Residue left on the chart

Stated plainly rather than tidied away:

- **Replay session settings are changed** from what they were: capital 1000000 → 100000, currency
  NONE → USD, commission percent/0 → cash_per_contract/0.11. These are now *correct* for modelling
  B15, and the brief required setting them, but they are not what was there before.
- **A replay strategy now exists** with one closed trade in its report. Before this run
  `getActiveChartTradingData()` was `null`.
- **A zero-qty position row** for `ICMARKETS:XAUUSD` remains, as described above. It is not an open
  position.
- Replay is left **started**, cursor ~1788220919, on the 2026-09-01 window.
- The chart itself, its 5 drawings and its 12 studies are untouched; B15's inputs are untouched
  (hash re-verified `b8d3b7ff`).

---

## 8. Assumptions after Phase 0.6

| id | assumption | status |
|---|---|---|
| A1 | preOrder field names | **SETTLED.** `symbol`/`side`/`type`/`qty` accepted and filled; `takeProfit`/`stopLoss` confirmed in source. `limitPrice`/`stopPrice` still untested (no non-market order placed). |
| A2 | `qty` denomination | **SETTLED BY MEASUREMENT.** 1 contract = 1 oz, $1/point. |
| A3 | panel need not be open | moot; the panel is armed deliberately. |
| A4 | reported 45S depth wrong | **REFUTED** (Phase 0.5), and the bars are now also shown genuine. |
| A5 | reconciliation-based idempotency | **stands, and is now load-bearing** — `placeOrder` is async, so there is no client-side id before the response. |
| A6 | `setValue` on `replayStudyStrategyProperties` takes effect | **SETTLED.** All four settings took; broker equity followed. |
| A7 | the ten hidden Pine studies do not perturb replay | **still untested.** They were present throughout this run and nothing anomalous appeared, which is weak evidence at best. |
| **A8** | *new* — a study computes a correct book at a deep replay start | **untested, and it gates the OOS reserve** (§5). |
| **A9** | *new* — `allExecutions()` stays populated across a long run | untested; only two fills observed. |

### Carried forward and still open

- **§1(c) of Phase 0.5** — whether hidden extra Pine studies should be fatal
  (`TVMCP_REPLAY_STRICT_STUDIES=1`). **Still your decision.** Unchanged by this phase.
- **`npm run lint` still cannot run** — `eslint` is a devDependency and is not installed. Reported,
  not worked around.
- **One pre-existing test is flaky**, not broken: `pine_check — server compile` hits TradingView's
  live compile endpoint and fails intermittently (a different subtest each run, and it passes on
  re-run). It is unrelated to anything changed here.

---

## 9. Test state

`npm test`: **369 tests / 80 suites**, all passing except the flaky live compile test above.
New suites: `tests/silent-success.test.js` (9), `tests/replay-transport.test.js` (13).

Nothing has been committed.
