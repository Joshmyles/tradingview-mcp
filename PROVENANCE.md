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

## Tool count

**85 tools.** Was 84 at Stage 0 — matching `README.md`, `CLAUDE.md` and the
server `instructions` string, with no discrepancy to fix. Stage 2b added
`chart_await_settled`.

Distribution: ui 12, pine 12, data 12, chart 11, replay 6, health 5, drawing 5,
tab 5, indicators 4, pane 4, watchlist 4, alerts 3, batch 1, capture 1.

The three docs that state the count have **not** been updated to 85 yet; they
are part of the profile split, which changes the number again by removing tools
from the workflow profile.

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

*(Nothing removed yet. Stage 5 records its deletions here — in particular the
`'trading'` panel target and the generic UI-clicking surface, which together
form a reachable path to the order panel of a connected live broker account.)*

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

- **`npm test`'s e2e suite is destructive against the working chart.** On
  2026-09-10 it left four indicators behind (EMA, RSI, ATR, MACD) and wedged
  symbol resolution chart-wide: `seriesErrorMessage() === 'resolve error'`, 0
  bars, every study at `status().type === 3`, with the UI showing "This symbol
  doesn't exist". `setSymbol`, `rerequestData()` and switching to a known-good
  symbol all failed to clear it; only an application restart recovered it.

  Policy deferred — noted here so the cost is known before anyone runs it again
  against a live reference chart.

## Standing constraints

- **No live order execution belongs in this bridge.** Orders route via alert
  webhook to a separate execution service against the cTrader API. Any code path
  that can place a live order is to be deleted, not disabled — removing the code
  is the guarantee, a flag is not.
- The TradingView session in use has a live IC Markets broker account attached.
  Treat any UI-reaching capability accordingly.

[upstream]: https://github.com/tradesdontlie/tradingview-mcp
