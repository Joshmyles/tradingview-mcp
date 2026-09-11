/**
 * Both profiles must survive a real tools/list.
 *
 * Counting by stub registration never converts a schema, so it cannot see a
 * schema the SDK fails to serialise. That gap hid a whole-server outage: under
 * zod 4, `z.record(z.any())` (one argument) leaves the value type undefined,
 * and tools/list failed with "Cannot read properties of undefined (reading
 * '_zod')" — every tool invisible, not just the one with the bad schema.
 * This lists through a real McpServer over an in-memory transport.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  registerWorkflowTools,
  registerDiagnosticTools,
  WORKFLOW_TOOL_NAMES,
  DIAGNOSTIC_TOOL_NAMES,
} from '../src/profiles.js';

async function listed(register) {
  const server = new McpServer({ name: 'listing-test', version: '0' });
  register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'listing-test-client', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe('tools/list through a real server', () => {
  for (const [profile, register, names] of [
    ['workflow', registerWorkflowTools, WORKFLOW_TOOL_NAMES],
    ['diagnostic', registerDiagnosticTools, DIAGNOSTIC_TOOL_NAMES],
  ]) {
    it(`${profile}: every registered tool lists, with an object input schema`, async () => {
      const tools = await listed(register);
      assert.deepEqual(tools.map((t) => t.name).sort(), [...names].sort());
      for (const t of tools) assert.equal(t.inputSchema?.type, 'object', t.name);
    });
  }

  it('record-typed parameters serialise as objects', async () => {
    const tools = await listed(registerWorkflowTools);
    const prop = (tool, p) => tools.find((t) => t.name === tool).inputSchema.properties[p];
    assert.equal(prop('replay_step_until', 'predicate').type, 'object');
    assert.equal(prop('pine_inputs_assert', 'manifest').type, 'object');
    assert.equal(prop('backtest_run', 'manifest').type, 'object');
    assert.equal(prop('walk_forward', 'manifest').type, 'object');
  });
});
