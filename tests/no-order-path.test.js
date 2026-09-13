/**
 * No tool in the workflow or diagnostic profile may reach an order-placing call.
 *
 * WHY THIS TEST EXISTS. `replay_trade` sat in the DEFAULT (workflow) profile
 * and called `replayApi.buy() / sell() / closePosition()`. It was inert only by
 * accident of this build: `replayApi.buy(e)` resolves to
 * `this._replayUIController.tradingUIController()?.activeModel()?.addOrder(...)`,
 * `updateModels()` took the `_initReplayBroker()` branch, `_tradingModelMap`
 * stayed empty, `activeModel()` returned null, and the optional chain swallowed
 * the call — so the tool answered `{ success: true }` having placed nothing. A
 * build that takes the legacy `_initTradingModels()` branch arms exactly the
 * same code. It was deleted on 2026-09-12 (Phase 0.5 task 1); this test is what
 * stops it, or anything like it, coming back unnoticed.
 *
 * TWO INDEPENDENT CHECKS, because either alone is easy to defeat:
 *
 *   1. NAME. `replay_trade` is registered by neither profile.
 *   2. REACHABILITY. Starting from the tool modules each profile registers,
 *      the import graph is walked transitively through `src/`, and every
 *      module reachable from it is scanned for order-emitting call text.
 *      A helper hidden three modules deep is still found.
 *
 * READS ARE NOT THE HAZARD. `position()`, `realizedPL()`, `orders()`,
 * `positions()` and `executions()` observe; they cannot move an account. Only
 * calls that SUBMIT, MODIFY or CANCEL are banned here.
 *
 * Order emission belongs to the (not yet built) `replay` profile behind the
 * broker interlock in recon/PHASE0-FINDINGS.md §5 — gated on
 * currentBroker() === "REPLAYBROKER" && isInReplay() && isReplayStarted() —
 * and to nothing else. If this test ever fails for that profile, the fix is to
 * add that profile to the allowlist deliberately, not to loosen the pattern.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  WORKFLOW_TOOL_NAMES,
  DIAGNOSTIC_TOOL_NAMES,
} from '../src/profiles.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * Call text that SUBMITS, MODIFIES or CANCELS an order, or moves a position.
 *
 * Matched as the literal call text `.<name>(` so a bare identifier or a field
 * of the same name does not trip it
 * — the point is a call SITE. Documented one per line so the reason each is
 * here survives the next person to read it. A comment naming one of these WILL
 * trip it, which is the conservative direction: say `place-order` in prose.
 */
const ORDER_CALLS = [
  'buy',                   // replayApi.buy()          — the deleted path
  'sell',                  // replayApi.sell()         — the deleted path
  'closePosition',         // replayApi/broker         — flattens a position
  'reversePosition',       // broker                   — flattens and re-opens
  'placeOrder',            // broker                   — the real submit
  'modifyOrder',           // broker
  'cancelOrder',           // broker
  'cancelOrders',          // broker
  'editPositionBrackets',  // broker                   — moves a live stop/target
  'addOrder',              // tradingUIController model — what buy() resolves to
  'selectBroker',          // tradingService           — changes order destination
];

/** Resolve a relative import to a file under src/, or null if it leaves src/. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [abs, `${abs}.js`, path.join(abs, 'index.js')]) {
    if (existsSync(cand) && cand.startsWith(SRC)) return cand;
  }
  return null;
}

/** Every module reachable from `entries` by static import, transitively. */
function reachable(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const next = resolveImport(file, m[1]);
      if (next) queue.push(next);
    }
  }
  return seen;
}

/** Order-call sites in one file, as `line: text` for a legible failure. */
function orderCallSites(file) {
  const hits = [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const name of ORDER_CALLS) {
      if (line.includes(`.${name}(`) || line.includes(`.${name} (`)) {
        hits.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      }
    }
  });
  return hits;
}

const PROFILE_ENTRIES = {
  workflow: ['profiles.js', 'server.js'],
  diagnostic: ['profiles.js', 'server-diag.js'],
};

describe('no order path in the shipped profiles', () => {
  it('replay_trade is registered by neither profile', () => {
    assert.ok(
      !WORKFLOW_TOOL_NAMES.includes('replay_trade'),
      'replay_trade is back in the workflow profile',
    );
    assert.ok(
      !DIAGNOSTIC_TOOL_NAMES.includes('replay_trade'),
      'replay_trade is back in the diagnostic profile',
    );
  });

  for (const [profile, entries] of Object.entries(PROFILE_ENTRIES)) {
    it(`${profile}: no module reachable from the profile emits an order`, () => {
      const files = reachable(entries.map((e) => path.join(SRC, e)));
      const hits = [...files].flatMap(orderCallSites);
      assert.deepEqual(
        hits,
        [],
        `order-emitting call sites reachable from the ${profile} profile:\n  ${hits.join('\n  ')}`,
      );
    });
  }

  it('the walk actually reaches the replay modules (guards a vacuous pass)', () => {
    const files = [...reachable([path.join(SRC, 'profiles.js')])].map((f) => path.relative(SRC, f));
    for (const expected of ['core/replay.js', 'tools/replay.js', 'internals/replay.js']) {
      assert.ok(
        files.includes(expected.split('/').join(path.sep)),
        `import walk did not reach ${expected} — the scan above proves nothing`,
      );
    }
  });
});
