/**
 * Replay transport single-flight, and the wedge classifier.
 *
 * The wedge is expensive to reproduce on purpose — recovering from it costs a
 * chart reload — so the classifier is pure and is tested here against the state
 * that was actually MEASURED on 2026-09-12, rather than against a re-created one.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ReplayWedgeError,
  TransportBusyError,
  classifyHealth,
  currentOperation,
  withTransportLock,
  _resetTransportLock,
} from '../src/internals/replay-transport.js';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

describe('transport single-flight', () => {
  beforeEach(() => _resetTransportLock());

  it('serialises overlapping operations instead of interleaving them', async () => {
    const order = [];
    const op = (name, ms) => withTransportLock('step', async () => {
      order.push(`${name}:start`);
      await tick(ms);
      order.push(`${name}:end`);
      return name;
    });
    // Started together, on purpose: this is the shape the harness produced.
    const [a, b, c] = await Promise.all([op('a', 30), op('b', 5), op('c', 5)]);
    assert.deepEqual([a, b, c], ['a', 'b', 'c']);
    assert.deepEqual(order, [
      'a:start', 'a:end',
      'b:start', 'b:end',
      'c:start', 'c:end',
    ], 'operations overlapped — the lock is not serialising');
  });

  it('refuses a cursor move while a step is in flight', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const stepping = withTransportLock('step', () => gate);
    await tick(5);

    await assert.rejects(
      () => withTransportLock('select_date', async () => 'moved'),
      (err) => err instanceof TransportBusyError
        && /refusing to move the replay cursor/.test(err.message)
        && err.in_flight.op === 'step',
    );

    release('done');
    await stepping;
  });

  it('allows a cursor move once the step has finished', async () => {
    await withTransportLock('step', async () => 'stepped');
    const r = await withTransportLock('select_date', async () => 'moved');
    assert.equal(r, 'moved');
  });

  it('a hung operation surfaces as a NAMED wedge, not a generic stall', async () => {
    await assert.rejects(
      // A promise that never settles is exactly what doStep() returned.
      () => withTransportLock('step', () => new Promise(() => {}), { timeoutMs: 60 }),
      (err) => err instanceof ReplayWedgeError
        && err.wedged === true
        && err.op === 'step'
        && /WEDGED replay session/.test(err.message)
        && /reload the chart/.test(err.message),
    );
  });

  it('one failed operation does not poison the queue', async () => {
    const failing = withTransportLock('step', async () => { throw new Error('boom'); });
    await assert.rejects(() => failing, /boom/);
    const after = await withTransportLock('step', async () => 'still works');
    assert.equal(after, 'still works');
  });

  it('releases the in-flight marker even when the operation throws', async () => {
    await assert.rejects(() => withTransportLock('step', async () => { throw new Error('x'); }), /x/);
    assert.equal(currentOperation(), null);
  });
});

describe('wedge classification', () => {
  /** The reading taken from the wedged live session, 2026-09-12. */
  const WEDGED = {
    replay_api_present: true,
    is_replay_started: true,
    is_autoplay_started: false,
    current_date: 1788220799,
    session_id: 'rs_jPcM7PyZdRDj',
    session_state: 2,
    session_connected: true,
    symbol: 'ICMARKETS:XAUUSD',
    interval: '45S',
  };

  it('calls the measured wedged state wedged', () => {
    const r = classifyHealth(WEDGED, { advanced: false, settled: false, waited_ms: 12000 });
    assert.equal(r.state, 'wedged');
    assert.equal(r.wedged, true);
    assert.equal(r.armed, true);
    assert.match(r.why, /reload/);
  });

  it('does NOT call it healthy on the status flags alone', () => {
    // This is the whole point: every flag in WEDGED says the session is fine.
    // Without a probe the honest answer is "unknown", never "healthy".
    const r = classifyHealth(WEDGED);
    assert.equal(r.state, 'armed_unprobed');
    assert.equal(r.wedged, false);
    assert.match(r.why, /unknown/);
    assert.notEqual(r.state, 'healthy');
  });

  it('calls a session that advanced healthy', () => {
    const r = classifyHealth(WEDGED, { advanced: true, settled: true, waited_ms: 500 });
    assert.equal(r.state, 'healthy');
    assert.equal(r.wedged, false);
  });

  it('separates "settled but did not move" from "never settled"', () => {
    // Both are unusable sessions, and they have different causes, so they get
    // different names rather than one shared "failed".
    const stalled = classifyHealth(WEDGED, { advanced: false, settled: true, waited_ms: 9000 });
    assert.equal(stalled.state, 'stalled');
    assert.equal(stalled.wedged, true);
    const wedged = classifyHealth(WEDGED, { advanced: false, settled: false, waited_ms: 9000 });
    assert.equal(wedged.state, 'wedged');
  });

  it('reports a non-replay chart as not started rather than as broken', () => {
    const r = classifyHealth({ replay_api_present: true, is_replay_started: false });
    assert.equal(r.state, 'not_started');
    assert.equal(r.armed, false);
    assert.equal(r.wedged, false);
  });

  it('reports a missing replay API distinctly', () => {
    const r = classifyHealth({ replay_api_present: false });
    assert.equal(r.state, 'no_replay_api');
    assert.equal(r.wedged, false);
  });
});

describe('health() result shape', () => {
  beforeEach(() => _resetTransportLock());

  it('REGRESSION: the raw reading must not overwrite the classification', async () => {
    // Caught live 2026-09-12: health() spread the verdict and THEN assigned the
    // raw reading under `state`, so `state` came back as the reading object
    // instead of 'armed_unprobed'. Same shape as the pine_inputs_assert defect,
    // written while fixing that one. The reading now lives under `reading`.
    const { health } = await import('../src/core/replay.js');
    const reading = {
      replay_api_present: true,
      is_replay_started: true,
      current_date: 1788221234,
      session_state: 2,
      session_connected: true,
    };
    const r = await health({
      probe: false,
      _deps: {
        evaluate: async () => JSON.stringify(reading),
        getReplayApi: async () => 'RP',
      },
    });
    assert.equal(typeof r.state, 'string', 'state must be the classification, not the reading object');
    assert.equal(r.state, 'armed_unprobed');
    assert.equal(r.armed, true);
    assert.equal(r.reading.current_date, 1788221234, 'the raw reading belongs under `reading`');
  });
});
