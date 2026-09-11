# TradingView internals

Everything in this directory reaches into TradingView's own runtime. None of it
is a public API, none of it is stable, and none of it is covered by any
compatibility promise. It is pinned to a specific TradingView Desktop build.

**Rule:** no file outside `src/internals/` may contain a `window.TradingViewApi`
path, a CSS class selector, an aria-label, or a `data-name` attribute.

## Verified against

| Component            | Version                                |
| -------------------- | -------------------------------------- |
| TradingView Desktop  | 3.4.1.8194 (MSIX)                      |
| Electron             | 41.7.1                                 |
| Chrome               | 146.0.7680.216                         |
| Node (host)          | v22.12.0                               |
| Verified on          | 2026-09-10                             |
| Verified against     | ICMARKETS:XAUUSD, 45S, study `xVbiv5` ("B14"), 105 trades, Aug 26 – Sep 10 |

Re-run the verification in [Re-verifying](#re-verifying) after every TradingView
update. `reportData` survives CSS churn — which is why it replaced the DOM
scraping path — but it will not survive a runtime refactor.

---

## More than one page context per chart

`/json/list` reports several TradingView pages, and **more than one of them can
look like the chart at the same time.** Measured 2026-09-10 on a two-layout
session:

| target | layout | visibility | inner | outer | screenXY | focus |
| --- | --- | --- | --- | --- | --- | --- |
| `09EBFD9A` | Trial Ground | visible | 1920x1044 | **1920x1080** | -1920, 0 | **true** |
| `962BE3C0` | Trial Ground | visible | 1920x1044 | 1920x1044 | 0, 0 | false |
| `67BD8A45` | Esemble | hidden | 500x318 | 0x0 | 0, 0 | false |
| `8AF118B4` | Esemble | hidden | 500x318 | 0x0 | 0, 0 | false |

None of the three extras are stubs. Each carries a complete
`window.TradingViewApi`, its own chart model, its own symbol and resolution, its
own `dataSources()`, and -- for the same-layout duplicate -- the same study ids.
**Every path in this document resolves on them and returns a plausible, wrong
answer.**

They are also not the same chart. Sampled in the same second, the two
Trial Ground contexts held **different loaded histories**: 329 bars over index
`[-16, 312]` against 381 bars over `[0, 380]`, with different visible ranges.
On a 45S chart the backtest window follows the loaded bar count, so two contexts
that agree on the report today can disagree after any recompute. Attaching to
the wrong one is a correctness hazard, not an inconvenience.

### `visibilityState` does not separate them

This corrects the rule first written here on 2026-09-10 and replaced the same
day, after the duplicate was caught reporting `visible`:

- **The same-layout duplicate reports `visible`.** It reported `hidden` at
  500x318 an hour earlier. It is re-used as the layout preview renderer and
  returns to full size afterwards, so its visibility *and* its viewport change
  under you while nobody touches the chart. Any rule built on either is
  measuring the app's preview scheduler.
- **Minimising the real window does not make it hidden.** Driven through
  user32 `ShowWindow(SW_MINIMIZE)`, `09EBFD9A` reported
  `visibilityState: 'visible'` throughout; only its OS geometry moved, to outer
  `[199, 34]` at `[-32000, -32000]`. Electron keeps the compositor alive.
  So the feared failure mode -- every read refused against a minimised
  TradingView -- **does not occur on this build**, and no fallback is needed
  for it.

### What does separate them

Two signals, both stable across a minimise cycle and a foreground cycle:

1. **`document.hasFocus()`** is true for the real window and false for every
   other context, whenever TradingView is the foreground application.
   Definitive when true; false for all when the user is in another app.
2. **OS window chrome** -- non-zero `outerWidth`/`outerHeight` that *differ*
   from the inner viewport (36px of title bar here). The duplicate's outer size
   is permanently equal to its inner size; the preview renderers report outer
   `[0, 0]`. The real window keeps this property even while minimised.

Neither is sufficient alone: (1) needs TradingView in the foreground, and (2)
would fail for a true-fullscreen window. `selectTarget()` in `targets.js` tries
them in order -- `focused`, `os_window`, `visible_largest`, `largest_viewport`
-- and **names the rule that decided** on `selected_by`. When no rule leaves a
unique winner it **refuses**, listing the tied candidates, rather than picking
one; two contexts on one layout are not interchangeable, so "the first one" is
a coin toss with a wrong side. `TV_CDP_TARGET` pins a context outright and
`TV_CDP_LAYOUT` narrows the pool by layout name.

The chosen id is pinned so a reconnect cannot re-roll it, carried on the state
fence, and a read whose context differs from the fence's is refused as
`target_changed`.

This one is worth internalising before trusting any other measurement here.
While it was unknown, a chart reading `bars().size() === 0` with no error on
any channel looked exactly like a wedged chart, and an entire probe of the
series event bus recorded zero fires and was very nearly written up as "the
events do not fire".

---

## Rule: no level predicate survives a mutation boundary

Every readiness bug found in this codebase has had one shape. A predicate reads
a **level** -- a current value -- and the level is indistinguishable between
"settled on the new state" and "not yet started on the old state".

Three independent instances, none of which looked like the others at the time:

| signal | how it lied |
| --- | --- |
| `mainSeries().isLoading()` / `status()` / `bars().size()` | all three read exactly as settled, on the previous resolution's bars, for the first 139-380ms after `setResolution` returns |
| `bars().size()` as a fingerprint | 300 bars before a rebuild, 300 bars after |
| `reportChanged()` | fires with byte-identical report content |

A stabilisation check does not rescue a level. Measured, the series steps
stale -> 0 -> final in about 7ms, so any hold-still window wide enough to be
useful latches the stale value first.

**The rule: no level predicate on this API is trustworthy across a mutation
boundary. Only edge evidence from an event bus is.** The next signal anyone
adds will present the same trap, and the obvious implementation will be a level
check -- because a level check is one line and always available, while the edge
requires installing a counter *before* the mutation and carrying it on the
fence.

Two corollaries worth stating, because both were nearly missed:

- **An edge is only evidence if it was counted from before the mutation.**
  Hence `captureFence` and the `since` argument. A counter installed after the
  fact proves nothing.
- **One `completed` edge is not the end of a rebuild.** Measured across two
  resolution changes, `dataEvents()` fires *two* load cycles: `loading` +
  `cleared` + `completed` for the initial window, then a second `loading` and a
  second `completed` 6-8s later for the deeper history. Bar counts differ
  between them (300 at the first `completed`, 316 at the second). `seriesRebuilt`
  therefore requires `completed` to have advanced **and** `isLoading() === false`
  at the moment of the check; dropping that second conjunct as redundant
  reintroduces the bug with an 8-second window.

---

## Two objects per study, and they disagree

A study is represented twice, and the two representations do not agree about
whether it is ready.

| | how to get it | what it gives you |
| --- | --- | --- |
| **study-api object** | `chartApi.getStudyById(id)` | `status()`, `isLoading()`, `dataLength()`, `hasError()`, `isVisible()`, `title()`, `getInputsInfo()`, `getInputValues()`, `setInputValues()` |
| **data source** | `…dataSources()` entry with `id() === id` | `reportData()`, `ordersData()`, `reportChanged()`, `performance()`, `metaInfo()` |

Measured 2026-09-10 on a live 45S chart, at the same instant:

```
data source      status().type = 2   isLoading() = false
study-api object status().type = 1   dataLength() = 0
```

**Readiness predicates must use the study-api object.** The data source is only
for report access.

### `status().type`

Established empirically; not documented anywhere.

| value | meaning |
| --- | --- |
| 0 | no data / inactive |
| 1 | loading or recomputing — carries `startTime` (epoch ms) |
| 2 | ready |
| 3 | error — carries `errorDescription` |

Type 3 was found on 2026-09-10 when the chart lost symbol resolution: every
study, housekeeping included, sat at

```json
{ "type": 3, "errorDescription": { "error": "resolve error", "title": "Runtime error" } }
```

with `hasError() === true` and `dataLength() === 0`. Note that `errorMessage()`
returned `null` throughout — the reason is only on `status().errorDescription`.

A study at type 3 never reaches type 2. Any predicate that waits for READY
without a terminal error check hangs on it forever, which is exactly why
`hasError()` is checked first in `awaitSettled`.

`graphicsViewsReady()` and `anyGraphicsReady()` return `true` **while the study
is still loading**. Never use them as readiness signals.

### Sources that never settle

TradingView installs housekeeping pseudo-studies on every chart:
`ESD$TV_DIVIDENDS`, `ESD$TV_SPLITS`, `ESD$TV_EARNINGS`, `ESD$TV_ROLLDATES`. On
an instrument with no corporate actions — XAUUSD, for one — they sit at
`status().type === 1` with `dataLength() === 0` **permanently**. A barrier that
waits for every data source never returns. They are excluded by id prefix.

A working chart also accumulates switched-off overlays sitting at `type 0`
forever. Of the 20 data sources on the reference chart: 4 housekeeping,
11 switched-off overlays, 5 actually computing. (After an app restart the same
chart reported 51 sources — the count is not stable and must never be used as
an identity or a health check.)

### The price series is invisible to a study-based barrier

The main series is in `dataSources()` under the id `_seriesId`, but
`getStudyById('_seriesId')` **throws**. Any snapshot that enumerates sources and
resolves each through `getStudyById` therefore skips the price series entirely,
and skips it *silently*. `awaitSettled` did exactly that until 2026-09-10.

It does not share the study vocabulary either:

| signal | study | main series |
| --- | --- | --- |
| `status()` | 2 when ready | **3** when ready; 4 seen on error |
| `dataLength()` | yes | absent — use `bars().size()` |
| `hasError()` | yes | absent — use `seriesErrorMessage()` |

The two status enums are unrelated. Do not compare a series status to
`STUDY_STATUS`.

`symbolSameAsResolved()` reads like a readiness signal and is not one: it is
`false` on a fully settled chart, because it compares the requested symbol
(`XAUUSD`) against the resolved one (`ICMARKETS:XAUUSD`).

`seriesErrorMessage()` and `unsupportedResolutionState()` are the terminal
conditions. Both are `null` when healthy. A resolution the feed cannot serve
leaves the chart loading indefinitely while looking completely normal, so it
must be reported as an error and not as slowness.

`seriesLoaded()` is not a readiness signal either: it is **false** on a fully
settled chart.

#### There is no instantaneous readiness predicate for the series

`isLoading() === false && bars().size() > 0` looks like one and is not.
Measured 2026-09-10 across a 45S->30S change, sampled in-page at 20ms:

```
   0-380ms   isLoading() false   status() 3   bars().size() 316   <- ALL STALE
     380ms   first level moves: isLoading true, status 2
     694ms   dataEvents().loading fires
     527ms   dataEvents().cleared fires        bars().size() -> 0
     546ms   dataEvents().completed fires      bars().size() -> 300
```

For the first half-second every signal reads exactly as it does when settled,
while `bars()` still holds the PREVIOUS resolution's book. The predicate is
satisfied by stale data.

Stabilisation does not fix it. `bars().size()` does not climb progressively —
it steps stale -> 0 -> final in about 7ms — so a "wait for the count to hold
still" check stabilises on the stale value and latches early.

Neither does bar count as a fingerprint: on the measured pair of changes the
count went 300 -> 300, identical across a genuine rebuild.

#### `dataEvents()` is the signal

`mainSeries().dataEvents()` is a subscribable event bus. Verified firing
2026-09-10 on the visible chart, once per resolution change:

| event | meaning |
| --- | --- |
| `modified` | the mutation registered |
| `loading` | teardown begins |
| `cleared` | `bars()` emptied |
| `completed` | new book in place, `isLoading()` false |

Counting fires gives the series the same barrier the strategy report has: a
generation number plus positive teardown evidence, neither of which a poll can
miss. `awaitSettled` requires `completed` to have advanced past the fence AND a
`loading`/`cleared` to have been counted.

`dataUpdated` fires continuously on a live chart (43 fires in 22 seconds) and
is evidence of nothing. `barReceived` is a new-bar tick, not a rebuild.

The counters are only required when the mutation could actually have rebuilt
the series. Unhiding a study bumps the report and leaves the series untouched,
so demanding a series edge for one waits forever; the fence records which kind
of mutation it came from.

> An earlier run of this probe recorded **zero fires for every event** and
> nearly became a finding. That run was reading a hidden preview context. See
> "More than one page context per chart".

#### Two `status()` methods, overlapping values, opposite meanings

| | study | series |
| --- | --- | --- |
| `status()` = 2 | ready | loading |
| `status()` = 3 | error | ready |

Both objects sit side by side in `dataSources()`. Because a number cannot
carry which object it came from, neither enum is exported from
`src/internals/`: `readiness.js` exports kind-checked predicates
(`isStudyReady`, `isStudyErrored`, `isSeriesErrored`, `seriesRebuilt`) and every
one of them throws if handed a row of the wrong kind. Snapshot rows carry a
`kind` tag for that purpose. Diagnostics returned to callers carry a word
(`ready`, `loading`, `error`, `no_data`), never the raw number.

The same reasoning applies to error reporting. `errorMessage()` returns `null`
on a study that is definitively errored while `status().errorDescription`
carries the reason, so the obvious simplification — read `errorMessage`, drop
the rest — silently discards every error there is. The snapshot does not
collect `errorMessage()` at all, and `studyErrorReason()` is the only accessor.

---

## `reportData` — field semantics

Read via the data source: `source.reportData()`. Returns a **plain object**, not
a watched value — there is no `.value()` to unwrap on this build (the reader
tolerates both).

```
{ currency, settings, buyHold, buyHoldPercent,
  filledOrders, performance, trades, firstTradeIndex }
```

### Trade row

```
{ e: {c, p, tm, b, tp},   // entry
  x: {c, p, tm, b, tp},   // exit
  q, v, tp: {v,p}, cp: {v,p}, rn: {v,p}, dd: {v,p}, cm }
```

| field | meaning |
| --- | --- |
| `e.c` / `x.c` | entry / exit **tag** — the strategy's own `strategy.entry` id string |
| `e.p` / `x.p` | price |
| `e.tm` / `x.tm` | epoch **ms** |
| `e.b` / `x.b` | bar index |
| `e.tp` | `le` = long entry, `se` = short entry |
| `x.tp` | `lx` = long exit, `sx` = short exit |
| `q` | quantity **for this row** |
| `v` | entry notional = `e.p * q` |
| `tp` | realised P&L, **net of commission** |
| `cp` | cumulative P&L through this trade |
| `rn` | **run-up = MFE** |
| `dd` | **drawdown = MAE** |
| `cm` | commission charged to this row |

### The four questions, answered

Each verified across all 105 trades (65 short, 40 long) on the reference chart.
The checks live in `reconcile()` in `report.js` and run on every read.

**1. Units — account currency, not points.**
`report.currency === "USD"`. The identity

```
tp.v  ==  direction * (x.p - e.p) * q  -  cm
```

holds with a maximum absolute error of **8.4e-13** across 105 rows (float
noise). Under a gross model the error is exactly **0.22** on every row — the
commission. So `tp.v` is **net of commission**, in account currency.

`rn` and `dd` are in the same units. On XAUUSD with `q = 1` the point value is
1, so a currency figure and a point figure coincide numerically — do not read
that coincidence as evidence for either.

**2. Sign convention — `rn` and `dd` are unsigned magnitudes.**
Zero negative values across 105 rows, on **both** the 65 shorts and the 40
longs. Direction is carried by `e.tp` and nowhere else. A short whose price rose
against it reports a positive `dd`, exactly as a long whose price fell does.

**3. `dd` is measured from ENTRY, not from the trade peak.**
Two competing models were tested against every row:

| model | prediction | result |
| --- | --- | --- |
| MAE from entry | `dd >= max(0, -gross)` | **0 violations / 105** |
| giveback from peak | `dd == rn - gross` | mean abs error **5.78**, max **61.18** |

The giveback model is decisively rejected. `rn` is likewise MFE from entry
(`rn >= max(0, gross)`, 0 violations).

Worked example — trade 0, a short:

```
entry 4653.54  exit 4654.53  gross -0.99  cm 0.22  net -1.21
rn 1.72  →  price reached 4651.82 in favour
dd 4.45  →  price reached 4657.99 against
```

`dd` (4.45) far exceeds the realised loss (0.99), which only the from-entry
model permits. The giveback model would predict 2.71.

**4. Per-unit vs position-total when `q != 1` — UNVERIFIED, and guarded.**

Every one of the 105 rows has `q = 1`, and not by accident: when a stacked
position is closed by a single multi-quantity order, **TradingView splits it
into one `q = 1` trade row per open leg**, each carrying its own entry price and
its own `rn` / `dd`. See the reconciliation below.

So the question does not arise in this dataset. It would arise if
`strategy.entry` were called with `qty > 1`. Since that case is untested,
`reconcile()` emits `unverified_multi_qty_rows` and a warning whenever a row
with `q > 1` appears. **Do not size stops from such rows without re-verifying.**

### Per-leg MAE, and why it matters

Because multi-leg exits are split per leg, `dd` is a **per-leg** excursion from
**that leg's own entry**. Three legs of one stacked short, all exited at bar
1254 @ 4619.57:

| row | entry tag | entry bar | entry price | MAE | MFE | net |
| --- | --- | --- | --- | --- | --- | --- |
| 4 | `B CZX DN` | 420 | 4646.82 | 4.68 | 48.65 | 27.03 |
| 5 | `B CZX ADD DN` | 829 | 4623.33 | 10.56 | 25.16 | 3.54 |
| 6 | `F CZX ADD DN` | 933 | 4620.49 | 13.40 | 22.32 | 0.70 |

This is the right granularity for sizing a per-leg stop. It is the wrong
granularity for sizing a single position-level stop, and the three MAEs above
show why the distinction is not academic.

### Entry tags are the metadata channel

`e.c` is the strategy's own entry id. Feature vectors encoded there come back
joined to `rn` and `dd` with no Pine instrumentation at all. `normaliseTrade()`
exposes them as `tag_tokens` (whitespace-split), never as a raw string a caller
has to re-parse. Observed on the reference chart: `B CZX DN`,
`B CZX ADD DN`, `F CZX ADD DN`, `RVX DN`; exits `CZX OPP`, `B CZX HS`,
`R CZX RT`.

### Filled orders

```
{ b, c, e, id, p, q, tm, tp }
```

`b` = buy, `e` = **is an entry**, `id` = order id (`CZS`, `XCZL`,
`Close position order`, …), `tp` = `MARKET` / `STOP`, and **`tm` is a sequence
number, not a timestamp**.

`ordersData()` and `reportData().filledOrders` are the **same array object** —
identity-equal, verified 2026-09-10 (198 rows). There is no second order channel
to cross-check against; reading either reads the same thing.

Note the key `tp` is overloaded across the two shapes. On a **trade** row it is
the realised P&L object `{ v, p }`; on an **order** row it is the order type
string (`'STOP'`, `'MARKET'`). Do not share a mapper between them.

### There is no equity curve

`reportData.equity` and `reportData.equityChart` do not exist and never did —
verified absent 2026-09-10. Code reading for them silently falls through.

The top-level keys are exactly: `currency`, `settings`, `buyHold`,
`buyHoldPercent`, `filledOrders`, `performance`, `trades`, `firstTradeIndex`.

What can be built is a **per closed trade** curve from `trades[].cp.v`, the
running cumulative P&L, with `buyHold` (length = trades + 1, based at 100) as its
aligned baseline. TradingView does not expose a per-bar account curve through
this object. Anything presented as one is inferred, and should say so.

#### Never compare a trade-indexed curve to `maxStrategyDrawDown`

`performance.all.maxStrategyDrawDown` comes from TradingView's own curve, which
is per bar and includes open positions. The reconstruction here is indexed by
closed trade and cannot see intra-trade depth at all. The two will not match,
and the difference is not an error in either — they are drawdowns of different
series. A reconciliation written against that expectation would be chasing a
discrepancy that is definitionally there.

#### Queued: a per-bar mark-to-market curve

The reconstruction that would close this properly is a per-bar equity curve
built from `filledOrders` position state joined against OHLCV: carry the
running position through each bar, mark it at the bar's close, and add realised
P&L as it lands.

That yields Sharpe, Sortino and maximum drawdown computed by a method that is
**written down, reproducible across builds, and comparable against live fills**
once the execution service exists.

This is not a tooling nicety. The acceptance bar for this programme includes
Sharpe >= 2.3, and the only Sharpe currently available is TradingView's,
computed by an uninspectable method from a curve that cannot be read. That
criterion is resting on a black box until this exists.

Not built here. Recorded so it is a known gap rather than an assumption.

### Reconciliation — 105 trades vs 198 fills

```
198 filled orders = 105 entry + 93 exit
```

Clean 1:1 pairing would imply 210. The 12-row gap is explained **exactly** by
multi-quantity close orders: eight of them, four with `q = 3` and four with
`q = 2`, all `id: "Close position order"`.

```
4 * (3-1)  +  4 * (2-1)  =  12
```

Every multi-quantity order in the dataset is an **exit**; there are no
multi-quantity entries. Pyramiding stacks legs as separate `q = 1` entry orders
and unwinds them with one position-level close.

`reconcile()` re-derives this on every read as
`exit_orders + multi_qty_exit_excess + open_rows == trades`, and marks the book
suspect if it stops holding.

**No FIFO scrambling in this dataset.** Every multi-quantity exit is a full
position close, so the entry→exit pairing is unambiguous. That is a property of
this strategy's exit behaviour, not a guarantee — partial exits would reopen the
question.

#### Known future breakage: partial exits

Per-leg attribution — and with it the whole per-leg MAE result below — holds
**only because every multi-quantity exit in this dataset is a full position
close**. If a future build scales out of a position, TradingView pairs the
remaining legs FIFO, and two things stop being true at once:

1. `exit_orders + multi_qty_exit_excess + open_rows == trades` stops meaning
   what it means today. A partially-closed position contributes rows that this
   arithmetic does not model, so the invariant will fail.
2. `dd` and `rn` on the affected rows stop being clean per-leg excursions from
   that leg's own entry, because the row no longer corresponds to one leg.

**When that invariant fails, do not patch the arithmetic to make it pass.**
Its failure is the signal that the pairing model changed, and the pairing model
is what every stop-sizing conclusion rests on. Re-derive the model first.

### `settings.dateRange`

```
{ backtest: {from, to}, trade: {from, to} }
```

`backtest` is the requested window; `trade` spans first entry to last exit.

**`backtest.to` is the live chart edge and advances with every new bar** —
measured ticking forward by one bar interval during a single session. It is not
part of a report's identity. Use `backtest.from` when fencing state, and never
put `backtest.to` in a fingerprint: a settled report would look permanently
unstable.

---

## The price series is not the backtest window

`mainSeries().bars()` is a rolling cache sized to the viewport, not to the
range the strategy was computed over. Measured 2026-09-10 on the live 45S
chart, in one instant:

| | value |
|---|---|
| bars loaded | **372**, indices `-66..305` |
| book span | **21,518 bars**, study indices `156..21673` |
| `dateRange.backtest.from` | 1787695320000 — 15.9 days back |

Two consequences, both silent.

**The index spaces are different.** `trades[].e.b` / `.x.b` count from the
first bar of the study's history and are always non-negative.
`bars().firstIndex()` is negative and rebases whenever loaded history changes.
The same instant is index 305 in one space and 21673 in the other. **Join by
time, never by bar index.** Derive the offset afterwards if you want it as a
check; do not use it to perform the join.

**History has to be pulled in before any per-bar work.**
`mainSeries().requestMoreData(n)` extends the cache and `requestMoreDataAvailable()`
says whether more exists. Measured: 372 → 5,373 bars in 1.4s, and 372 → 21,675
bars covering the whole book in **3.8s across two rounds**. It is the same
operation as scrolling back — it does not touch symbol, resolution or inputs.

It does move `dateRange.backtest.from`, because the backtest range follows the
loaded bars. **Any report read before extending history describes a different
book than the bars now loaded**, and pairing the two produces a reconstruction
in which every number looks plausible. Re-read the report afterwards.

---

## `dd` and `rn` are leg EQUITY excursions, not price excursions

Established by reconstructing all 106 rows of the live book from the same bars
TradingView reads. The first attempt — bar extremes from entry bar to exit bar
— matched **zero** of 106. Three corrections take it to **106 of 106 on both
MAE and MFE**:

| # | correction | evidence |
|---|---|---|
| 1 | Add the entry-side commission to MAE, subtract it from MFE | a dead-constant 0.11 on every row against a 0.22 round trip |
| 2 | The exit bar contributes its **exit price**, not its high and low | without it 39 of 106 overstated MAE, one by 2.58 — every one a hard-stop exit whose bar ran on after the stop |
| 3 | Floor both at zero | 3 rows never moved far enough in their favour to cover the entry commission; TradingView reports `rn = 0`, not a small negative |

The entry bar contributes its **full** range. A fill inside a bar cannot be
located more precisely than the bar, and the full match says TradingView does
the same.

**This changes what a stop counterfactual means.** A price stop triggers on the
price excursion. The reported MAE is that excursion **plus 0.11**, so a
counterfactual comparing `mae >= L` triggers on a move 0.11 smaller than `L`.
`excursionPaths` therefore emits `mae_price_only` alongside `mae_recomputed`,
and the two must not be substituted for one another.

---

## Sharpe: TradingView reports a NON-ANNUALISED DAILY ratio

`reportData` has no per-bar equity, and `performance.sharpeRatio` comes from a
curve TradingView does not expose. `src/internals/equity.js` reconstructs the
curve and computes the ratios by a stated method. The gap between the two was
open until 2026-09-11, when it was closed by testing candidate methods against
the reconstruction instead of reporting the difference as unexplained.

Un-annualised, on the reconstructed curve, against a reported **0.3701**:

| interval, un-annualised | ratio |
|---|---|
| per bar (45s) | 0.0064 |
| hourly | 0.0572 |
| per closed trade | 0.1229 |
| **daily, UTC days, sample sd** | **0.3507** |
| **daily, UTC days, population sd** | **0.3640** |
| daily, across every other day boundary tried | 0.25 – 0.37 |

No other interval is within an order of magnitude; the daily row brackets the
reported figure. The residual few percent is the day boundary and whether the
sd is sample or population, neither of which TradingView exposes.

**Reproduced on a second, differently-configured book** (2026-09-11, 54 legs,
after OPPX/RVX/PYRX were switched off): reported **0.3803** against daily
0.3551 sample / 0.3685 population, with per-bar 0.0080 and per-trade 0.1672.
Same order, same bracketing, same small positive residual. The identification
was made on one book and held on another it was not fitted to.

**The consequence is the point.** A Sharpe threshold read against the
TradingView display is a threshold on a *daily* ratio. The conversion is
`sqrt(252)` ≈ 15.9, so a displayed 0.3701 is about **5.9 annualised**, against
**4.45** for the same curve sampled per bar — the same order, as it must be.
Read the other way, a "Sharpe ≥ 2.3" bar asserted against the display demands
roughly **36 annualised**, which nothing real reaches. State the method.

Annualising here uses bars *observed*, not the nominal bar length: gold is shut
at weekends, so a nominal 45-second period implies 700,800 bars a year and
overstates the annualisation by the fraction of the week the market is closed.

### Drawdown: TradingView's is not reconcilable with TradingView's own run-up

Same book, same instant:

Measured on TWO books — the drifted 101-leg book of 2026-09-10, and the
54-leg book after the configuration was corrected on 2026-09-11. The second is
the stronger evidence: the identification was not refitted to it.

| basis | drifted: DD / run-up | intended: DD / run-up |
|---|---|---|
| closed-trade curve (`trades[].cp.v`) | 57.95 / 213.65 | 65.89 / 134.49 |
| daily-sampled | — | 62.91 / 137.13 |
| per-bar, marked at bar closes | 115.97 / 270.23 | 91.88 / 159.98 |
| per-bar, marked at bar extremes | **121.96** / **275.82** | **94.37** / **162.44** |
| **TradingView reported** | **60.68** / **275.04** | **67.25** / **161.72** |

Run-up identifies the curve on both: the envelope matches to 0.28% and then to
0.45%, and the closed-trade curve is 22% and 17% short — it cannot reach the
reported figure at all. On that same envelope the drawdown is 2.01x and then
1.40x the reported one.

**Daily sampling was tested as the explanation and refuted**: 62.91 against a
reported 67.25 is further off (-6.5%) than the closed-trade curve's 65.89
(-2.0%). No candidate equals it. `tradingviewComparison` now ranks all four by
distance from the reported pair on every run, rather than asserting the
identification in prose.

The run-up identifies the curve: 275.04 cannot come from a closed-trade curve
that tops out at 213.65, and it matches the intrabar envelope to 0.3%. So
TradingView marks **per bar, intrabar, including open positions**. On that
curve the drawdown is 121.96, and TradingView reports 60.68 — a factor of
**2.01**. The closed-trade curve gives 57.95, close but not equal, so a
closed-trade basis does not explain it either.

Treat the envelope as what the position experienced and the reported drawdown
as an understatement of roughly half. On this book the drawdown is traceable to
one leg that held **+108.74 unrealised and realised +47.49** — a 61.25 give-back
on a single trade, which is the give-back defect showing up in the curve rather
than in a per-trade statistic.

---

## Excursions from bar extremes are RESOLUTION-INVARIANT

Reported MAE is not understated by low detalization. It cannot be.

The excursion scanner reproduces `dd`/`rn` on 101 of 101 rows at 45S. Re-running
the identical scan against finer bars over the same holding periods, 2026-09-11:

| finer series | span | legs covered | MAE delta | MFE delta |
|---|---|---|---|---|
| 5S (21,074 bars) | 30.5h | 15 | **exactly 0** | exactly 0 |
| 1S (20,902 bars) | 6.5h | 6 | **exactly 0** | exactly 0 |

Zero, not "small" — the deltas are `0.00e+0`. This is an identity, not a
measurement. A coarse bar's high **is** the maximum of the fine bars' highs
inside it, and every entry and exit in the book lands on a 45S bar boundary
(101 of 101), so there is no partial-bar effect at the ends either. It is also
why Deep Backtesting gave 99 of 100 identical MAE figures: the same identity,
not a failure of that route.

So a stop level fitted against these excursions needs **no detalization
correction**. What resolution genuinely governs is fill *sequencing* within a
bar — whether a stop or a target filled first — which is an execution question,
not a measurement one, and `tighteningBenefit` brackets it rather than assuming
it.

What finer bars *do* buy is the **path**. `mae_at`/`mfe_at` are quantised by the
leg's bar count, and a 7-bar leg can only place its extreme at sevenths; at 5S
the same leg has 63 points. Anything conditioning on *when* a leg took its heat
belongs on the finer series.

### Seconds history is capped by BAR COUNT, not by span

Measured the same day, each stopping on `endOfData`:

| resolution | bars reached | span |
|---|---|---|
| 45S | 20,511 | 366.5h (15.3 days) |
| 5S | 21,068 | 30.5h |
| 1S | 20,902 | 6.5h |

Roughly 21,000 bars at every resolution. Finer resolution buys detail by
spending span, so a finer-resolution analysis can only ever cover the most
recent legs — `refineExcursions` reports which, and does not drop the rest
silently.

---

## MAE becomes CENSORED once a stop exists

Correction #2 in the excursion model — the exit bar contributes its exit price,
not its range — is this effect visible in TradingView's own numbers. For a
hard-stop exit the bar frequently runs on past the stop, and the reported MAE
is truncated at the stop by construction. Without that correction 39 of 106
rows overstated MAE, one by 2.58, and every one of them was a stop exit.

**Standing rule.** Any build carrying a stop reports a censored MAE
distribution, so:

- the no-stop dataset is the reference distribution and is preserved;
- **any re-fit of a stop parameter goes back to a no-stop run**, never to the
  output of a stopped build.

Without this the second iteration fits to its predecessor's censoring and every
one after that compounds it. The current 45S book is *already* stopped — 31 of
101 exits are `HS` and 29 are `RT` — so it is a valid dataset for measuring what
an *additional* rule would have cost, and an invalid one for fitting a stop
level on.

---

## Report readiness — a separate condition from study readiness

A settled study does **not** mean a regenerated report.

Measured 2026-09-10, sampling at 50ms across a 45S → 30S change:

```
t=  53ms  res 45S   report: 105 trades, net 177.21, window from 1787695320000
t= 509ms  setResolution("30S") issued
t= 516ms  res 30S   report: 105 trades, net 177.21, window from 1787695320000   ← STALE
t= 805ms  res 30S   report: null
t=3534ms  res 30S   report: null                     study type 1
t=19180ms res 30S   report:  68 trades, net -94.63, window from 1788213720000  ← regenerated
t=20353ms res 30S   study back to type 1, dataLength 0                          ← live bar
t=35527ms res 30S   study type 2 again
```

Two things follow.

**The stale-read window is real.** At `t=516` the chart reported 30S while
`reportData` still returned the complete, plausible, entirely wrong 45S book.
No error, no null, no flag. The overlap is ~0.3s when the mutation is issued
directly and stretches to ~7.5s when issued through a tool that does its own
waiting first — either way it is wide open to an agent pipelining calls.

**A live seconds chart never stays settled.** The study returned to `type 1`
1.2s after reaching `type 2`. A predicate demanding "computed right now" would
never return, which is why `awaitSettled` **latches**: once a study is observed
computed, it stays settled for the duration of that call.

### The generation counter

`source.reportChanged()` returns a Delegate with
`subscribe / unsubscribe / unsubscribeAll / destroy / fire`. TradingView fires it
each time it replaces a strategy's report. `INSTALL_GEN_COUNTER_JS` subscribes a
counter at `window.__tvmcp_gen[entityId]`, idempotently.

Capture it **before** the mutation with `captureReportState()`, which returns
both the counters and the current fingerprints.

Without a `since`, the gate falls back to fingerprint stability across
consecutive reads, which is weaker: a stale report is perfectly stable.

#### The counter is necessary but not sufficient

A generation bump does **not** prove the book changed. Measured 2026-09-10:
`reportChanged()` fired three times (gen 179 → 182) while the report's content
stayed byte-identical. A gate requiring only `gen > since.gen` can therefore be
cleared by a no-op refire that left the previous book in place.

So `awaitSettled` additionally requires **teardown evidence** before it accepts a
regeneration: either the report went absent during the recompute, or its
fingerprint moved off the one captured before the mutation.

#### And it fails open after a restart

Counters are page state. They do not survive a reload or an app restart, and are
reinstalled at 0. A `since.gen[id]` of 0 is then cleared trivially by whatever
report happens to be sitting there. Observed directly on 2026-09-10: after a
TradingView restart the first read reported `report_gen: 0`.

This is why `readStrategyReport` also takes `expectWindow`. Asserting
`settings.dateRange.backtest.from === the window that was set` does not depend on
page state at all, and is the only check in this file that survives a restart.

#### The read itself cannot tear

TradingView **replaces** the report object on regeneration rather than mutating
it in place — verified 2026-09-10 by pinning a reference across three
generations: a new object appeared each time and the pinned reference's content
never changed.

So a page-context expression that takes one `reportData()` reference and derives
everything from it — fingerprint, trades, filled orders, performance — returns a
single coherent snapshot. Combined with the page being single-threaded and
`returnByValue` serialising with no interleaved script, one `Runtime.evaluate`
is atomic.

What is *not* atomic is the gap between the settle poll and the read, which are
separate round-trips. `readStrategyReport` closes that by comparing the read's
own fingerprint against the one the latch observed and re-reading if it moved
(measured gap on a settled chart: 14ms).

---

## The state fence

A generation bump proves *a* rebuild happened. It does not prove the rebuild
was the one asked for, on the chart it was asked for, under the configuration
that was set. Those are separate questions and they fail apart: a rebuild
triggered by a passing bar clears the first and none of the others.

`captureFence()` snapshots, before the mutation: the CDP target identity, the
symbol and resolution, the per-strategy report generation and fingerprint, the
series event counts, and a per-strategy **input hash**. `checkFence()` compares
a read against it.

A fence also records what the mutation is *allowed* to change
(`expect_series_rebuild`, `expect_inputs_change`, `expect_report_rebuild`).
Declaring nothing makes it a pure drift baseline that requires no rebuild — an
early version conflated the two and a clean read against an untouched chart
waited the full 90-second timeout for a regeneration nobody had triggered.

### The input hash covers 353 of 361 entries

`getInputValues()` returns 361 entries on the reference strategy and 8 of them
are not settings. Hashing the array whole produced a **different hash every
time** — measured `b6faec59` -> `1eeb640f` -> `387a93cf` across two recomputes —
because `first_visible_bar_time` and `last_visible_bar_time` track the
viewport. A fence built on that reports the configuration as drifting whenever
the chart scrolls.

Excluded, all host or view state rather than strategy configuration:
`text` (the 199KB encrypted Pine source; stable, but `pineVersion` identifies
the script far more cheaply), `pineFeatures`, `__chart_bgcolor`,
`__chart_fgcolor`, `__log_level`, `first_visible_bar_time`,
`last_visible_bar_time`, `__profile`.

Allowlisted (`in_<N>`, `pineId`, `pineVersion`) rather than denylisted: a new
volatile host field added by a TradingView update silently rejoins a denylist
and breaks the fence, whereas it simply stays out of an allowlist. The
remaining 353 entries hashed to `d4aa3b87` before, during and after two full
recomputes.

An input write that did not land is caught in one round trip rather than at the
end of the settle timeout: if the hash has not moved, no new report is coming,
and the current one describes the old settings. Measured 33ms against 90s.

> `in_<N>` above is a literal `in_` followed by digits. The pattern is written
> `[0-9]` and not the shorter character class, because the snippet lives in a
> template literal where an unknown escape silently loses its backslash — the
> first version emitted `/^in_d+$/` into the page and matched 2 entries of 361.

## Input ids: where the script ends and TradingView begins

`in_<N>` is a POSITION, not a name. TradingView numbers inputs by the order
their `input.*` calls appear in the source, from zero, and nothing in the
source says `in_0`. Deleting one input renumbers every input after it — it has
already happened once in this lineage, when five dead inputs left build 13 and
shifted the whole tail.

Measured on B14, 2026-09-11, by parsing the source and joining against
`metaInfo().inputs`:

| ids | count | what they are |
|---|---|---|
| `in_0 .. in_325` | 326 | the script's own `input.*` declarations, in source order |
| `in_326`, `in_327` | 2 | **do not exist.** A gap TradingView leaves |
| `in_328 .. in_352` | 25 | **TradingView's strategy properties** — not in the Pine source at all |

`getInputValues()` returns 351 entries: 326 + 25. **Its array index is NOT the
id.** Position 326 carries `in_328`. Joining a source parse to it by array
position reads two ids early from the properties onward and looks entirely
plausible — it reported "Use Bar Magnifier" as `in_342`, which is a real input
with a real value that happens to be the wrong one. Join by id.

### The strategy properties decide what a backtest means

They are settable, hashable, and invisible to any source-derived manifest, so a
manifest that omits them pins the strategy and not the experiment. On B14:

| id | property | value |
|---|---|---|
| `in_328` | Initial Capital | 100 |
| `in_330` | Order size | 1 contract — which is why every row has `q = 1` |
| `in_331` / `in_332` | Commission | `cash_per_contract`, **0.11** per side |
| `in_333` | Slippage | **0** — every net figure is optimistic by the spread |
| `in_336` | pyramiding | 10 |
| `in_342` | Close entries rule | **FIFO** |
| `in_343` | **Risk free rate** | **2** |
| `in_344` | **Use Bar Magnifier** | **true** (the only non-default) |

> **Correction.** An earlier note here said no risk-free-rate setting was
> exposed. That was true of `reportData().settings`, which carries only
> `dateRange` — but the setting exists, as `in_343`, defaulting to 2. Whether
> TradingView applies it to the displayed Sharpe is a separate question; note
> that applying a positive rate would LOWER the ratio, and the reported figure
> sits slightly ABOVE the reconstruction on both books measured, so it does not
> explain the residual.

### A manifest is derived from source, never from a chart

The chart is the thing a manifest CHECKS. Deriving the reference from a
snapshot of the chart makes the check vacuous, and that is exactly how an
unintended configuration became the baseline.

`internals/pine-source.js` parses the declarations; `scripts/make-manifest.mjs`
combines them with an explicit override list and writes the manifest, carrying
the source file's SHA-256 — because ids are positional, a manifest only means
anything against the revision it was derived from.

Verified before use, on B14: **326 of 326 titles matched** `metaInfo().inputs`
and **309 of 309 literal defaults were identical**. The 17 that cannot be
derived are colour constructors — `color.new(color.blue, 70)` has no value
until the script compiles — and are left UNPINNED rather than guessed.

### One manifest per build

Build 14's study is titled "B14" and build 15's will be "B15". Both can be
loaded on one chart, and a prefix matches both.

- `resolve_entity` **refuses** when more than one study matches, naming the
  candidates. Matching runs id → exact title → substring, so ambiguity is
  always escapable by being specific.
- The manifest's title is part of the assertion and is compared for EQUALITY.
- Asserting one build against another build's manifest returns `wrong_build`
  and **does not compare the inputs**. It is a different script, not a
  different configuration; enumerating three hundred differences would bury
  that.

The inactive alert `5500389832` on this account is the hazard made visible: it
carries a frozen input map from `pine_version 0.27`, and read against the
current build's names its values land a position or two out — `in_274` holds
`2000-1400` against a name reading "Tint the live window".

## A strategy alert carries its OWN frozen configuration

Measured 2026-09-11. The active alert on B14 (`5574059086`) embeds a complete
351-entry input map and `pine_version 0.43`, while the chart study is `0.46`.

**Changing the study on the chart does not change what a live alert executes.**
The alert runs the configuration it was created with, until it is recreated.
So there are three configurations in play at once and they can all differ: the
one on the chart, the one a backtest describes, and the one live orders come
from. Read the alert's own map before reasoning about live behaviour, and never
infer it from the chart.


## Pine logs live on the study, not in the DOM

Measured 2026-09-11. Every study data source exposes `logs()`, which returns
`this._graphics.observableLogs().get("logs")` when the script's metaInfo
declares `graphics.logs`, and **null** otherwise. Of 13 user studies on the
reference chart, 12 returned null (they emit no `log.*`) and only `xVbiv5`
returned a collection. No panel, no Pine Editor, no fiber walk.

Three states, and an empty read is only honest if it says which:

| `collection` | meaning |
| --- | --- |
| `absent` | `logs()` is null — the script emits no `log.*` call at all |
| `disabled` | the collection exists and `logLevelMask()` is all false — rows are discarded as produced |
| `present` | at least one level on |

The reference chart was found **disabled**: mask all false, size 0. Enabled,
the same study produced **1,266 rows** (CENSUS 1118, TELX 116, RVX 18, MINX 12,
CFG 2). Row shape `{ barTime, time, level, source: {start: {line, column}},
message }`; `source.start.line` is the emitting Pine line.

- `setLogLevelMask` packs `error 1 | warning 2 | info 4` into the INPUT
  `__log_level` — excluded from the fence allowlist and in no manifest, so it
  moves nothing any check here can see.
- **`extract()` empties the collection.** Use `forEach` only. `keys()` throws
  "Not implemented".
- The collection is rebuilt on every recompute. `pine_console_read`'s cursor is
  checked against the log head and the row it resumes after, and refused as
  `cursor_stale` otherwise.

## Replay

- **`currentDate()` is epoch SECONDS** (`1788849356` on 2026-09-08). Everything
  else in this bridge is milliseconds; `replay_step_until` converts at the
  boundary.
- **Step latency is not sleepable.** Ten consecutive steps: 283, 7711, 599,
  444, 282, 293, 378, 349, 301, 305 ms. Wait on the `currentDate()` edge.
- **`doStep()` does not wait for studies.** Right after a replay start
  `bars().size()` was 0 and `reportData()` null while the cursor was set.
  Report-derived predicates need a per-step settle or they read the previous
  bar.
- **`stopReplay()` saves a session into the layout.** It is
  `requestCloseReplay(true)` -> `_updateReplaySessionState()`, which, unless
  replay reached the end of data, writes `{replayTime, replayMode, charts}` via
  `chartWidgetCollection.updateReplaySessionState()` and marks the layout
  changed. The next load raises a blocking **"Continue your last replay?"**
  modal. Every programmatic replay stops mid-history, so every one left that
  modal on the research layout until `replay_stop` began clearing it with
  `updateReplaySessionState(null)`.

## Strategy alerts: where the frozen map is

`pricealerts.tradingview.com/list_alerts` -> `type: 'strategy'` ->
`condition.series[0] = { type: 'study', pine_id, pine_version, inputs }`, with
`inputs` keyed by the study's positional `in_N` ids plus host keys
(`__chart_bgcolor`, `__log_level`, ...). Active `5574059086`: 358 keys at
`0.43`; inactive `5500389832`: 315 at `0.27`. `preflight` compares the `in_N`
part against the manifest exactly as it compares the chart.


## Pine drawing x is in neither known index space

Measured 2026-09-11 while building `loss_autopsy`. The drawing readers
(`data_get_pine_lines` / `_labels` / `_boxes`) return `x` / `x1` / `x2` straight
from `s._graphics._primitivesCollection.<kind>.get(...)._primitivesDataById` —
TradingView's primitive store, the same family of collection that carries
`replaceIndexesTo` and `_isRematerializationRequiredWithNewIndexes`, i.e. one
whose indices TradingView remaps itself.

On B14 in one settled state: drawing x **1..867**; trade `entry.bar`
**48..20463**; `bars()` indices **-20411..302**. Each drawing's price was placed
on the bar at its x under both readings, with a ±5 tolerance:

| reading of x | located | price on that bar |
| --- | --- | --- |
| study bar index (via the book's own bar↔time anchors) | 504 / 538 | **0%** |
| `mainSeries().bars()` index | 200 / 538 | **4%** |
| control: study index, x+500 | 538 / 538 | 0.2% |
| control: bars() index, x+500 | 0 / 538 | — |

Neither is the space. A time-window or bar-window filter on drawings therefore
returns the wrong drawings while looking right — the first `loss_autopsy` run
"kept" 35 lines and 52 boxes that way. Drawings are reported as totals, marked
`joined: false`, until the primitive index space is identified and its
mapping gets `internals_verify` coverage.

---

## Falsification record

The disproved models, kept beside the proved ones. A conclusion without its
evidence has to be taken on trust; with the numbers that rejected the
alternatives, the check is re-runnable after a TradingView update instead of
being re-argued.

| question | model | verdict | evidence |
| --- | --- | --- | --- |
| units | net of commission | **accepted** | `tp.v == dir*(x.p-e.p)*q - cm`, max abs error **8.4e-13** over 105 rows |
| units | gross of commission | **rejected** | errs by exactly **0.22** on every row — the commission |
| `dd` | MAE measured from entry | **accepted** | **0 violations / 105** |
| `dd` | give-back from the trade peak (`dd == rn - gross`) | **rejected** | mean abs error **5.78**, max **61.18** |
| sign | `rn`/`dd` unsigned magnitudes | **accepted** | 0 negatives / 105, across 65 shorts *and* 40 longs |
| `q > 1` rows | per-unit vs position-total | **UNVERIFIED** | no `q > 1` row exists in the dataset; guarded at runtime, not guessed |
| `_seriesId` readiness | `symbolSameAsResolved()` | **rejected** | `false` on a fully settled chart |
| regeneration | generation bump alone | **rejected** | gen 179 → 182 with byte-identical content |
| entity ids | churn across an app restart | **rejected** | `xVbiv5` / "B14" survived a full restart unchanged |
| series readiness | `isLoading() === false && bars().size() > 0` | **rejected** | holds, on stale bars, for the first 139-380ms after a mutation |
| series readiness | `seriesLoaded()` | **rejected** | `false` on a fully settled chart |
| series rebuild | bar count as a fingerprint | **rejected** | 300 -> 300 across a genuine rebuild |
| series rebuild | bars climb progressively during load | **rejected** | steps stale -> 0 -> final in ~7ms; no ramp to stabilise on |
| series events | `dataEvents()` never fires | **rejected** | fires `loading`/`cleared`/`completed` once per change; the null result came from a hidden preview context |
| chart target | URL match identifies the chart | **rejected** | 4 chart pages, 3 of them hidden preview renderers with complete APIs |
| input hash | hash all of `getInputValues()` | **rejected** | 3 different hashes across 2 recomputes; viewport fields move |
| drawing x | study bar index | **rejected** | 0% of 504 drawings priced on the bar at their x |
| drawing x | `mainSeries().bars()` index | **rejected** | 4% of 200, controls 0-0.2% |
| replay cursor | `currentDate()` in ms | **rejected** | returns epoch seconds (1788849356) |
| empty log read | "script logged nothing" | **rejected** | collection disabled: mask all false, 0 rows; enabled, 1,266 rows |

Worked example for the `dd` rejection — trade 0, short: entry 4653.54, exit
4654.53, gross −0.99, `cm` 0.22, net −1.21, `rn` 1.72, `dd` 4.45. The give-back
model predicts 2.71.

---

## Re-verifying

Run these after every TradingView update, in this order. Each one has a number
attached in the Falsification record above; if a number moves, the semantics
moved with it.

0. **Attach to the right context.** Confirm exactly one chart page reports
   `document.visibilityState === 'visible'`, and that it is the one you are
   looking at. Every check below is meaningless against a preview renderer,
   and none of them will tell you that is what happened.

0. **Barrier terminal conditions.** Confirm `hasError()` still fires on a broken
   study, and that `status().type === 3` still carries `errorDescription`. A
   barrier that cannot terminate is worse than no barrier.

0. **Series event bus.** Confirm `mainSeries().dataEvents()` still exposes
   `loading`, `cleared` and `completed`, and that each fires exactly once
   across a resolution change. If they stop firing, check the context before
   concluding anything.

0. **Input hash stability.** Confirm the settings hash is unchanged across a
   resolution change. If it moves, `getInputValues()` has gained a volatile
   field and the allowlist needs it excluded — do not widen the allowlist to
   make the check pass.

After every TradingView update, before trusting a single number:

1. `awaitSettled({ scope: 'strategies' })` → expect `outcome: "settled"`.
2. `awaitSettled({ entityId: '<nonexistent>' })` → expect `outcome: "absent"`,
   not a hang.
3. `readStrategyReport({ entityId })` → check `reconciliation`:
   - `rows_explained: true`
   - `pnl_identity.holds: true` (max abs error < 1e-6)
   - `excursion_identity.holds: true` (0 MAE, MFE and sign violations)
4. Mutate the timeframe and confirm the gated read blocks until the report
   regenerates: `report_gen` must advance and the trade count must change.

If step 3 fails, the field semantics have moved and **every downstream number is
suspect** — MAE-based stop sizing first among them. Stop and re-derive the
table above; do not patch the normaliser to make the check pass.
