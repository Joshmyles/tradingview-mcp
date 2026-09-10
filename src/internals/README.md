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

The usable predicate is `isLoading() === false && bars().size() > 0`, with
`seriesErrorMessage()` and `unsupportedResolutionState()` as terminal
conditions. Both are `null` when healthy. A resolution the feed cannot serve
leaves the chart loading indefinitely while looking completely normal, so it
must be reported as an error and not as slowness.

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

Worked example for the `dd` rejection — trade 0, short: entry 4653.54, exit
4654.53, gross −0.99, `cm` 0.22, net −1.21, `rn` 1.72, `dd` 4.45. The give-back
model predicts 2.71.

---

## Re-verifying

Run these after every TradingView update, in this order. Each one has a number
attached in the Falsification record above; if a number moves, the semantics
moved with it.

0. **Barrier terminal conditions.** Confirm `hasError()` still fires on a broken
   study, and that `status().type === 3` still carries `errorDescription`. A
   barrier that cannot terminate is worse than no barrier.

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
