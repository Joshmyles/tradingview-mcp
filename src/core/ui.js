/**
 * Core UI automation logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import { observed, refused, unobservable } from '../internals/verdict.js';

export async function click({ by, value }) {
  const escaped = JSON.stringify(value);
  const result = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${escaped};
      var el = null;
      if (by === 'aria-label') el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"]');
        for (var i = 0; i < candidates.length; i++) {
          var text = candidates[i].textContent.trim();
          if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; }
        }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return { found: false };
      el.click();
      return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80), aria_label: el.getAttribute('aria-label') || null, data_name: el.getAttribute('data-name') || null };
    })()
  `);
  if (!result || !result.found) throw new Error('No matching element found for ' + by + '="' + value + '"');
  // The element was located, which IS observed; its reaction is not.
  return unobservable(
    'the element was found and clicked; the effect of the click is not read back.',
    { clicked: result },
  );
}

export async function openPanel({ panel, action }) {
  const isBottomPanel = panel === 'pine-editor' || panel === 'strategy-tester';
  if (isBottomPanel) {
    const widgetName = panel === 'pine-editor' ? 'pine-editor' : 'backtesting';
    const result = await evaluate(`
      (function() {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (!bwb) return { error: 'bottomWidgetBar not available' };
        var panel = ${JSON.stringify(panel)};
        var widgetName = ${JSON.stringify(widgetName)};
        var action = ${JSON.stringify(action)};
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
        var isOpen = !!(bottomArea && bottomArea.offsetHeight > 50);
        if (panel === 'pine-editor') { var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco'); isOpen = isOpen && !!monacoEl; }
        if (panel === 'strategy-tester') { var stratPanel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]'); isOpen = isOpen && !!(stratPanel && stratPanel.offsetParent); }
        var performed = 'none';
        if (action === 'open' || (action === 'toggle' && !isOpen)) {
          if (panel === 'pine-editor') { if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab(); else if (typeof bwb.showWidget === 'function') bwb.showWidget(widgetName); }
          else { if (typeof bwb.showWidget === 'function') bwb.showWidget(widgetName); }
          performed = 'opened';
        } else if (action === 'close' || (action === 'toggle' && isOpen)) {
          // hideWidget(name) was removed in newer TradingView builds; fall back to
          // close() (minimizes the bottom panel) and then hide() (hides the bar).
          if (typeof bwb.hideWidget === 'function') bwb.hideWidget(widgetName);
          else if (typeof bwb.close === 'function') bwb.close();
          else if (typeof bwb.hide === 'function') bwb.hide();
          performed = 'closed';
        }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    // `performed` is what the code DECIDED to do, not what happened. Re-read.
    await new Promise((r) => setTimeout(r, 300));
    const nowOpen = await evaluate(`
      (function() {
        try {
          var bwb = window.TradingView.bottomWidgetBar;
          return !!(bwb && typeof bwb.isVisible === 'function' ? bwb.isVisible() : null);
        } catch (e) { return null; }
      })()
    `);
    return panelVerdict({ panel, action, wasOpen: result?.was_open ?? false, performed: result?.performed ?? 'unknown', nowOpen });
  } else {
    // Newer TV builds renamed the right-rail buttons (watchlist is now
    // data-name="base", aria "Watchlist, details, and news"; alerts is
    // data-name="alerts") — keep legacy selectors as fallbacks.
    const selectorMap = {
      'watchlist': { dataNames: ['base-watchlist-widget-button', 'base'], ariaLabels: ['Watchlist', 'Watchlist, details, and news'] },
      'alerts': { dataNames: ['alerts-button', 'alerts'], ariaLabels: ['Alerts'] },
    };
    const sel = selectorMap[panel];
    // DELETED, not disabled: the 'trading' target opened the order panel of a
    // connected live broker account. There is no flag here to turn back on.
    // Orders leave this system by alert webhook to a separate execution
    // service; nothing in this bridge may reach a broker. See PROVENANCE.md.
    if (!sel) throw new Error(`Unknown panel: ${panel}`);
    const result = await evaluate(`
      (function() {
        var dataNames = ${JSON.stringify(sel.dataNames)};
        var ariaLabels = ${JSON.stringify(sel.ariaLabels)};
        var action = ${JSON.stringify(action)};
        var btn = null;
        for (var d = 0; d < dataNames.length && !btn; d++) btn = document.querySelector('[data-name="' + dataNames[d] + '"]');
        for (var a = 0; a < ariaLabels.length && !btn; a++) btn = document.querySelector('[aria-label="' + ariaLabels[a] + '"]');
        if (!btn) return { error: 'Button not found for panel: ' + ${JSON.stringify(panel)} };
        var isActive = btn.getAttribute('aria-pressed') === 'true' || btn.classList.contains('isActive') || btn.classList.toString().indexOf('active') !== -1 || btn.classList.toString().indexOf('Active') !== -1;
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        var sidebarOpen = !!(rightArea && rightArea.offsetWidth > 50);
        var isOpen = isActive && sidebarOpen;
        var performed = 'none';
        if (action === 'open' && !isOpen) { btn.click(); performed = 'opened'; }
        else if (action === 'close' && isOpen) { btn.click(); performed = 'closed'; }
        else if (action === 'toggle') { btn.click(); performed = isOpen ? 'closed' : 'opened'; }
        else { performed = isOpen ? 'already_open' : 'already_closed'; }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    await new Promise((r) => setTimeout(r, 300));
    const nowOpen = await evaluate(`
      (function() {
        try {
          var rightArea = document.querySelector('[class*="layout__area--right"]');
          return !!(rightArea && rightArea.offsetWidth > 50);
        } catch (e) { return null; }
      })()
    `);
    return panelVerdict({ panel, action, wasOpen: result?.was_open ?? false, performed: result?.performed ?? 'unknown', nowOpen });
  }
}

/**
 * Turn an observed open/closed reading into a verdict.
 *
 * 'toggle' has no single correct end state, so it is reported as observed
 * whatever it reads; 'open' and 'close' name the state they must reach.
 */
