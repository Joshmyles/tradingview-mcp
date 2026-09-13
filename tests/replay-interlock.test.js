/**
 * The §2.4 broker interlock, and the naming trap it must never be built on.
 *
 * THE TRAP. `tradingUIController()._isConnectedToBroker` reads like the signal
 * to refuse on — "a broker is connected, bail out" — and means the opposite:
 * connected to the REPLAY broker. Measured live 2026-09-12 with the Replay
 * Trading panel open and `currentBroker()` reading "REPLAYBROKER", it was
 * `true`. A guard written on it would refuse in exactly the state the harness
 * is meant to run in, and arm in the state where the replay broker is absent —
 * i.e. it would route orders at a real account. A comment cannot stop that
 * being written; this file can, so the first test below asserts the flag has no
 * influence on the decision AT ALL, in either direction.
 *
 * Pure: `evaluateInterlock` takes an already-read state, so no chart is needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertReplayBrokerInterlock,
  evaluateInterlock,
  InterlockError,
  REQUIRED_BROKER_ID,
  FORBIDDEN_BROKER_IDS,
} from '../src/core/replay-interlock.js';

/** The state as measured live on an armed replay session, 2026-09-12. */
function armedState(over = {}) {
  return {
    ok: true,
    is_in_replay: true,
    has_active_broker: true,
    current_broker: 'REPLAYBROKER',
    connection_status: 1,
    account: 'primary',
    account_type: 'demo',
    is_replay_started: true,
    replay_cursor_sec: 1788220799,
    naming_trap_do_not_use: true,
    ...over,
  };
}

describe('the naming trap must not influence the decision', () => {
  for (const trap of [true, false, null, undefined]) {
    it(`arms on a good state whatever _isConnectedToBroker reads (${String(trap)})`, () => {
      const r = evaluateInterlock(armedState({ naming_trap_do_not_use: trap }));
      assert.equal(r.armed, true, r.reasons.join('; '));
    });

    it(`refuses a Paper destination whatever _isConnectedToBroker reads (${String(trap)})`, () => {
      const r = evaluateInterlock(armedState({
        current_broker: FORBIDDEN_BROKER_IDS.Paper,
        naming_trap_do_not_use: trap,
      }));
      assert.equal(r.armed, false);
      assert.match(r.reasons.join('; '), /Paper/);
    });
  }

  it('the guard source never reads the trap field to decide', async () => {
    // Belt and braces: the decision is driven by the three allowlist clauses,
    // so a state carrying ONLY the trap (and nothing else) must refuse.
    const r = evaluateInterlock({ ok: true, naming_trap_do_not_use: true });
    assert.equal(r.armed, false);
    assert.equal(r.reasons.length, 3, r.reasons.join('; '));
  });
});

describe('interlock allowlist', () => {
  it('arms only on REPLAYBROKER + isInReplay + isReplayStarted', () => {
    assert.equal(evaluateInterlock(armedState()).armed, true);
  });

  it('refuses each forbidden broker id by name', () => {
    for (const [label, id] of Object.entries(FORBIDDEN_BROKER_IDS)) {
      const r = evaluateInterlock(armedState({ current_broker: id }));
      assert.equal(r.armed, false, `${label} armed the interlock`);
      assert.match(r.reasons.join('; '), new RegExp(label));
    }
  });

  it('refuses an unknown broker id — allowlist, not denylist', () => {
    // The session lists 137 brokers. A denylist fails open on the 138th.
    const r = evaluateInterlock(armedState({ current_broker: 'ICMARKETS' }));
    assert.equal(r.armed, false);
    assert.match(r.reasons.join('; '), /"ICMARKETS".*not "REPLAYBROKER"/);
  });

  it('refuses when the broker cannot be read at all', () => {
    const r = evaluateInterlock(armedState({ current_broker: null }));
    assert.equal(r.armed, false);
    assert.match(r.reasons.join('; '), /unreadable/);
  });

  it('refuses REPLAYBROKER that is not actually in replay', () => {
    const r = evaluateInterlock(armedState({ is_in_replay: false }));
    assert.equal(r.armed, false);
    assert.match(r.reasons.join('; '), /isInReplay/);
  });

  it('refuses REPLAYBROKER in replay whose session has not started', () => {
    const r = evaluateInterlock(armedState({ is_replay_started: false }));
    assert.equal(r.armed, false);
    assert.match(r.reasons.join('; '), /isReplayStarted/);
  });

  it('refuses when the state could not be read', () => {
    const r = evaluateInterlock({ ok: false, error: 'tradingService() unreachable' });
    assert.equal(r.armed, false);
    assert.match(r.reasons.join('; '), /tradingService\(\) unreachable/);
  });

  it('refuses on a missing state rather than treating absent as fine', () => {
    assert.equal(evaluateInterlock(undefined).armed, false);
    assert.equal(evaluateInterlock(null).armed, false);
  });
});

describe('assertReplayBrokerInterlock', () => {
  it('returns the armed destination on a good state', async () => {
    const r = await assertReplayBrokerInterlock({ _deps: { evaluate: async () => armedState() } });
    assert.equal(r.armed, true);
    assert.equal(r.broker, REQUIRED_BROKER_ID);
    assert.equal(r.account_type, 'demo');
  });

  it('throws InterlockError naming the destination it refused', async () => {
    await assert.rejects(
      () => assertReplayBrokerInterlock({
        _deps: { evaluate: async () => armedState({ current_broker: 'Paper' }) },
      }),
      (err) => err instanceof InterlockError
        && /REFUSING TO ARM/.test(err.message)
        && /Paper/.test(err.message)
        && err.state.current_broker === 'Paper',
    );
  });

  it('a page that throws is a refusal, not a pass', async () => {
    await assert.rejects(
      () => assertReplayBrokerInterlock({
        _deps: { evaluate: async () => { throw new Error('CDP target gone'); } },
      }),
      (err) => err instanceof InterlockError && /CDP target gone/.test(err.message),
    );
  });
});
