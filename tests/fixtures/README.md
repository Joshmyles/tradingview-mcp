# Test fixture layout

The e2e and smoke suites are **destructive**. They add and remove studies,
change the symbol and the resolution, and drive the UI. They must never be
pointed at a layout anyone cares about.

## Why this exists

On 2026-09-10 the e2e suite was run against the live research layout. It left
four indicators behind (EMA, RSI, ATR, MACD) and wedged symbol resolution
chart-wide: `seriesErrorMessage() === 'resolve error'`, zero bars, every study
in error, and the UI showing "This symbol doesn't exist". `setSymbol`,
`rerequestData()` and switching to a known-good symbol all failed to clear it.
Only restarting the application recovered it.

Nothing about that run was unusual. The suite did what it says it does; there
was simply nothing stopping it doing so to the wrong chart.

## One-time setup

The layout has to be created by hand, once, in the TradingView UI. It is not
created by the test run: a harness that provisions its own target on a live
account can provision it in the wrong place, which is the failure being
prevented.

1. In TradingView Desktop, create a new layout and name it **exactly**
   `MCP-FIXTURE`. The guard compares the name character for character.
2. Set it to `ICMARKETS:XAUUSD`, 5-minute.
3. Open the Pine editor, paste [`fixture-strategy.pine`](fixture-strategy.pine),
   save it as **MCP Fixture Strategy**, and add it to the chart.
4. Open the Strategy Tester once, so a report exists.
5. Save the layout.

Keep nothing else on it. Its contents are expected to be churned.

## Running

Both conditions are required, and neither has a default:

```sh
# switch TradingView to the MCP-FIXTURE layout first, then:
TV_MCP_ALLOW_DESTRUCTIVE=1 npm run test:e2e
TV_MCP_ALLOW_DESTRUCTIVE=1 npm run test:smoke
```

`npm test` runs neither. It runs the unit suites, which use no live chart.

The smoke suite also spawns both server entry points (`src/server.js`,
`src/server-diag.js`) over stdio and checks that `tools/list` returns every
tool of each profile. That part needs no fixture and no environment variable,
but it is in the smoke suite on purpose: "smoke is green" has to mean the
server a client connects to actually exposes its tools. It once exposed none
for days while the unit suite stayed green.

## What the guard checks

[`tests/_fixture-guard.js`](../_fixture-guard.js) refuses to proceed unless all
three hold:

| check | why |
| --- | --- |
| `TV_MCP_ALLOW_DESTRUCTIVE=1` | absent means no; there is no default that runs |
| the attached page is `document.visibilityState === 'visible'` | TradingView Desktop runs hidden preview renderers that answer every API call plausibly, so "which chart am I about to modify" has a wrong answer available — see `src/internals/targets.js` |
| layout name is `MCP-FIXTURE`, and not on the forbidden list | the positive check names the fixture; the forbidden list names the live research layout explicitly, so a rename cannot collide into it |

Every failure throws with the layout it found. A destructive suite that skips
quietly and reports success is the same lie in the other direction.