function panelVerdict({ panel, action, wasOpen, performed, nowOpen }) {
  const detail = { panel, action, was_open: wasOpen, performed };
  if (nowOpen === null || nowOpen === undefined) {
    return unobservable('the panel container could not be read back after the click', detail);
  }
  if (action === 'open' && !nowOpen) return refused(`panel "${panel}" is still closed after action "open"`, { ...detail, is_open: nowOpen });
  if (action === 'close' && nowOpen) return refused(`panel "${panel}" is still open after action "close"`, { ...detail, is_open: nowOpen });
  return observed({ is_open: nowOpen }, detail);
}

export async function fullscreen() {
  const result = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="header-toolbar-fullscreen"]');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!result || !result.found) throw new Error('Fullscreen button not found');
  return unobservable(
    'the fullscreen button was found and clicked; the resulting window state is '
    + 'not read back.',
    { action: 'fullscreen_toggled' },
  );
}

export async function layoutList() {
  const layouts = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts returned no data'}); return; }
          var result = charts.map(function(c) { return { id: c.id || c.chartId || null, name: c.name || c.title || 'Untitled', symbol: c.symbol || null, resolution: c.resolution || null, modified: c.timestamp || c.modified || null }; });
          resolve({layouts: result, source: 'internal_api'});
        });
        setTimeout(function() { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts timed out'}); }, 5000);
      } catch(e) { resolve({layouts: [], source: 'internal_api', error: e.message}); }
    })
  `);
  return { success: true, layout_count: layouts?.layouts?.length || 0, source: layouts?.source, layouts: layouts?.layouts || [], error: layouts?.error };
}

export async function layoutSwitch({ name }) {
  const escaped = JSON.stringify(name);
  const result = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        var target = ${escaped};
        if (/^\\d+$/.test(target)) { window.TradingViewApi.loadChartFromServer(target); resolve({success: true, method: 'loadChartFromServer', id: target, source: 'internal_api'}); return; }
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({success: false, error: 'getSavedCharts returned no data', source: 'internal_api'}); return; }
          var match = null;
          for (var i = 0; i < charts.length; i++) { var cname = charts[i].name || charts[i].title || ''; if (cname === target || cname.toLowerCase() === target.toLowerCase()) { match = charts[i]; break; } }
          if (!match) { for (var j = 0; j < charts.length; j++) { var cn = (charts[j].name || charts[j].title || '').toLowerCase(); if (cn.indexOf(target.toLowerCase()) !== -1) { match = charts[j]; break; } } }
          if (!match) { resolve({success: false, error: 'Layout "' + target + '" not found.', source: 'internal_api'}); return; }
          var chartId = match.id || match.chartId;
          window.TradingViewApi.loadChartFromServer(chartId);
          resolve({success: true, method: 'loadChartFromServer', id: chartId, name: match.name || match.title, source: 'internal_api'});
        });
        setTimeout(function() { resolve({success: false, error: 'getSavedCharts timed out', source: 'internal_api'}); }, 5000);
      } catch(e) { resolve({success: false, error: e.message, source: 'internal_api'}); }
    })
  `);
  if (!result?.success) throw new Error(result?.error || 'Unknown error switching layout');

  // Handle "unsaved changes" confirmation dialog
  await new Promise(r => setTimeout(r, 500));
  const dismissed = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/open anyway|don't save|discard/i.test(text)) {
          btns[i].click();
          return true;
        }
      }
      return false;
    })()
  `);

  if (dismissed) await new Promise(r => setTimeout(r, 1000));

  // loadChartFromServer() returns immediately; the load happens afterwards. The
  // old code reported action:'switched' at this point regardless, so a failed or
  // still-pending load read as a completed switch. Poll for the id to land.
  let actualId = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    actualId = await evaluate(`
      (function() {
        try {
          var svc = window.TradingViewApi._saveChartService;
          var v = svc && svc.layoutId();
          return (v && typeof v.value === 'function') ? v.value() : (v || null);
        } catch (e) { return null; }
      })()
    `);
    if (actualId && String(actualId) === String(result.id)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const detail = { layout: result.name || name, layout_id: result.id, source: result.source, unsaved_dialog_dismissed: dismissed };
  if (!actualId) {
    return unobservable('the active layout id could not be read back after the switch', detail);
  }
  if (String(actualId) !== String(result.id)) {
    return refused(
      `the active layout is "${actualId}" after switching to "${result.id}" — the load did not complete within 15s`,
      { ...detail, active_layout_id: String(actualId) },
    );
  }
  return observed({ active_layout_id: String(actualId) }, { ...detail, action: 'switched' });
}

export async function keyboard({ key, modifiers }) {
  const c = await getClient();
  let mod = 0;
  if (modifiers) {
    if (modifiers.includes('alt')) mod |= 1;
    if (modifiers.includes('ctrl')) mod |= 2;
    if (modifiers.includes('meta')) mod |= 4;
    if (modifiers.includes('shift')) mod |= 8;
  }
  const keyMap = {
    'Enter': { code: 'Enter', vk: 13 }, 'Escape': { code: 'Escape', vk: 27 }, 'Tab': { code: 'Tab', vk: 9 },
    'Backspace': { code: 'Backspace', vk: 8 }, 'Delete': { code: 'Delete', vk: 46 },
    'ArrowUp': { code: 'ArrowUp', vk: 38 }, 'ArrowDown': { code: 'ArrowDown', vk: 40 },
    'ArrowLeft': { code: 'ArrowLeft', vk: 37 }, 'ArrowRight': { code: 'ArrowRight', vk: 39 },
    'Space': { code: 'Space', vk: 32 }, 'Home': { code: 'Home', vk: 36 }, 'End': { code: 'End', vk: 35 },
    'PageUp': { code: 'PageUp', vk: 33 }, 'PageDown': { code: 'PageDown', vk: 34 },
    'F1': { code: 'F1', vk: 112 }, 'F2': { code: 'F2', vk: 113 }, 'F5': { code: 'F5', vk: 116 },
  };
  const mapped = keyMap[key] || { code: 'Key' + key.toUpperCase(), vk: key.toUpperCase().charCodeAt(0) };
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: mod, key, code: mapped.code, windowsVirtualKeyCode: mapped.vk });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key, code: mapped.code });
  return unobservable(
    'the key event was dispatched to the page; what the page did with it is not '
    + 'visible from here. Confirm the intended effect with a read.',
    { key, modifiers: modifiers || [] },
  );
}

export async function typeText({ text }) {
  const c = await getClient();
  await c.Input.insertText({ text });
  return unobservable(
    'the text was inserted into whatever holds focus; this call does not know '
    + 'what that was or whether it accepted the text.',
    { typed: text.substring(0, 100), length: text.length },
  );
}

export async function hover({ by, value }) {
  const coords = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${JSON.stringify(value)};
      var el = null;
      if (by === 'aria-label') {
        el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
        if (!el) el = document.querySelector('[aria-label*="' + value.replace(/"/g, '\\\\"') + '"]');
      }
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], span, div');
        for (var i = 0; i < candidates.length; i++) { var text = candidates[i].textContent.trim(); if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; } }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName.toLowerCase() };
    })()
  `);
  if (!coords) throw new Error('Element not found for ' + by + '="' + value + '"');
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: coords.x, y: coords.y });
  return unobservable(
    'the element was located and the pointer moved onto it; whether a hover state '
    + 'or tooltip resulted is not readable from here.',
    { hovered: { by, value, tag: coords.tag, x: coords.x, y: coords.y } },
  );
}

