# Phase 0.7 — The Warm-Up Gate

Measured 2026-09-13 against TradingView Desktop 3.4.1.8194, layout `R7HDoRZ2`, `ICMARKETS:XAUUSD` 45S,
strategy `xVbiv5` = Build 15 (manifest hash `b8d3b7ff`), with the chart's 11 hidden Pine studies present
throughout. The market was closed (weekend), so the reference chart could not move under the experiments.

Tagged **FINDING** (measured), **ASSUMPTION** (reasoned, not measured) or **UNKNOWN**.

---

## 0. Verdict

**The ~21-month replay reserve is usable, at a stated cost, behind an explicit gate.**

The premise of the warm-up worry was wrong, and that is the main result. Replay does **not** compute the
study over the ~300–600 bars it serves around the cursor. It computes the strategy server-side over a
rolling window that starts at a **daily session open roughly 20k bars (~15 calendar days) before the replay
start**, exactly as a normal chart does before "now". Warm-up is therefore not bought in step count at all
— a deep start is as warm as the live chart, except within ~15 days of the data floor.

What the gate still has to handle, because it is real and it is silent:

1. **Start-dependent state emits plausible wrong numbers, never `na`.** One diagnostic (IOF Active OB count)
   differs permanently between sessions with different compute starts, and two of 59 trades in one overlap
   differed by cents. An `na` check would pass all of them.
2. **At the data floor the window is truncated** to the first available bar, so a book there starts cold.
   This is detectable (`backtest.from` equals the floor) and affects starts until roughly 2024-01-08;
   convergence from a cold start could not be measured because that period barely traded. See §1.7.

Cost per session: ~20–36 s to arm and settle, ~350 ms per bar stepped (1,500 bars ≈ 9–10 min), ~30 s to
settle before reading the book.

---

## 1. Task 1 — study warm-up under replay

Scripts: `recon/j01.mjs` (reference), `j02.mjs` (pilot), `j03.mjs` (one session: start → step → dump),
`warmup-compare.mjs` (per-plot k\*), `book-compare.mjs`, `burnin-compare.mjs`. Raw dumps beside them.
Rows are matched by bar **time**, never index. Equality is exact up to 1e-9 relative.

### 1.1 FINDING — the reference chart is warm, and loading more history does not change it

The chart held **349 bars and 498 plot rows**, but the strategy report covered **21,825 bars**
(`dateRange.backtest.from` 2026-08-26 22:02 UTC). The client only ever holds a window of an already-warm
computation.

Extending history to **10,349 bars** (`requestMoreData`) left all **498 overlapping rows identical in all 64
plots**, the **82 trades identical**, and `backtest.from` unchanged. The reference is stable ground truth for
any bar from 2026-09-03 onward, each with 15k+ bars of computation behind it. (`recon/j01.json`)

### 1.2 FINDING — replay computes over ~20k bars before the START, snapped to a session open

| replay start | `dateRange.backtest.from` | window before start | trades already in the book |
|---|---|---|---|
| 2026-09-08 02:18 | 2026-08-23 22:02 | 15.2 days | 75 |
| 2025-03-11 10:00 | 2025-02-23 23:02 | 15.5 days | 28 |
| 2025-03-11 19:15 / 03-12 07:45 / 03-12 14:00 | **all** 2025-02-24 23:02 | — | 28 / 28 / 30 |
| 2023-12-20 10:00 (floor) | **2023-12-19 07:41 = the data floor** | **1.1 days** | **0** |

- The compute start **snaps to the daily session open** (22:02 UTC summer, 23:02 winter). Every session
  started within the same trading day shares one compute start and therefore computes the same book.
- It is **fixed for the session**: it did not move across 1,501 steps.
- The served client window is 349 bars / ~466–498 rows regardless of depth.

### 1.3 FINDING — stepping accumulates; nothing slides

Rows grew 466 → 496 over 30 steps and 498 → 1,999 over 1,501 steps; main-series bars 349 → 1,850. The first
row's time never moved. Nothing is discarded, so nothing caps a long run.

