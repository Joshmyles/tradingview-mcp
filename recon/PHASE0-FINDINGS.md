# Phase 0 — Reconnaissance findings

Replay auto-execution harness for `tradingview-mcp`. Captured **2026-09-12** against the live
TradingView Desktop session under CDP.

No production code has been written. No order has been placed. No study, input, layout or broker
selection has been mutated. Raw probe output is in `recon/e01.json` … `recon/e17.json`; the selector
registry is `recon/replay-selectors.json`.

Everything below is marked **FINDING** (observed, with the probe that observed it) or **ASSUMPTION**
(inferred, not observed). Where something could not be established it says **UNKNOWN**.

---

## 0. Environment as found

| | |
|---|---|
| TradingView Desktop | 3.4.1.8194 (Electron 41.7.1, Chrome 146.0.7680.216) |
| CDP | `127.0.0.1:9222`, reachable |
| Chart contexts | 10 CDP targets; exactly one real chart window (`4E51661A…`), selected by the outer≠inner window-chrome rule |
| Layout | `Trial Ground` |
| Symbol / interval | `ICMARKETS:XAUUSD` / `45S` |
| Bar Replay | **already running** — `isReplayStarted: true`, cursor `2026-09-07T01:25:59Z`, start point `2026-09-06T22:55:59Z`, mode `AllCharts`, timing `manual`, autoplay off |
| Loaded bars | 715, index −215…499, spanning `2026-09-04T15:25Z` → `2026-09-07T01:25Z` |
| Active broker | `REPLAYBROKER`, connected, account `primary`, type `demo` |
| Open orders / positions / executions | `[]` / `[]` / `[]` |

---

## 1. BLOCKER — the chart is not running B14

**FINDING.** The study at entity `xVbiv5` is **not Path Scan B14**. It is a different program at the
same entity id *and the same saved-script id*:

| | recorded B14 (`manifests/b14.saved.2026-09-11.json`) | live study today (`e03.json`) |
|---|---|---|
| entity id | `xVbiv5` | `xVbiv5` |
| pine id | `USER;e003abfb1017423c8f9137fd2c9ffd95` | `USER;e003abfb1017423c8f9137fd2c9ffd95` |
| title | `B14` | **`Base 2.0.36`** |
| pine version | `0.46` | **`0.49`** |
| input count | **351** (`in_0` … `in_352`) | **25** (`in_0` … `in_24`) |

`in_273`–`in_280` **do not exist** on the live study — the probe filtered for them and returned an
empty set. The manifest pins them (`in_273: "Africa/Nairobi"`, `in_274: false`, `in_275: 6`,
`in_276: 1.5`, `in_277: true`, `in_278: false`, `in_279: 9`, `in_280: 5`).

The reading: the saved TradingView script `USER;e003abfb…` has been **overwritten** with `Base 2.0.36`
from the build 2.0 lineage. B14's source is not lost — `second round/build 7.0/build14.pine` (330
`input.*` declarations) is intact in the repo — but it is no longer what that script slot or that chart
carries.

Consequences, all hard:

- **§6's precondition check is unimplementable as written.** It says to echo `in_273`–`in_280` and
  compare against a manifest. Against this chart it cannot read those inputs at all, so it would abort
  every run — which is the correct behaviour, and also means the loop can never run.
- **§2's "the harness reads B14 and must never mutate it" has no referent.** There is nothing on the
  chart to mirror.
- **Restoring B14 is a write to the saved script**, i.e. a mutation of the thing the spec freezes. It is
  your call, not mine.

I have not touched it.

---

## 2. FINDING — the order path is a semantic API, not the DOM

This is the most consequential discovery and it makes §2.2 much easier to honour than the spec assumes.

Every order intent in §5 maps onto a named method on a broker object reachable in-page:

```
window.webpackChunktradingview.push([[unique], {}, function (r) { req = r }])
req('822530').tradingService().activeBroker()
```