export async function scroll({ direction, amount }) {
  const c = await getClient();
  const px = amount || 300;
  const center = await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="pane-canvas"]') || document.querySelector('[class*="chart-container"]') || document.querySelector('canvas');
      if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  let deltaX = 0, deltaY = 0;
  if (direction === 'up') deltaY = -px; else if (direction === 'down') deltaY = px;
  else if (direction === 'left') deltaX = -px; else if (direction === 'right') deltaX = px;
  await c.Input.dispatchMouseEvent({ type: 'mouseWheel', x: center.x, y: center.y, deltaX, deltaY });
  return unobservable(
    'the wheel event was dispatched; this call does not read the resulting scroll '
    + 'position, and the chart may have consumed it as a zoom instead.',
    { direction, amount: px },
  );
}

export async function mouseClick({ x, y, button, double_click }) {
  const c = await getClient();
  const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
  const btnNum = btn === 'right' ? 2 : btn === 'middle' ? 1 : 0;
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  if (double_click) {
    await new Promise(r => setTimeout(r, 50));
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 2 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  }
  return unobservable(
    'the click was dispatched at these coordinates; what sits there and how it '
    + 'responded is not visible from here.',
    { x, y, button: btn, double_click: !!double_click },
  );
}

export async function findElement({ query, strategy }) {
  const strat = strategy || 'text';
  const results = await evaluate(`
    (function() {
      var query = ${JSON.stringify(query)};
      var strategy = ${JSON.stringify(strat)};
      var results = [];
      if (strategy === 'css') {
        var els = document.querySelectorAll(query);
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else if (strategy === 'aria-label') {
        var els = document.querySelectorAll('[aria-label*="' + query.replace(/"/g, '\\\\"') + '"]');
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else {
        var all = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], input, select, label, span, div, h1, h2, h3, h4');
        for (var i = 0; i < all.length; i++) {
          var text = all[i].textContent.trim();
          if (text.toLowerCase().indexOf(query.toLowerCase()) !== -1 && text.length < 200) {
            var rect = all[i].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              results.push({ tag: all[i].tagName.toLowerCase(), text: text.substring(0, 80), aria_label: all[i].getAttribute('aria-label') || null, data_name: all[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: all[i].offsetParent !== null });
              if (results.length >= 20) break;
            }
          }
        }
      }
      return results;
    })()
  `);
  return { success: true, query, strategy: strat, count: results?.length || 0, elements: results || [] };
}

export async function uiEvaluate({ expression }) {
  // awaitPromise: an expression evaluating to a Promise previously returned the
  // Promise object itself, which serialises as {} — so every async probe
  // reported success with an empty result and no error. Awaiting it means a
  // rejection surfaces as a thrown error rather than as a silent blank.
  const result = await evaluateAsync(expression);
  return { success: true, result };
}