### 1.4 Experiment A — convergence against the warm reference (recent window)

Start T = 2026-09-08 02:18:30, stepped **1,501 bars** to 22:06:30, compared with the reference at every bar.
(`recon/j03-A.json`, `j03-A-cmp.json`)

**k\* per output:**

| outputs | k\* | what it is |
|---|---|---|
| **61 of 64 plots** | **0** — exact from the first bar through k = 1,500 | every CZ, DVB, FVG, IOF-nearest, LS, SR ladder, config plot |
| plot 45 `IOF data window 3` = **Active OB count** (`array.size(iofObArray)`) | **never** (null) | **start-dependent state**, not lag: 55 vs 46 at T, offset up to 9, constant over 1,501 bars. The replay computed from 08-23, the chart from 08-26; the order-block book accumulates, so the two runs hold different books. |
| plots 60, 61 `SR data window 1/2` (distance above/below, ATR) | 29 — one row each, value vs `na` | **viewport-driven, not warm-up.** SR computes only where `time == chart.right_visible_bar_time` (build15.pine:3292); in replay the right edge follows the cursor. SR outputs feed no trade decision (only the data window). |

**The binding output is Active OB count, and it does not converge by stepping** — it converges only by
sharing a compute start (§1.5). Everything the strategy decides on agreed.

**Trade book, [T, E]: 10 of 10 trades identical** (entry time, comment, price; exit time, price).

**Over the full 312 h overlap before and after T** (compute starts 72 h apart): **57 of 59 identical.** The
two that differed:

- 0.6 h after the later compute start: entry grade `B` (chart) vs `F` (replay), exit 4616.01 vs 4615.95.
  The grade is scored from history, and 36 minutes is not enough of it.
- 197 h after: a `CZX RT` exit at 4470.59 vs 4470.70 — same entry, same bar, 0.11 apart.

**Fast stepping does not change what is computed.** A's first 30 bars (stepped without waiting for the
study) match the pilot's 30 bars (waited per bar) in all 64 plots, apart from the viewport-driven SR rows.

### 1.5 Experiment B — self-consistency at mid depth (2025-03)

Evaluation bar E = 2025-03-12 14:00 UTC. (`recon/j04-*.json`, `j04-burnin.json`, `j04-B-rows-cmp.json`)

**As specified — two stepped sessions from different offsets to E:** 1,417 bars and 501 bars. **All 64
plots identical over the 500 shared bars, Active OB count included; books identical.** This is weaker
evidence than it looks, and it is stated so: both starts fell in the same trading day, so both computed
from the same first bar (§1.2). Offset in stepping is not a variable replay exposes.

**The test that actually varies warm-up — burn-in across compute starts.** Zero-step sessions started at
E and at E + 1, 2, 5 and 8 calendar days, moving the compute start forward by 1, 2, 3 and 8 trading days:

| compute start vs base | overlap | trades in overlap | identical | differing |
|---|---|---|---|---|
| +1 trading day | 351 h | 28 | **28** | 0 |
| +2 | 327 h | 26 | **26** | 0 |
| +3 | 303 h | 19 | **19** | 0 |
| +8 | 183 h | 13 | **13** | 0 |

The tool flags one row in each comparison; it is the same `RVX DN` trade **still open at E**, whose "exit"
is each dump's final bar, and the dumps ended one bar apart. It is a window-edge artefact, not
start-dependence.

**No divergence at mid depth.** Per the brief, had it diverged I would have stopped here.

### 1.6 What the study emits before convergence

**Plausible-looking numbers, not `na`.** Across every comparison, the only `na`-shaped mismatches were the
viewport-driven SR rows. Every start-dependent difference was a wrong-but-reasonable value: an OB count of 55
where the warm chart says 46, a grade letter, an exit price off by 6–11 cents.

**Consequence for the loop: an explicit "not yet warm" gate is required.** It cannot be an `na` check.

### 1.7 The depth floor

Zero-step sessions at 14:00 UTC on four January 2024 Thursdays (`recon/j05-*.json`):

