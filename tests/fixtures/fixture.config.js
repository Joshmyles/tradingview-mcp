/**
 * The fixture layout the destructive suites are allowed to touch.
 *
 * These values are the contract between the committed fixture (see
 * tests/fixtures/README.md) and the guard that enforces it. Change them here
 * and nowhere else.
 */
export const FIXTURE = {
  /** Exact TradingView layout name. The guard compares against this. */
  layoutName: 'MCP-FIXTURE',
  /** What the fixture layout is set up with. */
  symbol: 'ICMARKETS:XAUUSD',
  timeframe: '5',
  /** Title of the fixture strategy, as it appears on the chart. */
  studyTitle: 'MCP Fixture Strategy',
  /** Committed source for that strategy. */
  pineFile: 'tests/fixtures/fixture-strategy.pine',
};

/**
 * Layouts the suites must never run against.
 *
 * Belt and braces alongside the positive name check: if the fixture is ever
 * renamed to something that collides, this still refuses the working chart.
 * "Trial Ground" is the live research layout carrying the build lineage.
 */
export const FORBIDDEN_LAYOUT_NAMES = ['Trial Ground'];

/** Suites run only when this is set, and only against the fixture layout. */
export const ENV_GATE = 'TV_MCP_ALLOW_DESTRUCTIVE';
