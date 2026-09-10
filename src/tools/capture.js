import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart. Waits for the chart to finish loading first — a half-drawn chart photographs exactly like a finished one, so an unwaited screenshot is unusable as evidence. Pass wait=false only when the loading state is itself what you want to see.', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    wait_for_render: z.boolean().optional().describe('Additionally wait for the chart canvas to stop changing. Separate from the data wait: the chart can be settled and still a frame or two from being painted.'),
    wait: z.coerce.boolean().optional().describe('Default true: wait for the chart to finish recomputing before capturing. Set false to photograph the loading state deliberately.'),
  }, async ({ region, filename, method, wait_for_render, wait }) => {
    try { return jsonResult(await core.captureScreenshot({ region, filename, method, waitForRender: wait_for_render, wait })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