Verified present, with the `config` flags that gate them all `true`: `placeOrder`, `modifyOrder`,
`cancelOrder`, `cancelOrders`, `closePosition` (incl. partial), `reversePosition`,
`editPositionBrackets`, `orders()`, `positions()`, `executions()` / `allExecutions()`,
`ordersHistory()`, `accountManagerInfo()`.

Order enums resolved from webpack module `601629` (`e17.json`):

```
Side        Buy = 1,  Sell = -1
OrderType   Limit = 1, Market = 2, Stop = 3, StopLimit = 4
OrderStatus Canceled 1, Filled 2, Inactive 3, Placing 4, Rejected 5, Working 6
ParentType  Order 1, Position 2, IndividualPosition 3
```

Broker `config` confirms each order type the spec asks for: `supportMarketOrders`, `supportLimitOrders`,
`supportStopOrders`, `supportStopLimitOrders`, `supportMarketBrackets`, `supportOrderBrackets`,
`supportPositionBrackets`, `supportModifyPositionBrackets`, `supportClosePosition`,
`supportPartialClosePosition`, `supportExecutions`, `supportOrdersHistory`.

**Recommendation — the standardised order surface should be `broker.placeOrder(...)`, not any of the
three UI surfaces §3 lists.** Why: it accepts side/type/qty/price as typed arguments rather than
synthesised clicks; it takes no selector, XPath or JS payload from the caller, so it satisfies §2.2 more
strictly than a click-driver would; it returns a promise that resolves or rejects, which is the
confirmation §6 needs; and it is unaffected by the fact (below) that the replay toolbar's Play and
Forward controls carry no stable DOM hook at all.

**ASSUMPTION, not verified.** `createInitialPreOrder({symbol, side, type})` echoed exactly those three
fields back. The names of the price and bracket fields (`qty`, `limitPrice`, `stopPrice`, `takeProfit`,
`stopLoss`) are inferred from the config flags and the conventional broker-API shape. Confirming them
requires placing an order, which Phase 0 did not do.

---

## 3. BLOCKER — the Replay Trading session has no capital, currency or commission

**FINDING, contradicting §3 of the brief.** The Replay Broker exposes *no account configuration at all*
on this build (`e09.json`, `e12.json`, `e13.json`):

- `broker.accountSettingsInfo()` throws `Account settings are not supported`.
- `config.supportCreateAccount: false`, `supportDeleteAccount: false`, `supportBalances: false`,
  `supportMargin: false`, `supportLeverage: false`, `supportMarginControl: false`.
- `accountManagerInfo()` returns `accountTitle: "Replay Broker"` and `summary: []` — an **empty**
  summary table.
- `replayApi.currency()` returns `null`. `accountsMetainfo()` returns `{}`.
- A scan of the broker connection object for any `capital|commission|balance|equity|cash|fee|currency|
  initial`-shaped member found only `subscribeEquity` / `subscribeCryptoBalance` subscription plumbing —
  no settable value.

So **`replay_session_open(symbol, interval, start_bar, capital, currency, commission)` cannot be
implemented as specified.** Three of its six parameters have nowhere to go.

One thing that looks like the missing control and is not: `[data-qa-id="initial-capital"]` (rendering
`1 M`) is the **Strategy Tester's** backtest capital, in the bottom panel next to the date range and
`bar-detalization` pills. It configures the Pine backtest, not the replay trading account. Wiring
`replay_session_open` to it would be silently wrong.

**UNKNOWN.** Whether an older or newer TradingView build exposes these settings, and whether the
"Replay Trading panel" the brief describes is a surface that exists on some other build. There is a
feature flag `isNewReplaySupportingPlatform` on `TradingViewApi._tradingFeatureFlagsService`; this build
is on the new path (see §4). I did not open the Replay Trading panel — see §9.

---

## 4. FINDING — the existing `replay_trade` tool is a silent no-op on this build, and that is load-bearing

`src/core/replay.js` `trade()` calls `replayApi.buy() / sell() / closePosition()`. Their in-page source:

