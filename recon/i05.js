/**
 * Phase 0.6 Task 2 — verify the replay session is genuinely unwedged.
 *
 * Deliberately sequential and unhurried: ONE selectDate, then steps one at a
 * time, each waiting for the previous to be observed. The wedge followed ~15
 * rapid selectDate calls, so nothing here goes fast.
 */
import { start, step, autoplay, status } from '../src/core/replay.js';
import { evaluate } from '../src/connection.js';

const out = { at: new Date().toISOString(), steps: [] };

function log(label, v) {
  console.error(`[${label}] ${JSON.stringify(v)}`);
}

try {
  // ---- 1. one start, on a date Phase 0.5 confirmed serves bars
  const started = await start({ date: '2026-09-01' });
  out.start = started;
  log('start', started);

  // ---- 2. three sequential steps; each must move the cursor
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const r = await step({ timeoutMs: 20000 });
      out.steps.push({ i, ok: true, ...r, wall_ms: Date.now() - t0 });
      log(`step${i}`, r);
    } catch (err) {
      out.steps.push({ i, ok: false, error: err.message, wall_ms: Date.now() - t0 });
      log(`step${i} FAILED`, err.message);
      break;
    }
  }

  // ---- 3. autoplay: does the cursor move on its own?
  const beforeAuto = await evaluate(
    '(function(){var v=window.TradingViewApi._replayApi.currentDate();'
    + 'return (v&&typeof v.value==="function")?v.value():v;})()',
  );
  const ap = await autoplay({ speed: 1000 });
  log('autoplay-on', ap);
  await new Promise((r) => setTimeout(r, 6000));
  const afterAuto = await evaluate(
    '(function(){var v=window.TradingViewApi._replayApi.currentDate();'
    + 'return (v&&typeof v.value==="function")?v.value():v;})()',
  );
  const apOff = await autoplay({ speed: 0 });
  log('autoplay-off', apOff);
  out.autoplay = {
    before: beforeAuto,
    after: afterAuto,
    advanced: afterAuto !== beforeAuto,
    delta_sec: (Number(afterAuto) - Number(beforeAuto)) || null,
    toggle_on: ap,
    toggle_off: apOff,
  };
  log('autoplay', out.autoplay);

  out.status = await status();
  out.ok = true;
} catch (err) {
  out.ok = false;
  out.error = err.message;
  log('FATAL', err.message);
}

console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
