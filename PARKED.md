# Parked

Questions that surfaced while finishing the bridge and are about the STRATEGY,
not the bridge. Recorded so they are not lost and not worked on here. The
bridge is frozen once its definition of done holds; none of these reopen it.

- **G2 — acceptance bar restatement.** Replace the whole-book PF/Sharpe/WR bar with per-window measures (fraction of disjoint windows net-positive, median window PF, PF with top-3 winners removed per window, worst-window net).
- **G4 — configuration A/B across the eight windows.** All-off, +OPPX, +RVX, +PYRX over the same eight disjoint deep windows; characterisation, not selection.
- **G5 — concentration and its design implications.** Top-3 winners carry 51–88% of gross win per window at the intended config; what that means for build 15.
- **`in_42` session discrepancy.** Live `2000-2400` against the recorded champion `2000-1400`; left as found so G1 was not confounded.
- **The drawdown residual.** TradingView's max drawdown sits at ×1.40 below the intrabar envelope on the corrected book; daily sampling tested and refuted as the explanation.
- **Strategy properties `in_328`–`in_352`.** Commission 0.11/side, slippage 0, FIFO, pyramiding 10, risk-free rate 2, Bar Magnifier on — what they imply for how every backtest figure should be read.
- **Live alert `5574059086` runs a drifted configuration.** Frozen at `pine_version 0.43` with OPPX/RVX/PYRX on. `preflight` reports it; recreating it is a live-execution decision for the owner.