| replay start | `backtest.from` | window |
|---|---|---|
| 2024-01-04 | **2023-12-19 07:41 = the data floor** | truncated to ~16 days of mostly holiday bars |
| 2024-01-11 | 2023-12-25 23:02 | full ~20k bars — reaches back over the thin holiday weeks |
| 2024-01-18 | 2024-01-02 23:02 | full |
| 2024-01-25 | 2024-01-09 23:02 | full |

**FINDING — truncation is confined to roughly the first three weeks after the floor, and it is directly
observable:** a session whose `backtest.from` equals the earliest available bar has a truncated window.
From 2024-01-11 onward the window is full.

**UNKNOWN — whether a book computed from zero history converges, and how fast.** The overlaps between
the floor-started book and the later ones held **one trade** (identical) and **zero trades** respectively
— the holiday period traded almost nothing. That is consistent with fast convergence and proves nothing.
The §1.9 gate therefore **refuses** a truncated window rather than trying to estimate a burn-in for it.

Self-consistency by stepping from two offsets is vacuous at the floor (both compute from the same first
bar), which is why it was replaced by the burn-in design here.

### 1.8 Cost of one session (measured)

| stage | measured |
|---|---|
| arm (`selectDate` → started) | 0.8–1.6 s |
| study + report settled at start | 18–36 s (3.8 s at the floor, where the window is 1 day) |
| step | median 345–360 ms, p90 370–394 ms, max 3.8–4.3 s |
| 1,500 bars | 544–592 s |
| settle before reading the book | 29–37 s |
| zero-step session, end to end incl. stop | 52–55 s |

Warm-up itself costs **zero steps** outside the floor window. The price of the reserve is the stepping you
want to *observe*, not warm-up.

### 1.9 The gate I recommend (not built — Phase 1 design input)

1. **Read `dateRange.backtest.from` at every session start and refuse if it equals the data floor**
   (2023-12-19 07:41:45 UTC, `1702971705`) — the window is truncated. Measured: true for starts up to at
   least 2024-01-04, false from 2024-01-11. In practice this forfeits about three weeks of a 21-month reserve.
2. **Discard trades that open within one trading day of `backtest.from`.** The one start-sensitive entry
   observed was 36 minutes in.
3. **Treat start-dependent diagnostics as non-evidence.** Active OB count is the measured case.
4. **Do not expect cent-level book identity across sessions with different compute starts.** 2 of 59 trades
   differed by ≤ 0.11 in one overlap and 0 of 86 in the others; the harness should compare books with a
   tolerance and report the differences, not assert equality.
5. **Mark the open position at the window edge as open**, never as a closed trade at the last bar.

### 1.10 What this does not show

- One symbol, one resolution, one build (B15), with 11 hidden Pine studies present (A7 untouched).
- Two depths validated (2026-09 against the chart, 2025-03 by self-consistency) plus the floor (§1.7). The
  months between were not sampled; the mechanism (§1.2) was the same at every depth probed.
- Replay steps whole 45S bars. B15 declares `calc_on_every_tick`; intrabar behaviour in live realtime is not
  exercised by any of this.
- Burn-in overlaps were 183–375 h. A start-dependent effect with a longer memory than that is not excluded
  — the 197 h RT exit difference in §1.4 is the evidence that long memory exists.

### 1.11 Residue

Replay was started and stopped 15 times; every stop cleared the saved session (read back `cleared: true`).
Replay is **stopped**. The chart's extra history (10,349 bars) was released by the replay stops; it is back
to its default load. No inputs, studies, drawings or session settings were changed. **No orders were placed.**

---

## 2. Task 2 — the three refutations, pinned

`src/internals/replay-broker.js` (reads only; not wired into any profile — no replay profile exists yet):

