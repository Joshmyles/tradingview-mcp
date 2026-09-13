# Phase 0.5 — findings

Environment: TradingView Desktop 3.4.1.8194 (Electron 41.7.1 / Chrome 146.0.7680.216), CDP on
127.0.0.1:9222, layout "Trial Ground", `ICMARKETS:XAUUSD` at `45S`, strategy `xVbiv5` = **B15**.
All work 2026-09-12. Raw probe output is in `recon/f01.json`, `g01–g09.json`, `h01–h14.json`
alongside the expressions that produced them.

**FINDING** = measured. **ASSUMPTION** = reasoned but not measured. **UNKNOWN** = not established.
Each is tagged; nothing is blended.

---

## 0. Summary, and the two things that stop here

Tasks 1, 2 and 3 are complete. Task 4 is half complete. Task 5 was not attempted.

| # | Task | Outcome |
|---|------|---------|
| 1 | Remove `replay_trade`, correct the docs | Done, with an enforcing test |
| 2 | B15 identity manifest | Done; **input count is 353, not 25** (§2) |
| 3 | Re-probe armed | Done; **Phase 0's "no capital" finding is overturned** (§3.1) |
| 4 | Measure 45S replay depth | Depth measured and it is **not** what the repo believed (§4); **step granularity UNKNOWN** |
| 5 | One order, to fix `qty` | **Not attempted** — blocked (§5) |

**Two things stop here, and I am reporting rather than routing around them.**

1. **The replay session on the live chart is wedged, and I probably wedged it.** `doStep()`'s promise
   never settles; autoplay does nothing either. The session reports itself connected and unfinished.
   It does not recover from `stopReplay`, `selectDate`, `leaveReplay`, removing the extra replay
   model, or `disconnectionSessionIfExists` — all four measured (§4.4). The recovery is a chart
   reload, which I did not do: 29 drawings live on your working chart and I cannot verify your
   autosave setting, so that is your call, not mine. Everything else in this report was measured
   before or independently of the wedge, and the chart is otherwise intact — B15 untouched, no order
   placed, no input written.
2. **The §1 environment invariants are both false as written** (§1). They are restated over the sets
   that actually create ambiguity, and the deviation is flagged rather than absorbed.

---

## 1. §1 environment invariants — both false as written

### FINDING — "exactly one CDP page target" is false, by six

`/json/list` returns **seven** targets of type `page` with a single chart tab open:

| target | url | TradingViewApi |
|---|---|---|
| `4E51661A…` | `https://www.tradingview.com/chart/R7HDoRZ2/` | **yes** |
| `4FA773AA…` | `file:///…/index.html` (tabbed-window title bar) | no |
| `C18F1B67…` | `file:///…/drag-service/index.html` | no |
| `991E0315…` | `file:///…/index.html` | no |
| `F720B8A7…`, `BC06BBFE…`, `BD28CADC…` | blank / shell | **did not answer CDP at all** (probe timed out at 4000 ms, 3 of 3) |

A literal count refuses on a clean machine every time, so it is not a usable check. Three of the
six do not even answer, so probing them costs 12 s of timeouts per call.

**Implemented instead:** exactly one page target whose URL is a TradingView chart, and it must carry
a loaded `TradingViewApi`. That is the set a context could be chosen *from*, so it is the set that
must be a singleton for "skip disambiguation" to be sound. The other six are listed in the refusal
inventory but neither counted nor probed.

### FINDING — "exactly one study on the chart" is false, by fifteen

`dataSources()` returns **56** entries: 16 studies, 29 drawings titled with the symbol, 5 built-in
event sources, 5 other drawings, the series and the crosshair. **Eleven of the 16 studies are Pine**:

> Adaptive Trend Finder (log) · Consolidation Zones - Live · Liquidity Sweeps [LuxAlgo] ·
> Fair Value Gap [LuxAlgo] ×2 · Support Resistance Classification (VR) [LuxAlgo] ·
> Delta Volume Bubbles ×2 · Institutional Order Flow Strength Classifier [LuxAlgo] ·
> Multi-Session ORB · ADX and DI for v4 — **plus B15**

