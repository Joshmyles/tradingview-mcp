/**
 * Core drawing logic.
 */
import { evaluate as _evaluate, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';
import { observed, refused } from '../internals/verdict.js';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate, getChartApi: deps?.getChartApi || _getChartApi };
}

export async function drawShape({ shape, point, point2, overrides: overridesRaw, text, _deps }) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  const apiPath = await getChartApi();
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  const p1time = requireFinite(point.time, 'point.time');
  const p1price = requireFinite(point.price, 'point.price');

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);

  if (point2) {
    const p2time = requireFinite(point2.time, 'point2.time');
    const p2price = requireFinite(point2.price, 'point2.price');
    await evaluate(`
      ${apiPath}.createMultipointShape(
        [{ time: ${p1time}, price: ${p1price} }, { time: ${p2time}, price: ${p2price} }],
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  } else {
    await evaluate(`
      ${apiPath}.createShape(
        { time: ${p1time}, price: ${p1price} },
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  }

  await new Promise(r => setTimeout(r, 200));
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  const newId = (after || []).find(id => !(before || []).includes(id)) || null;
  // The before/after diff was already being computed; it just was not being
  // acted on, so a shape TradingView declined to create still read as created
  // with entity_id: null.
  if (!newId) {
    return refused(
      `no new shape appeared after createShape("${shape}") — the chart holds the same `
      + `${(after || []).length} shape(s) as before`,
      { shape, shapes_before: (before || []).length, shapes_after: (after || []).length },
    );
  }
  return observed({ entity_id: newId }, { shape });
}

export async function listDrawings() {
  const apiPath = await _getChartApi();
  const shapes = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) { return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

export async function removeOne({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var before = api.getAllShapes();
      var found = false;
      for (var i = 0; i < before.length; i++) { if (before[i].id === eid) { found = true; break; } }
      if (!found) return { removed: false, error: 'Shape not found: ' + eid, available: before.map(function(s) { return s.id; }) };
      api.removeEntity(eid);
      var after = api.getAllShapes();
      var stillExists = false;
      for (var j = 0; j < after.length; j++) { if (after[j].id === eid) { stillExists = true; break; } }
      return { removed: !stillExists, entity_id: eid, remaining_shapes: after.length };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  // `removed` was already computed from a post-removal re-read; success just
  // never consulted it.
  if (!result?.removed) {
    return refused(
      `shape "${entity_id}" is still present after removeEntity()`,
      { entity_id, remaining_shapes: result?.remaining_shapes },
    );
  }
  return observed(
    { removed_entity_id: entity_id, remaining_shapes: result.remaining_shapes },
    { entity_id },
  );
}

export async function clearAll() {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var before = api.getAllShapes().length;
      api.removeAllShapes();
      return { before: before, after: api.getAllShapes().length };
    })()
  `);
  // removeAllShapes() reports nothing. Locked or otherwise undeletable shapes
  // survive it, and this used to call that a clear.
  if (result?.after !== 0) {
    return refused(
      `${result?.after} shape(s) remain after removeAllShapes() (started with ${result?.before})`,
      { action: 'all_shapes_removed', shapes_before: result?.before, shapes_remaining: result?.after },
    );
  }
  return observed(
    { shapes_remaining: 0 },
    { action: 'all_shapes_removed', shapes_before: result.before },
  );
}