| refutation | helper | the naive alternative it forbids |
|---|---|---|
| `executions({symbol})` is `[]` after a fill | `fillsFor(allExecutions, {symbol})` filters the **unfiltered** list client-side; it takes no filtered input | reconciling against the filtered call and seeing "no fills" |
| `getEquity()` is realised P&L + commission only | `brokerReadJs` returns it as **`realised_equity`**, never `equity`; `markToMarket({realisedEquity, positions})` adds unrealised and **throws** on an open position with no `unrealizedPl` rather than valuing it at zero | risk/drawdown/MAE logic reading a flat line through an open loss |
| `closePosition()` leaves a `qty: 0` row with the side flipped | `isFlat(rows)` = every row `qty === 0`; `openQty`; both **throw** on an unreadable list | `positions().length === 0`, which never becomes true |

- `tests/replay-broker-refutations.test.js` — **15 tests**, against `tests/fixtures/phase06-broker-readings.json`
  (the 2026-09-12 fill, copied verbatim). Each asserts the recorded API behaviour **and** the helper's answer.
- `tests/live/replay-broker-surfaces.test.js` — the "day it changes" pin: asserts filtered `[]` while
  `allExecutions()` holds fills. It **skips, and says why**, when the session has no fills, because an empty
  session proves nothing. **Not run this phase** — the current session holds no fills and I did not place one.
- **P1** folded in: `placeOrder` resolves `{orderId, result}` after the submit completes. Corrected the two
  remaining places that implied otherwise: `recon/replay-selectors.json` (`returns { orderId, label }`) and
  `recon/PHASE0.5-FINDINGS.md` §3.2. The design text in Phase 0 §8 and the module header state single-flight +
  pre-submit snapshot + reconcile, unchanged.

---

## 3. Task 3 — prior use of `indicator_set_inputs`

**Closed: no run executed against a configuration that existed only in the return value because of a range
rejection.**

Search: every file under `trading/` (recon, scripts, manifests, specs), the memory directory, and all session
transcripts. **67 invocations**, all in two transcripts, all before the read-back fix: 65 through the MCP tool
(`1dabb482…`, 2026-08-17 → 08-30; `79debc65…`, 2026-09-11) and 2 through core `setInputs` from scratch
scripts. None in project files. No CLI use.

Each value was checked against the declared `minval`/`maxval`/`step`/`options` of the build that was on the
chart at the time (build pinned from the strategy title in the transcript; `in_N` mapped by the source parser
and cross-checked against input titles read at the time):

| date | build | inputs written | verdict |
|---|---|---|---|
| 08-17 | Build 3 | in_229–235 (bool) | in range; read back |
| 08-18 | Build 4 (18 Aug revision, **source not recoverable**) | in_223–239 bool, in_79 `"Wick"/"Body Close"` (options), in_76 40/0 and in_209 40/25 (0–100) | in range per today's declarations **and** confirmed by the book changing each time |
| 08-26 | Build 9 → 10 | in_277 0–3 (min 0, step .25), in_278 −6…0 (no min), in_271 0/4/6, in_273/274 sessions, in_279 3–8, in_280 0–2 | all in range, all on-step; distinct book per value |
| 08-29/30 | B11 | in_281 0/8/10/24 (min 0), in_282, in_250, in_273/274 | in range; cfg read back |
| 09-11 | B14 | in_44 bool, `__log_level` (not a Pine input), in_278/315/323 bool via script | in range; the script's re-assert matched 334/334 |

**One real return-vs-chart disagreement was found, and it was not a range rejection:** on 08-26 12:36 a
`(in_279, in_280) = (6, 1)` write returned success while the study had **reloaded to defaults** (read back 0/0
at the next read). The session noticed and re-applied. That is the silent-success defect in its purest form,
caught at the time by a read the tool itself did not do. The Phase 0.6 read-back now catches it inside the tool.

Only numeric and `options` inputs could ever be rejected (in_76, 79, 209, 271, 277–281), and every value had room.
Unverifiable from source: the 18 Aug Build 4 declarations — covered by the transcript's read-backs.

---

## 4. Task 4 — the structural guard is the only path

### 4.1 What was installed

- **eslint 9.39.4** (`npm install`; `package-lock.json` changed). `npm run lint`: **0 errors**, 5 pre-existing
  unused-variable warnings.