**Ten of those eleven are hidden. B15 is the only visible one.** Four more are built-in (Dividends,
Splits, Earnings, roll dates).

**Implemented instead**, as three separate checks in `src/internals/invariants.js`:

- (a) **exactly one source exposing `reportData()`** — one strategy. This is the check that matters:
  it makes "the strategy" a definite description. Fatal.
- (b) **no visible Pine study besides that strategy.** A second script drawing on the chart is a
  second program you are reading. Fatal.
- (c) **hidden extra Pine studies are counted and returned, never dropped** — but not fatal, because
  they create neither ambiguity, and the strict reading refuses on your chart as it stands today.

**(c) is the one judgement call in this phase.** `TVMCP_REPLAY_STRICT_STUDIES=1` promotes it to fatal
and gives the brief's literal reading. If you would rather clear the ten hidden studies off the
chart and run strict, say so and I will flip the default.

Live result today: passes, returning `layout "Trial Ground" · ICMARKETS:XAUUSD 45S · strategy
xVbiv5` and the eleven hidden extras.

---

## 2. Task 2 — B15 identity manifest

### FINDING — the repo source IS the program on the chart

`second round/build 7.0/build15.pine`, sha256 `eef5cdb678f4e9906621efa0a3847eecc41cc4f793ed3bdf2a95c036a2918f63`,
439,892 bytes, **328 `input.*` declarations** spanning `in_0..in_327`. No export was needed.

Cross-checked one-for-one against the chart: **all 328 declared inputs matched by id AND name, zero
mismatches.** Name matching is what makes this conclusive — ids alone would match any script with
enough inputs.

### FINDING — the input count is 353, and here is the arithmetic

**Reported explicitly, as asked.** The Phase 0 probe saw 25. The live study now carries **353**:

| | source declarations | strategy properties | total |
|---|---|---|---|
| B14 (recorded) | 326 (`in_0..in_325`) | 25 (`in_328..in_352`) | 351 |
| **B15 (measured)** | **328** (`in_0..in_327`) | **25** (`in_330..in_354`) | **353** |

B15 = B14 + 2, which is exactly what `build15.pine`'s own header says item 34 adds (`b15NearN`,
`b15NearAtr`), declared last to preserve the B14 `in_N` map. The two-id gap before the properties
(`in_326`/`in_327` in B14, `in_328`/`in_329` in B15) is present in both. **This is a deliberate
+2 increment on the B14 base, not a rebuild on a smaller one.** The 25 property values read back as
B15's `strategy()` line exactly: capital 100000, fixed qty 1, `cash_per_contract` 0.11, pyramiding
10, `calc_on_every_tick` true.

The 25-input "Base 2.0.36" Phase 0 saw was a real observation of a different program in the same
slot at that time. **The slot has now carried three programs** — B14 (pine 0.46, 351 inputs),
Base 2.0.36 (0.49, 25) and Build 15 (0.51, 353) — all answering to entity `xVbiv5` and pine id
`USER;e003abfb1017423c8f9137fd2c9ffd95`. That is the §0 point, confirmed a third time.

### What was built

- **`manifests/b15.manifest.json`** — the versioned identity manifest. Program name/description,
  pine id, pine version `0.51`, input count, the full ordered input vector, the id→value map, the
  17 non-default inputs, and **`manifest_hash b8d3b7ff`** over all 353 in id order. It also records
  the source sha256 and the cross-check, so the hash means *this source*.
- **`scripts/make-live-manifest.mjs`** — regenerates it. It runs the environment check first, then
  **refuses** unless every declared input matches the chart by id and name. Re-derive, don't edit.