```js
buy(e) { this._replayUIController.tradingUIController()?.activeModel()?.addOrder({ side: Buy, type: Market, qty: e }) }
```

Both `?.` short-circuit. On this build `activeModel()` returns **null** — it resolves the chart model id
against `_tradingModelMap`, and `_tradingModelMap.size` is **0**.

Why it is 0: `tradingUIController.updateModels()` branches on a build flag. One branch,
`_initTradingModels()`, populates `_tradingModelMap` (the legacy in-chart replay trading widget). The
other, `_initReplayBroker()`, instead calls
`tradingService().selectBroker(InternalBrokerId.ReplayBroker, { keepSessionAlive: true })` and leaves the
map empty. This build took the **`_initReplayBroker`** branch — confirmed by
`_isConnectedToBroker: true` with `_tradingModelMap.size: 0`, and by the active broker being
`REPLAYBROKER`.

Two things follow:

1. `replay_trade` currently reports `success: true` while doing nothing, and returns `position: null`,
   `realized_pnl: null`. That is a correctness defect independent of this project.
2. `CLAUDE.md` says "No tool in this bridge can place an order or touch broker state; that path was
   removed, not disabled." That is **not accurate for `replay_trade`**: the tool *attempts* an order and
   is saved only by a null check inside TradingView. If TradingView flips that flag back — or if the
   legacy path is taken on another machine or build — `replay_trade` becomes live, in the workflow
   profile, which is the default. `replay_trade` is also registered in the workflow profile today.

I have not changed either. Flagging both because §2.3's whole argument is that order capability lives
only in a gated profile, and right now it does not.

---

## 5. FINDING — the §2.4 interlock has an exact, programmatic signal

Replay Trading and Paper Trading are distinguishable without ambiguity:

```js
const svc = req('822530').tradingService();
svc.isInReplay()                          // observed true
svc.activeBroker().currentBroker()        // observed "REPLAYBROKER"
svc.activeBroker().metainfo().id          // observed "REPLAYBROKER"
svc.activeBroker().isConnected()          // observed true
svc.activeBroker().currentAccountType()   // observed "demo"
```

The full internal broker enum (module `754318`):
`{ Paper: "Paper", Dummy: "DUMMY", MockBroker: "MOCKBROKER", MockBrokerImplicit: "MOCKBROKER_IMPLICIT",
MockBrokerCode: "MOCKBROKER_CODE", ReplayBroker: "REPLAYBROKER" }`. Real brokers are the 137 entries in
`svc.brokersList()`.

The interlock should be **allowlist, not denylist**: proceed only when `currentBroker() === "REPLAYBROKER"`
**and** `isInReplay() === true` **and** `replayApi.isReplayStarted() === true`; refuse on anything else,
including on a read that throws or returns null.

**Naming trap worth writing down.** `tradingUIController()._isConnectedToBroker` reads like the §2.4
refusal signal and is the opposite of it — it means "connected to the *replay* broker". Using it as the
guard would invert the check.

---

## 6. FINDING — per-bar reads

| What | How | Verified |
|---|---|---|
| Replay bar timestamp | `replayApi.currentDate()` | yes — **epoch SECONDS**, unlike everything else in this codebase |
| Bar OHLCV | `mainSeries().bars().valueAt(lastIndex())` → `[time,o,h,l,c,v]` | yes — time also in seconds |
| Open position size/direction | `await broker.positions('ICMARKETS:XAUUSD')` | yes (returned `[]`) |
| Working orders | `await broker.orders(symbol?)` | yes (returned `[]`) |
| Fills | `await broker.allExecutions()` / `broker.executions(symbol)` | yes (returned `[]`) |
| Realised P&L | `accountManagerInfo()` summary | **no — summary is empty (§3)** |
| Strategy signal | `getStudyById(id).getInputValues()`, `dataSources()…reportData()`, `study.status()` | mechanism verified; **no B14 to read (§1)** |

