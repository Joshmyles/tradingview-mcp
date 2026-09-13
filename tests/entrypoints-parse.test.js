/**
 * Every source file must parse, including the server entry points.
 *
 * WHY THIS TEST EXISTS. The unit suite imports core modules but never loads
 * src/server.js, which runs startServer() at top level. On 2026-09-12 a
 * backtick inside that file's extraNotes template literal ended the literal
 * early; the suite passed 382/382 while the MCP server could not start at all
 * ("Connection closed"). `node --check` parses without executing, so it covers
 * files that cannot safely be imported under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

test('every src/**/*.js file parses (node --check)', () => {
  const files = walk(SRC);
  assert.ok(files.some((f) => f.endsWith('server.js')), 'scan must include src/server.js');
  const failures = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (err) {
      failures.push(`${f}\n${String(err.stderr).split('\n').slice(0, 4).join('\n')}`);
    }
  }
  assert.deepEqual(failures, [], `unparseable source files:\n${failures.join('\n\n')}`);
});
