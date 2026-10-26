import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { connectMcpServers } from '../src/mcp-core.ts';

// End-to-end MCP client test over a real stdio pipe. The unit tests only cover
// config parsing and naming; this one proves a server can actually be reached,
// its tools discovered, and a tool invoked.

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, 'fixtures', 'mcp-echo-server.mjs');

test('connects to a stdio MCP server and discovers its tools', async () => {
  const connection = await connectMcpServers(
    JSON.stringify({ echo: { command: process.execPath, args: [serverPath] } }),
    here,
    async () => {},
  );
  try {
    assert.deepEqual(connection.errors, [], `connection errors: ${connection.errors.join(' | ')}`);
    const names = Object.keys(connection.tools);
    assert.equal(names.length, 1, `expected 1 tool, got ${names.join(',') || 'none'}`);
    assert.ok(names[0].endsWith('echo'), `unexpected tool name ${names[0]}`);
    assert.match(connection.tools[names[0]].description, /\[MCP: echo\]/);
  } finally {
    await connection.close();
  }
});

test('reports server instructions from the initialize handshake', async () => {
  const connection = await connectMcpServers(
    JSON.stringify({ echo: { command: process.execPath, args: [serverPath] } }),
    here,
    async () => {},
  );
  try {
    assert.equal(connection.instructions.length, 1);
    assert.match(connection.instructions[0], /Test server: only the echo tool/);
  } finally {
    await connection.close();
  }
});

test('calls a discovered tool and returns its result', async () => {
  const connection = await connectMcpServers(
    JSON.stringify({ echo: { command: process.execPath, args: [serverPath] } }),
    here,
    async () => {},
  );
  try {
    const name = Object.keys(connection.tools)[0];
    const result = await connection.tools[name].execute({ text: 'hello' }, {});
    const text = JSON.stringify(result);
    assert.match(text, /echo:hello/, `tool result was ${text}`);
  } finally {
    await connection.close();
  }
});

test('a broken server config is reported instead of throwing', async () => {
  const connection = await connectMcpServers(
    JSON.stringify({ broken: { command: 'definitely-not-a-real-binary-xyz' } }),
    here,
    async () => {},
  );
  try {
    assert.equal(Object.keys(connection.tools).length, 0);
    assert.equal(connection.errors.length, 1);
  } finally {
    await connection.close();
  }
});
// ---------------------------------------------------------------- remote (HTTP)

async function startHttpServer() {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [join(here, 'fixtures', 'mcp-http-server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP MCP server did not report a port')), 10_000);
    child.stdout.on('data', (chunk) => {
      const match = /PORT=(\d+)/.exec(String(chunk));
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on('error', reject);
  });
  return { child, port, stop: () => child.kill() };
}

test('connects to a remote MCP server over HTTP', async () => {
  const http = await startHttpServer();
  try {
    const connection = await connectMcpServers(
      JSON.stringify({ remote: { url: `http://127.0.0.1:${http.port}/mcp` } }),
      here,
      async () => {},
    );
    try {
      assert.deepEqual(connection.errors, [], `connection errors: ${connection.errors.join(' | ')}`);
      const names = Object.keys(connection.tools);
      assert.equal(names.length, 1, `expected 1 tool, got ${names.join(',') || 'none'}`);
      assert.ok(names[0].endsWith('ping'), `unexpected tool name ${names[0]}`);
    } finally {
      await connection.close();
    }
  } finally {
    http.stop();
  }
});

// ---------------------------------------------------------------- robustness

test('a server that exits reports its stderr, not a bare "closed"', async () => {
  const connection = await connectMcpServers(
    JSON.stringify({ failing: { command: process.execPath, args: [serverPath, '--fail'] } }),
    here,
    async () => {},
  );
  try {
    assert.equal(connection.errors.length, 1);
    // The real cause must survive: a bare "server closed" is unactionable.
    assert.match(connection.errors[0], /FOO_API_KEY/, `error was: ${connection.errors[0]}`);
  } finally {
    await connection.close();
  }
});

test('tools/list pagination is followed to the last page', async () => {
  const connection = await connectMcpServers(
    JSON.stringify({ paged: { command: process.execPath, args: [serverPath, '--paginate'] } }),
    here,
    async () => {},
  );
  try {
    assert.deepEqual(connection.errors, []);
    const names = Object.keys(connection.tools);
    assert.equal(names.length, 2, `expected both pages, got ${names.join(',') || 'none'}`);
    assert.ok(names.some((name) => name.endsWith('echo')));
    assert.ok(names.some((name) => name.endsWith('later')));
  } finally {
    await connection.close();
  }
});

test('resources are listable and readable', async () => {
  const connection = await connectMcpServers(
    JSON.stringify({ docs: { command: process.execPath, args: [serverPath, '--resources'] } }),
    here,
    async () => {},
  );
  try {
    assert.deepEqual(connection.errors, []);
    const resources = await connection.listResources('docs');
    assert.equal(resources.length, 1);
    assert.equal(resources[0].uri, 'file:///notes.md');
    const text = await connection.readResource('docs', 'file:///notes.md');
    assert.match(text, /Hello from the fixture/);
  } finally {
    await connection.close();
  }
});

test('a server that never answers does not hang the caller', async () => {
  const started = Date.now();
  const connection = await connectMcpServers(
    JSON.stringify({ slow: { command: process.execPath, args: [serverPath, '--slow'] } }),
    here,
    async () => {},
  );
  try {
    // The client must give up on its own timeout rather than blocking a run.
    assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started}ms`);
    assert.equal(Object.keys(connection.tools).length, 0);
    assert.equal(connection.errors.length, 1);
  } finally {
    await connection.close();
  }
});

// ---------------------------------------------------------------- AI SDK shape

test('discovered tools are shaped for the AI SDK tool set', async () => {
  const connection = await connectMcpServers(
    JSON.stringify({ echo: { command: process.execPath, args: [serverPath] } }),
    here,
    async () => {},
  );
  try {
    const name = Object.keys(connection.tools)[0];
    const entry = connection.tools[name];
    // The agent hands these straight to the model as its tool set, so the shape
    // has to be what the AI SDK expects, not just what the MCP client returned.
    assert.equal(typeof entry.description, 'string');
    assert.equal(typeof entry.execute, 'function');
    assert.ok(entry.inputSchema, 'tool is missing an input schema');
    assert.equal(entry.inputSchema.jsonSchema?.type, 'object', 'schema is not JSON-schema wrapped');
    assert.ok(entry.inputSchema.jsonSchema?.properties?.text, 'schema lost the tool parameters');
  } finally {
    await connection.close();
  }
});

test('the approval gate runs before a tool executes', async () => {
  const seen = [];
  const connection = await connectMcpServers(
    JSON.stringify({ echo: { command: process.execPath, args: [serverPath] } }),
    here,
    async (title, detail) => { seen.push({ title, detail }); },
  );
  try {
    const name = Object.keys(connection.tools)[0];
    await connection.tools[name].execute({ text: 'gated' }, {});
    assert.equal(seen.length, 1, 'tool ran without asking for approval');
    assert.match(seen[0].title, /Use echo: echo\?/);
    assert.match(seen[0].detail, /"text": "gated"/);
  } finally {
    await connection.close();
  }
});