- **`src/core/replay-manifest.js`** — the §6 precondition. Hash matches → proceed; differs → abort
  with the per-input diff. Script identity (`pine_id`, `pine_version`) is checked first and
  short-circuits, because a different script is not a different configuration.
  **It never coerces.** There is no restore-and-continue path, and there must not be: input writes
  set no dirty flag, so they are not saved and a reload undoes them anyway.

Verified live, three ways: clean pass (353 inputs checked); one tampered value → refused naming
`in_0 Loopback Period expected 999999 actual 10`; wrong `pine_version` → refused as `script_drift`
with zero input diffs.

### FINDING — a defect in `pine_inputs_assert`, found by using it

`pineInputsAssert` spread `...cmp` **after** the computed `ok`, and `compareManifest` returns its own
`ok`. So whenever the inputs matched but the **script** had drifted, `cmp.ok` (true) overwrote the
verdict: the tool returned `ok: true` alongside `reason: "script_drift"`, a populated `script_drift`
array, and an error string saying the inputs were not comparable. A pass and a refusal in one object,
and every caller reads `.ok`.

Measured live: manifest pinning pine 0.46 against a chart carrying 0.51 → `ok: true`.

Fixed (`src/core/pine-inputs.js`), with the comparison verdict preserved separately as `inputs_ok`.
Regression tests in `tests/manifest-precondition.test.js`. **This is pre-existing and affects
`pine_inputs_assert` for every build, not just this project.**

---

## 3. Task 3 — re-probe in an armed session

The Replay Trading panel was opened (`[data-qa-id="replay_trading"]`, aria flipped
`Open` → `Close`). **The broker did not change**: `REPLAYBROKER` before and after, `isInReplay` true
both sides, connection status 1 both sides. The Phase 0 caution about `pickDefaultBroker()` reaching
the live IC Markets account did not materialise. The panel then read
*"No data here, yet — Choose a bar or date in Bar Replay and place at least one …"*.

### 3.1 FINDING — capital, currency AND commission all exist. **Phase 0 was wrong.**

Phase 0 concluded these three do not exist and recommended dropping them from
`replay_session_open`. **Do not drop them.** They exist; Phase 0 was looking at the wrong object.

The broker's *account-settings* surface genuinely does not exist, and now structurally rather than
empirically — `accountSettingsInfo`'s own source is:

```js
e => { if (!this.config.supportCreateAccount && !this.config.supportResetAccount
           && !this.config.supportChangeAccountSettings)
         throw new Error("Account settings are not supported"); … }
```

None of those three flags is present on the Replay Broker, so it throws **by construction** — no
session state can change that. `supportBalances`, `supportMargin`, `supportLeverage` are all `false`,
and `summaryRowCapability.get()` is literally `async get(){return[]}`, which is why
`accountManagerInfo().summary` is empty. `replayApi.currency()` is `null`.

**But the settings live somewhere else entirely.** `equityCapability.getEquity()` gave it away:

```js
async getEquity() {
  const { equity, performance } = this._transport.getActiveChartTradingData() ?? {},
        e = (await this._transport.getUserInputSettings(this._transport.getActiveChartId())).initialCapital;
  …
}
```

and `getUserInputSettings` is:

```js
async e => { const t = await window.TradingViewApi.chart(e).replayStudyStrategyProperties();
             return { currency: t.childs().currency.value(),
                      initialCapital: t.childs().initial_capital.value() }; }
```

**`window.TradingViewApi.chart(0).replayStudyStrategyProperties()`** is a property bag named
`replayStudyStrategyInputs` with a declared schema:

| child | type | live value | `setValue` |
|---|---|---|---|
| `initial_capital` | number | `1000000` | **yes** |
| `currency` | string | `"NONE"` | **yes** |
| `commission_type` | string | `"percent"` | **yes** |
| `commission_value` | number | `0` | **yes** |
| `recoveryState` | string | `"{}"` | yes |
| `text` | string | `""` | yes |

`equityCapability.getEquity()` returned **1000000**, consistent.