On the three candidate ways to read strategy state that §4.3 asks me to evaluate: **the strategy report
(`reportData()`) is the wrong one for a per-bar loop.** `src/internals/replay.js` already records it
lagging a step by a full recompute — 13–21 s per bar on this chart — so reading it without settling
returns the *previous* bar's book. Plot values / Data Window are series-tier and move with the step. A
per-bar loop should read series-tier values and treat the report as an end-of-session reconciliation
source only.

`supportMultiposition: false` and `supportPositionNetting: false` ⇒ one net position per symbol, so a
`position_id` is effectively a singleton. Individual positions are unsupported
(`individualPositions()` asserts `Broker doesn't support individual positions`).

---

## 7. UNKNOWN — replay depth at 45S

The API reports, in `replayUIController._replayResolutionsDepth`:

```
45S: 1702971716  →  2023-12-19T07:41:56Z
1S : 1702971716  →  same
5S : 1702971716  →  same
15S: 1702971716  →  same
1T : 1773392217  →  2026-03-13T08:56:57Z
```

**I do not believe the 45S figure and I am not reporting it as the answer.** Three reasons: all four
seconds resolutions report the identical value, which is also the value of the generic
`_replayDepth` field, so it looks like the chart's overall replay depth rather than a per-resolution
data depth; the tick resolution reports a *shallower* depth than the seconds resolutions, which is
backwards if these were real data depths; and it contradicts the repo's own recorded measurement that
45s history is a rolling window of roughly 20 000 bars (about 10 trading days).

Establishing the true depth means moving the replay start point on the user's live chart — a mutation I
did not make. **Until it is measured, the bound on every experiment this harness can run is unknown**,
and per §3 that is the thing that decides whether the harness is worth building at all.

Note also: `getReplayDepth(arg)` is **not a getter**. Its source is
`getReplayDepth(e){ if (e) this.enableReplayMode(false); return this._replayDepth }` — the argument is a
flag that mutates replay mode, not a resolution. I called it with `'45S'` and four other truthy strings
before reading the source; I then re-read full replay state (`e11.json`) and confirmed nothing changed
(`isReplayStarted: true`, cursor unmoved at `1788744359`, broker still `REPLAYBROKER`). Recording it
because the harness must read the field, never call the method.

**Step granularity at 45S:** `doStep()` advances exactly one 45-second bar; `replayResolutions` is
`["1T","1S","5S","15S","45S",null]` with `autoReplayResolution: "45S"`. Step latency is already
characterised in `src/internals/replay.js` from ten consecutive measured steps: 283, 7711, 599, 444,
282, 293, 378, 349, 301, 305 ms — median ~300 ms, one outlier at 7.7 s. This confirms §2.6: no fixed
sleep is safe in either direction, and advancement must be confirmed on the `currentDate()` edge.

---

## 8. FINDING — §5's idempotency requirement has no native support

`broker.placeOrder(preOrder, confirmId?)` accepts **no caller-supplied client order id**. There is no
idempotency key anywhere in the broker API.

So "idempotent on `intent_id`" must be implemented entirely harness-side, and the honest limit is:

- write the intent to the journal **before** calling `placeOrder`, keyed by `intent_id`;
- on any retry of a known `intent_id`, do not re-send — instead reconcile against
  `broker.allExecutions()` / `broker.orders()` and adopt whatever is already there;
- accept that a crash in the window *between* the CDP call leaving and the journal recording an
  acknowledgement leaves an order whose existence can only be recovered by reconciliation, not by the
  journal alone.

That is achievable and I would build it. But it is reconciliation-based idempotency, not a guarantee,
and §5's "a retry after an ambiguous response must not double-fill" is only true if the recovery path
always reconciles before re-sending. Worth stating explicitly before it is built rather than discovered
in acceptance test 3.

---

## 9. What I deliberately did not do