- **`eslint.config.mjs` → `VERDICT_ONLY_PATH`**: `no-restricted-syntax` forbids the keys `ok` and `success` in
  any object literal (plain, quoted, computed) and any assignment, everywhere under `src/` **except
  `src/internals/verdict.js`**.
- **`tests/verdict-only-path.test.js`** runs that rule over `src/**` **inside `npm test`**, so the guard does
  not depend on anyone running lint. It fails on import if eslint is absent — a guard that silently skips is
  the failure it guards.

### 4.2 `verdict.js` extended

- `ok` added to the reserved keys and mirrored on every verdict (the pine_inputs_assert defect was `ok`).
- `answered(detail)` for reads, `failed(code, detail)` for could-not-answer — so reads no longer need a
  hand-built success.
- `withDetail(verdict, extra)` refuses **any** key collision, not just reserved ones — the replay_health
  overwrite was of `state`, an ordinary key.
- `adopt(obj)` turns page-context / reader objects into verdicts and **throws when `ok` and `success`
  disagree**.
- A non-enumerable brand + `isVerdict()`.

### 4.3 The cases that actually occurred, confirmed

| case | behaviour |
|---|---|
| detail carrying `ok` or `success` | **throws**, every helper (tested) |
| a merge — `refused('script_drift', {...cmp})` where `cmp` carries its own verdict | **throws** (tested) |
| a spread after the verdict — `{ ok, ...cmp }` / `{ success: true, ...detail }` | **lint error** (tested against the rule directly) |
| an ordinary-key overwrite via `withDetail` — the replay_health case | **throws** (tested) |
| mutation of an issued verdict | **TypeError** (frozen; tested) |

**Limit, stated and pinned by a test rather than hidden:** a hand-written `{ ...verdict, state: x }` still
parses and passes the rule, because the rule sees literal verdict keys, not which spread holds a verdict.
Freezing prevents mutation, not a copy. The copy loses the brand, so `isVerdict()` tells it apart. Page JS
inside strings is outside any AST rule; those objects become results only through `adopt()`.

### 4.4 Migration

**198 hand-built verdict sites in 33 files** (counted by AST) moved onto the helpers, by five parallel
passes over disjoint files; every file lints clean.

**A latent envelope defect was found on the way:** `handler()` in `_format.js` answered **`ok: true`** for
a result carrying `success: false` (measured: `handler(refused(...))` → `ok:true, success:false`, no
`isError`). It was unreachable only because no tool called `handler()`. Fixed and tested. A second leak —
`fromReaderFailure` stripping `ok` but not `success`, so verdict keys nested into `error` — also fixed.

**Behaviour a caller can notice** (all follow the read-back rule; say if any should be reverted):

- Every result carries both `ok` and `success`; every failure carries a `reason` code. Results are frozen.
- **New read-backs where success was previously asserted:** `pine_open` (editor line count), `tv update`
  (HEAD == origin/main), `alert_create` / `alert_delete` (re-list), `capture_screenshot` cdp (file on disk),
  `watchlist_add`/bulk, `indicator_add`, tab new/close/switch, `tv_launch`.
- `replay_stop` now **refuses** if the saved session cannot be cleared, even when replay was already stopped.
- `replay_autoplay` with a speed now **refuses** if the read-back says it is not playing.
- `chart_set_symbol` / `chart_set_timeframe` now say **unobservable** (they deliberately do not wait; the
  fence proves it later).
- `alert_list`, `layout_list` and batch rows carrying an `error` now **fail** instead of succeeding.
- **Not verified live, and a risk:** `alert_create`'s read-back could report `refused` if TradingView's alert
  list lags a real creation. Not exercised — it would touch the live account.

**The silent-success audit** now scans calls that can succeed without evidence (`answered`, `unobservable`,
`adopt`) instead of the retired literal; 79 entries, each with a written reason checked against the code's own
`unobservable(why)` text. The Phase 0.6 regression list now fails if a fixed mutation answers with a
read-shaped success.