**It is not the Strategy Tester's capital, and here is the discriminator.** Phase 0 rightly warned
that `[data-qa-id="initial-capital"]` ("1 M") is the backtest pill and wiring to it would be silently
wrong. B15's own `in_330` (its `initial_capital` strategy property) reads **100000**; the replay
object reads **1000000**. Different objects, different values, and the replay one is named
`replayStudyStrategyInputs`. Use the API path, never the pill.

⇒ **`replay_session_open(symbol, interval, start_bar, capital, currency, commission)` is implementable
as specified.** All six parameters have a home. `commission_type` is an extra axis the brief did not
name (`"percent"` today; B15 itself models `cash_per_contract` 0.11/side), and the harness will have
to set it explicitly rather than inherit `percent`.

**ASSUMPTION (A6, new):** that writing these via `setValue` takes effect on the replay session rather
than being overwritten when the session starts. Not tested — the session wedged first. It is the
first thing to test after recovery.

### 3.2 FINDING — the `activeBroker()` surface is unchanged and complete

All of `placeOrder`, `modifyOrder`, `cancelOrder`, `cancelOrders`, `closePosition`, `reversePosition`,
`editPositionBrackets`, `orders`, `positions`, `executions`, `allExecutions`, `ordersHistory`,
`symbolInfo`, `previewOrder`, `isTradable` resolve as functions (167 methods total). Enums re-read
identical: `Side {Buy 1, Sell −1}`, `OrderType {Limit 1, Market 2, Stop 3, StopLimit 4}`,
`OrderStatus {Canceled 1, Filled 2, Inactive 3, Placing 4, Rejected 5, Working 6}`,
`ParentType {Order 1, Position 2, IndividualPosition 3}`; `InternalBrokerId` unchanged.

**NEW — the order-object shape is now partly *observed*, settling half of assumption A1.** The
capability-layer source is:

```js
async placeOrder(t, r) {
  const e = `order_${guid()}`;
  await this._transport.sendTradingData({ orderCmd: w(t, e) });
  const a = t.type === OrderType.Market;
  if (t.takeProfit !== undefined) await this._transport.sendTradingData({ bracketCmd:
      a ? this._buildPositionBracketCommand("tp", t.takeProfit)
        : this._buildOrderBracketCommand(e, "tp", t.takeProfit) });
  if (t.stopLoss !== undefined)  await this._transport.sendTradingData({ bracketCmd: … });
  return { orderId: e, result: OrderResult.OrderPlaced };
}
```

- `takeProfit` and `stopLoss` are **confirmed** field names.
- `type` is **confirmed**, carrying the `OrderType` enum.
- **The order id is generated inside** as `order_<guid>` and returned as `{orderId, label}`. This is
  the third independent confirmation that there is no client order id (§7 amendment stands), and it
  also gives the harness its reconciliation handle.
- **Market orders get POSITION brackets; everything else gets ORDER brackets keyed to the parent.**
  That is a real behavioural difference `replay_brackets_set` must model, not paper over.
