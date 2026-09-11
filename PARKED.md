# Parked

Questions that surfaced while finishing the bridge and are either about the
STRATEGY, not the bridge, or are bridge work that is new scope. Recorded so
they are not lost and not worked on here. The bridge is frozen once its
definition of done holds; none of these reopen it.

- **G2 — acceptance bar restatement.** Replace the whole-book PF/Sharpe/WR bar with per-window measures (fraction of disjoint windows net-positive, median window PF, PF with top-3 winners removed per window, worst-window net).
- **G4 — configuration A/B across the eight windows.** All-off, +OPPX, +RVX, +PYRX over the same eight disjoint deep windows; characterisation, not selection.
- **G5 — concentration and its design implications.** Top-3 winners carry 51–88% of gross win per window at the intended config; what that means for build 15.
- **`in_42` session discrepancy.** Live `2000-2400` against the recorded champion `2000-1400`; left as found so G1 was not confounded.
- **The drawdown residual.** TradingView's max drawdown sits at ×1.40 below the intrabar envelope on the corrected book; daily sampling tested and refuted as the explanation.
- **Strategy properties `in_328`–`in_352`.** Commission 0.11/side, slippage 0, FIFO, pyramiding 10, risk-free rate 2, Bar Magnifier on — what they imply for how every backtest figure should be read.
- **What a Pine drawing's `x` indexes.** `loss_autopsy` ships with drawings as honest totals marked `joined: false`. The measured x range (1..867) matches neither the study bar index (0% of 504 priced on their bar) nor `mainSeries().bars()` (4% of 200, controls 0–0.2%). Identifying TradingView's primitive index space is internals work, not opened here; `src/internals/README.md`, "Pine drawing x is in neither known index space", has the probe table.
- **The saved Trial Ground layout carries `in_315 = true`.** The layout-persistence probe (2026-09-11) showed API input writes are never saved on their own and a reload restores the saved copy — which now holds `in_278` false, `in_315` true, `in_323` false. Correcting `in_315` means following the save-then-reload procedure in `manifests/README.md`; it was left as found.
- **Bulk rows to a file, not inline.** The response budget now defaults to 40,000 characters because Claude Code refuses any result over 25,000 tokens (measured: 59,539, 86,118 and 119,651 characters all refused; the bridge's pretty-printed JSON tokenises at about 2.3 characters a token). So a whole trade book, a whole input snapshot with defaults, or a long console page cannot reach the client inline at any setting; they are trimmed and the trim reported. The right design is to write the full rows to a file under the repository and return the path plus a summary, as the client itself does when it refuses a result. New scope; not opened. `TV_MAX_RESPONSE_CHARS=120000` remains the harness setting for reading whole books directly.
- **Live alert `5574059086` runs a drifted configuration.** Frozen at `pine_version 0.43` with OPPX/RVX/PYRX on. `preflight` reports it; recreating it is a live-execution decision for the owner.