- **Did not open the Replay Trading panel.** The button is `[data-qa-id="replay_trading"]`, labelled
  `Open Replay Trading` — so the session is currently unarmed. Opening it runs
  `_connectToReplayBroker()`, and closing replay runs `pickDefaultBroker()`, which re-selects whatever
  broker was previously active. With a live IC Markets account on this session I was not willing to
  drive a broker-selection state machine on the user's running chart as an unattended recon step.
  This is why §3's "not found" list is a *not observed*, not a *proved absent* — though the API evidence
  in §3 is independent of the panel and is what I would rely on.
- **Did not place, preview, modify or cancel any order.**
- **Did not move the replay cursor, change the start point, or exit replay.**
- **Did not touch any study, input, layout, or the saved script.**

---

## 10. Selector registry

`recon/replay-selectors.json`. Every entry carries what it is, how it was identified, a fallback where
one exists, and a confidence rating.

The registry's headline is negative and should be read before it is used: **the replay toolbar is a poor
DOM target.** Of its seven controls, only *Exit Bar Replay* has a semantic hook (a localised `title`),
and the **Play** and **Forward** buttons carry no `data-name`, no `data-qa-id`, no `aria-label` and no
`title` — they are reachable only by ordinal position or by a hashed BEM class fragment
(`controls__control_type_forward-x6NoHjDT`). Both are rated *very low* / *low* confidence and both have
exact API equivalents (`toggleAutoplay()`, `doStep()`).

The surfaces that *do* hold up: `[data-name="replay-bottom-toolbar"]`, `[data-name="buy-sell-buttons"]`
with its `buy-order-button` / `sell-order-button` / `qtyEl` children, `[data-qa-id="replay_trading"]`,
`[data-qa-id="trade-button"]`, and `#header-toolbar-replay`.

Two capture hazards recorded in the registry: three separate elements match
`aria-label="Bar replay"` (two are zero-size offscreen duplicates — match on the element id), and two
match `aria-label="Open Replay Trading"` (only one also carries the `data-qa-id`).

---

## 11. Summary of assumptions, separated from findings

| # | Assumption | Why it matters | How to settle it |
|---|---|---|---|
| A1 | `preOrder` bracket/price fields are `qty`, `limitPrice`, `stopPrice`, `takeProfit`, `stopLoss` | §5's four order tools and `replay_brackets_set` all depend on it | place one market order with brackets and read back `broker.orders()` |
| A2 | `qty` on the Replay Broker is denominated such that the sizing hook's arithmetic is meaningful | §7 `SizingPolicy` is meaningless otherwise. `symbolInfo()` gives `qty.min 1, step 1, default 1` and **no `lotSize`** — ounces, lots and contracts are all consistent with that | place one order of known qty, step one bar, read P&L against the bar's price move |
| A3 | Placing via `placeOrder` while the Replay Trading panel has never been opened will work | decides whether the harness needs the one DOM click in §9 | attempt one order with the panel closed |
| A4 | `_replayResolutionsDepth["45S"]` is not the true 45S data depth (§7) | bounds every experiment | select a start bar progressively further back until replay refuses |
| A5 | Reconciliation-based idempotency satisfies §5 | acceptance test 3 | design review, before implementation |

---

## 12. Recommendation

Three items in the brief are unimplementable as written against this environment. Per §10 I am stopping
rather than routing around them:

1. **§6's precondition check and the whole "mirror B14" premise** — the chart does not carry B14 (§1).
2. **§5's `replay_session_open(capital, currency, commission)`** — those settings do not exist on this
   broker (§3).
3. **§3/§4.5's replay-depth question** — answerable only by mutating the live chart's replay start
   point, which I did not do unattended (§7).

Two findings change the intended design for the better and I would want them confirmed before Phase 1:

4. Standardise the order surface on **`broker.placeOrder`**, not on any of the three UI surfaces §3
   lists — better on §2.2's own terms, and the replay toolbar's DOM is too weak to depend on (§2, §10).
5. The §2.4 interlock is an exact allowlist on `currentBroker() === "REPLAYBROKER"` (§5).

And one pre-existing defect is worth a decision independently of this project: `replay_trade` is live in
the default workflow profile, attempts an order, and is inert only because of a null check inside
TradingView (§4).