- Wire format, from `closePosition`'s command: `{id, action:"place", params:{b:<isBuy>, q:<qty>,
  tp:"MARKET", c:<comment>}}`.

**UNKNOWN** — the caller-facing names for side / qty / limit price / stop price. The mapper `w(t,e)`
is module-private and I could not reach its source. `side` and `qty` are the TradingView Broker API's
documented names and the `Side` enum exists, so they are near-certain — but near-certain is not
measured, and Task 5 was the measurement.

`symbolInfo()` is a **promise** on this broker (Phase 0 recorded it as unresolved). Awaited:

```
qty: { min: 1, max: 1e12, step: 1, uiStep: 1, default: 1 }
minTick: 0.01,  pipValue: 0.01,  pipSize: 0.01,  type: "commodity",  hasQuotes: true
```

Still **no `lotSize`**. **ASSUMPTION (A2, narrowed):** `pipValue / pipSize = 1.0` means one qty unit
moves P&L by $1.00 per $1.00 of price, i.e. **qty is in ounces and 1 contract = 1 oz** — which is
also what `build15.pine` assumes for its 0.11/side commission. That is now a quantitative inference
from two quoted figures rather than a guess, but it is still not a measured fill.

### 3.3 FINDING — the interlock re-confirms armed, and the trap is now a test

Re-read with the panel open: `currentBroker()` `"REPLAYBROKER"`, `isInReplay()` `true`,
`isReplayStarted()` `true`, `connectionStatus` 1, account `primary`, type `demo`, 137 brokers listed.

Built as **`src/core/replay-interlock.js`**, deliberately as an **allowlist** rather than the brief's
denylist phrasing: with 137 brokers on the session, a denylist fails open on the 138th. Unknown is a
refusal. All three clauses are required — `currentBroker()` can read `REPLAYBROKER` while the chart
has left replay, and an order then has no bar to fill on.

**The trap is pinned by `tests/replay-interlock.test.js`, as asked.**
`tradingUIController()._isConnectedToBroker` reads like the refusal signal and means the opposite —
connected to the *replay* broker. Measured `true` today alongside `currentBroker() === "REPLAYBROKER"`.
The tests assert the decision is **identical** for `true`, `false`, `null` and `undefined` of that
flag, in both the arming and the refusing direction, and that a state carrying only that flag refuses
with all three reasons. A comment could not stop someone inverting this; those tests can.

Verified live: arms, returning `REPLAYBROKER / primary / demo`.

---

## 4. Task 4 — replay depth at 45S, measured

### 4.1 FINDING — the API's reported depth is real, and the repo's belief is wrong

The brief's suspicion — that identical values across resolutions look like a plan-level ceiling —
was reasonable but **the number checks out**.

`_onPointSelected` does **not refuse** an early date, it **clamps**:

```js
const i = this._replayDepth.value() ?? -Infinity;
const n = Math.max(i, t - o);                       // o = 1 (or 1e-6 for ticks)
if (t < i) showChartInfoNotification("replay_time_point_corrected", …)
```

So "walk backwards until it refuses" has no terminating refusal to find; it corrects, with a notice.
The empirical test is whether **data arrives**:

| replay start selected | bars loaded | earliest bar |
|---|---|---|
| `2023-12-19T07:41:56Z` (= the reported depth, exactly) | **0** after 45 s | — |
| `2023-12-19T12:00:00Z` | 300 | **2023-12-19T07:42:30Z** |
| 2023-12-20, 2023-12-26, 2024-01-15, 2024-03-11, 2024-06-03 | 300 each | at target |
| 2025-06-02, 2026-01-15, 2026-05-01, 2026-07-01 | 300 each | at target |
| 2026-08-11, 2026-08-25, 2026-09-01 | 300 each | at target |

**The earliest 45S bar TradingView serves is `2023-12-19T07:42:30Z` — 34 seconds after the reported
depth `1702971716` (`2023-12-19T07:41:56Z`).** The reported number is the boundary *before* the first
bar; selecting the boundary instant itself yields nothing because no bars precede it.

**This contradicts the repo's recorded belief that 45s history is a rolling ~20,000-bar (~10 trading
day) window.** Replay seek at 45S reaches back about **21 months**, not ten days.

**Caveat, and it matters:** seek depth is not study depth. That replay can *start* at 2024-06-03 does
not mean B15 computes a full book from there — how much history a study is given is a separate limit
this phase did not measure. The ~20k-bar note may well be correct *about that*, in which case it is
mis-scoped rather than wrong, and should be re-worded rather than deleted.

Per-resolution depths: `45S`, `1S`, `5S`, `15S` all report `1702971716`; `1T` reports `1773392217`
(`2026-03-13T08:56:57Z`). Tick being shallower than seconds is not backwards after all — the seconds
tier shares one floor, and ticks have their own, shorter one.

### 4.2 UNKNOWN — step granularity at 45S

Not established. The session wedged before it could be measured, and I will not report a number I
did not see. The question stands: does one `doStep()` advance exactly one 45S bar, always?

### 4.3 What this bounds

Not the constraint it was feared to be. ~21 months of 45S seek depth is ample for the determinism,
idempotency and crash-recovery runs in §8 — those need tens of bars, not thousands. Any *statistical*
claim would still be bounded by study history depth (unmeasured) rather than by replay seek.

### 4.4 FINDING — the session wedge, and what did not fix it

Symptoms: `doStep()` returns a promise that **never settles** (PENDING at 15 s and 20 s, repeatedly).
`toggleAutoplay()` also advances nothing over 12 s. Meanwhile the session reports itself healthy:

```
sessionState 2 · sessionId rs_jPcM7PyZdRDj · connected true · isReplayStarted true
isReplayFinished false · replayStatus 3 · replayPoint == selectedPoint == 1788220799
```

`doReplayStep` sends to `_replaySession.doStep(…)` and resolves only on the session's `ok` reply.
That reply never comes.

Tried, all measured, none worked: `core.stop()` + `core.start({date})` (the supported lifecycle);
`leaveReplay()` (returned, but `isReplayStarted` stayed true and models stayed 2); removing the
`<chartId>_additional` replay model (removed cleanly, re-added by the next `selectDate`);
`disconnectionSessionIfExists()` then re-select. Closing the Replay Trading panel changed nothing
either, so the panel is not the cause.

**Attribution, honestly:** I cannot prove I caused it. I never observed a successful step today
*before* my changes — the 283–7711 ms step latencies in `src/internals/replay.js` are pre-existing
documentation, not a measurement from this session. What I did do is arm Replay Trading and issue
roughly fifteen `selectDate` calls in quick succession while it was armed. That is the obvious
candidate and I am not going to dress it up as anything else.

**Recovery is a chart reload**, which is yours to authorise: 29 drawings live on that chart and I
cannot verify your autosave setting, so I did not take it unilaterally.

### 4.5 FINDING — `replay_step` reported success while standing still

While diagnosing, `core.step()` was observed returning `{success: true}` four times in a row at an
unchanged cursor: it polled for 3 s and returned whatever it found. That is the same class of defect
as `replay_trade` — an operation reporting success for something that did not happen — and it is the
one that would have silently corrupted the §6 loop, because a bar that never advanced would be
journalled as advanced.

Fixed: `step()` now **throws** when the cursor has not moved, with a configurable `timeoutMs`
(failure detection, never synchronisation — §2.6). The old test asserted the defective behaviour and
now asserts the refusal. `stepUntil` already handled non-advance correctly.

---

## 5. Task 5 — one order. NOT ATTEMPTED.

Blocked by §4.4: an order into a replay session that cannot advance a bar tells you nothing about
fills, and would leave an open position in a session I cannot step or flatten cleanly. **No order was
placed. No order was previewed.**

The brief asks for a written expected result *before* the run, so here it is, pre-registered:

**Pre-registration — one market order, qty 1, `ICMARKETS:XAUUSD`, armed replay session, interlock
asserted immediately before.**

| # | Prediction | Basis |
|---|---|---|
| P1 | `placeOrder` resolves `{orderId: "order_<guid>", label}` | capability source, §3.2 |
| P2 | The order object is accepted as `{symbol, side: Side.Buy, type: OrderType.Market, qty: 1}` | `type` confirmed; `side`/`qty` **assumed** (A1) |
| P3 | `positions()` then shows one position, `qty 1` | — |
| P4 | `executions()` reports one fill at the replay bar's price | `supportExecutions: true` |
| P5 | **P&L moves $1.00 per $1.00 of price** ⇒ 1 contract = 1 oz | `pipValue/pipSize = 1.0` (A2) |
| P6 | A replay strategy appears where none exists now, and `getActiveChartTradingData()` stops returning `null` | the panel says "place at least one…"; `getActiveChartTradingData()` is `replayStrategyFacade().reportData()` and currently warns "chart doesn't have a replay strategy" |
| P7 | `getEquity()` moves from 1000000 by the position's unrealised P&L | `getEquity` source, §3.1 |

P5 is the measurement that unblocks §7 sizing. P2 is the one most likely to be wrong, and its failure
mode is a rejected order rather than a wrong-sized one. **If P2 fails, that is the answer to the
field-name question and costs nothing.**

---

## 6. Assumptions carried forward

| id | assumption | status after Phase 0.5 |
|---|---|---|
| A1 | preOrder field names (`qty`, `limitPrice`, `stopPrice`, `takeProfit`, `stopLoss`) | **half settled.** `takeProfit`, `stopLoss`, `type` observed in source. `side`, `qty`, `limitPrice`, `stopPrice` still inferred |
| A2 | `qty` denomination | **narrowed, not settled.** `pipValue/pipSize = 1.0` ⇒ 1 unit = 1 oz. Needs Task 5 |
| A3 | that `placeOrder` works with the Replay Trading panel never opened | **moot** — the panel is now opened, and the harness should open it deliberately |
| A4 | that the reported 45S depth was wrong | **REFUTED.** It is right (§4.1) |
| A5 | that reconciliation-based idempotency satisfies §5 | **stands**, and is now triply confirmed: the id is generated inside `placeOrder` |
| A6 | **new** — that `setValue` on `replayStudyStrategyProperties` children takes effect on the session | untested |
| A7 | **new** — that the ten hidden Pine studies do not perturb the replay session | untested; they are hidden, not removed |

---

## 7. What changed in the repo

| file | change |
|---|---|
| `src/tools/replay.js`, `src/core/replay.js`, `src/cli/commands/replay.js` | `replay_trade` / `trade()` / `tv replay trade` **deleted** (tombstone kept) |
| `src/core/replay.js` | `step()` refuses instead of reporting a stale success (§4.5) |
| `src/core/pine-inputs.js` | `ok`-overwrite defect fixed (§2) |
| `src/internals/invariants.js` | **new** — environment preconditions (§1) |
| `src/core/replay-manifest.js` | **new** — the §6 manifest precondition (§2) |
| `src/core/replay-interlock.js` | **new** — the §2.4 interlock (§3.3) |
| `scripts/make-live-manifest.mjs`, `manifests/b15.manifest.json` | **new** — identity manifest + generator |
| `tests/no-order-path.test.js` | **new** — profile order-path scan |
| `tests/manifest-precondition.test.js` | **new** — manifest + `ok`-overwrite regressions |
| `tests/replay-interlock.test.js` | **new** — allowlist + naming-trap regressions |
| `CLAUDE.md`, `src/server.js`, `README.md`, `PROVENANCE.md`, `src/server-common.js`, `skills/replay-practice/SKILL.md` | corrected; the false order-capability claim recorded, not silently replaced |

360 unit tests pass. `npm run lint` cannot run: `eslint` is a devDependency and is not installed.

---

## 8. What I recommend next, in order

1. **You reload the chart** (or restart TradingView Desktop) to clear the wedged replay session.
   I am not doing it unilaterally — unsaved drawings.
2. **Re-run `node scripts/make-live-manifest.mjs b15`** after the reload and confirm the hash is
   still `b8d3b7ff`. If it is not, the chart was carrying unsaved input changes and we have just
   learned something important.
3. **Then Task 5** — the one order, against the pre-registration in §5. It settles A1 and A2 together.
4. **Then the A6 test** — write `initial_capital`/`currency`/`commission_*` via `setValue`, start a
   session, read them back.
5. **Decide (c) in §1** — hidden extra studies fatal or not.
6. **Re-scope the "45s = rolling ~20k bars" note** rather than deleting it: it is wrong about replay
   seek depth and may still be right about study history depth.
