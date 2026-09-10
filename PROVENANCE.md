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

**85 tools total, split across two profiles.**

| profile | entry point | tools | contents |
| --- | --- | --- | --- |
| workflow | `src/server.js` (default) | **55** | health 5, chart 11, pine 12, data 12, capture 1, indicators 4, replay 6, alerts 3, `ui_evaluate` 1 |
| diagnostic | `src/server-diag.js` | **85** | workflow plus ui 11, drawing 5, batch 1, pane 4, tab 5, watchlist 4 |

Was 84 at Stage 0. Stage 2b added `chart_await_settled`.

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
  `chart_ready: true` at ~3s while the strategy recomputed until 21.3s.
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

- **TradingView Desktop runs hidden preview contexts that look exactly like the
  chart.** Measured 2026-09-10: `/json/list` reported four chart pages, one
  visible at 1920x1046 and three hidden at 500x318. The hidden ones are layout
  preview renderers carrying a complete `window.TradingViewApi`, their own
  chart model, their own symbol and resolution, and the same study ids. Every
  internal path resolves on them and returns a plausible, wrong answer.

  Target selection used to be "first `/json/list` entry whose URL matches",
  which picks one of the four at random and can pick differently on each
  reconnect. `connection.js` now probes `document.visibilityState` in-page,
  refuses anything not visible, and pins the choice; the pinned target id is
  carried on the state fence and a read from a different context is refused.

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

## Known gaps

- **There is no readable per-bar equity curve, so Sharpe is unverified.**
  `reportData.equity` and `.equityChart` do not exist. `data_get_equity`
  reconstructs a **per closed trade** curve from `trades[].cp.v`, which is the
  most that object supports, and it must never be compared against
  TradingView's `maxStrategyDrawDown` — that comes from the true per-bar curve
  and will not match by definition.

  The acceptance bar for this programme includes Sharpe >= 2.3, and the only
  Sharpe available is TradingView's, computed by an uninspectable method from a
  curve that cannot be read. **That criterion is resting on a black box.**

  Queued, not built: reconstruct a per-bar mark-to-market curve from
  `filledOrders` position state joined against OHLCV, giving Sharpe, Sortino
  and maximum drawdown by a method that is written down, reproducible across
  builds, and comparable against live fills when the execution service exists.

- **Recorded build results have mixed provenance.** Any performance figure
  collected through the tool path after a mutation, before the barrier existed,
  is unverified — it may describe the previous chart state. Which recorded
  results came through which path has not yet been established, and none of
  them should be used as a baseline until it has.

## Standing constraints

- **No live order execution belongs in this bridge.** Orders route via alert
  webhook to a separate execution service against the cTrader API. Any code path
  that can place a live order is to be deleted, not disabled — removing the code
  is the guarantee, a flag is not.
- The TradingView session in use has a live IC Markets broker account attached.
  Treat any UI-reaching capability accordingly.

[upstream]: https://github.com/tradesdontlie/tradingview-mcp
