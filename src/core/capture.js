/**
 * Core screenshot/capture logic.
 */
import { getClient, evaluate, getChartCollection } from '../connection.js';
import { waitForChartRender } from '../wait.js';
import { requireSettled } from '../settle.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

/**
 * A screenshot of a loading chart is worthless, and worse than worthless if it
 * is read as evidence — a half-drawn chart photographs exactly like a finished
 * one. So this settles by DEFAULT, unlike other reads where the caller opts in.
 *
 * `wait: false` is the escape for the case where the loading state is itself
 * what you want to see (diagnosing a stuck chart, for instance). It marks the
 * result rather than silently producing an undated image.
 */
export async function captureScreenshot({ region, filename, method, waitForRender = false, wait = true } = {}) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  let settle = null;
  if (wait !== false) {
    const gate = await requireSettled({ scope: 'all', requireSeries: true });
    if (!gate.ok) return gate;
    settle = gate.settle;
  }

  // Canvas-stabilisation is a separate, weaker concern: the chart can be
  // settled in data terms and still be a frame or two from being painted.
  if (waitForRender) await waitForChartRender();

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = (filename || `tv_${region || 'full'}_${ts}`).replace(/[\/\\]/g, '_').replace(/\.\./g, '_');
  const filePath = join(SCREENSHOT_DIR, `${fname}.png`);

  if (method === 'api') {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      return {
        success: true, method: 'api', waited_for_render: !!waitForRender,
        settled: wait !== false,
        ...(settle && { settle_ms: settle.elapsed_ms }),
        note: 'takeScreenshot() triggered — TradingView will save/show the screenshot via its own UI',
      };
    } catch {
      // Fall through to CDP method
    }
  }

  const client = await getClient();
  let clip = undefined;

  if (region === 'chart') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('[class*="chart-container"]')
          || document.querySelector('canvas');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  } else if (region === 'strategy_tester') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  }

  const params = { format: 'png' };
  if (clip) params.clip = clip;

  const { data } = await client.Page.captureScreenshot(params);
  writeFileSync(filePath, Buffer.from(data, 'base64'));

  return {
    success: true, method: 'cdp', file_path: filePath, region,
    waited_for_render: !!waitForRender,
    settled: wait !== false,
    ...(settle && { settle_ms: settle.elapsed_ms }),
    ...(wait === false && {
      note: 'wait=false: captured without waiting for the chart to settle. The image may show a loading chart.',
    }),
    size_bytes: Buffer.from(data, 'base64').length,
  };
}