### 4.5 Verified

- `npm test`: **436 tests / 94 suites, 436 pass, 0 fail.**
- MCP stdio handshake: server `tradingview` 2.0.0, **65 tools**, `replay_health` present, `replay_trade` absent.
- **Live, read-only smoke** through the core + envelope on the chart: `chart_get_state`,
  `data_get_study_values`, `data_get_ohlcv`, `data_get_strategy_results`, `data_get_trades`, `replay_status`,
  `replay_health`, `tv_health_check` — every one a frozen, branded verdict; `ok`/`success` true; no `isError`.
- **Not live-verified:** any mutating tool after migration (alerts, tabs, watchlist, pine editor, drawing).
  Unit tests cover their shapes, not their behaviour against TradingView.

**The running MCP server still has the old code. Reconnect `tradingview` in `/mcp` to load it.**

---

## 5. Task 5 — `TVMCP_REPLAY_STRICT_STUDIES`

Implemented in `src/internals/invariants.js` as decided: **on for `replay`, off for `workflow` and `diagnostic`.**

- `profile` is **required** by `assertReplayEnvironment`; a missing or unknown profile refuses before any CDP
  call. Defaulting to lenient would hand the harness the workflow behaviour by omission.
- `TVMCP_REPLAY_STRICT_STUDIES=1` opts a non-replay profile in. `=0` on the replay profile is **refused**, not
  honoured.
- **Cross-checked enumeration:** three independent surfaces — `dataSources()` (built-in `ESD$` event sources
  excluded), `getAllStudies()`, and the saved-layout serialization `state(true)` — must agree on the study
  ids, and the first and third on which are Pine. Under strict, a disagreement **or an unreadable surface** is
  a refusal naming which surface saw what. Non-strict profiles report `enumerations_agree` and the
  disagreement without refusing.
- Callers updated: `assertStrategyManifest` passes `profile` through; `scripts/make-live-manifest.mjs` passes
  `workflow`.
- `tests/invariants-strict-studies.test.js` — **14 tests**, including the 29-vs-5 shape (one inflated
  surface), an unreadable surface, and a Pine/non-Pine disagreement.

**Measured live on today's chart, with the new code:**

- `profile: 'workflow'` → **passes**; `enumerations_agree: true` with `data_sources 12 / chart_api 12 /
  serialized_layout 12`; 11 hidden extras reported.
- `profile: 'replay'` → **refuses**: `EnvironmentInvariantError: 11 extra Pine study/studies loaded (all
  hidden): Adaptive Trend Finder (log) (8uE6BI, hidden), …`

**11** Pine studies besides B15 are loaded, all hidden — one more than the "ten" in earlier reports. The
replay profile refusing this chart is the decision working; clearing the hidden studies is an operator
action and I have not done it.

---

## 6. Assumptions and open items, carried forward

| id | item | status after 0.7 |
|---|---|---|
| A1 | `limitPrice` / `stopPrice` field names | **untested** — no non-market order placed |
| A5 | reconciliation-based idempotency | stands; P1 wording now consistent everywhere |
| A7 | hidden Pine studies do not perturb replay | **untested directly.** All Task 1 runs had them loaded and replay reproduced the warm chart exactly — weak evidence of no perturbation of B15's computation; says nothing about load or step latency. Moot for the replay profile once strict refuses them. |
| **A8** | a study computes a correct book at a deep replay start | **SETTLED for B15, with the §1.9 gate** — see §1.4–1.7 |
| A9 | `allExecutions()` stays populated across a long run | **untested** — no orders this phase |
| — | strict studies will refuse today's chart | **operator action**: remove the 11 hidden Pine studies before running the replay profile |
| — | replay profile / executor loop | not built; §1.9 is design input |
| — | `alert_create` read-back under server lag | not exercised live |
| — | `pine_check — server compile` flaky test | did not flake this phase; unchanged |
| — | eslint warnings (5 unused vars) | pre-existing, left |

Nothing has been committed.
