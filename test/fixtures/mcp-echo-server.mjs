/**
 * Minimal MCP stdio server used by test/mcp-connection.direct.mjs.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdio with exactly the handshake a
 * real server performs: `initialize`, the `notifications/initialized` note,
 * `tools/list`, and `tools/call`. Keeping it in-process-free means the MCP
 * client is exercised over a genuine pipe rather than a mocked transport.
 *
 * Flags let one fixture cover the failure and edge modes the client must handle:
 *   --resources  expose resources/list, resources/templates/list, resources/read
 *   --paginate   split tools/list into two pages via nextCursor
 *   --fail       write a diagnostic to stderr and exit non-zero
 *   --slow       delay tools/list so a timeout can be observed
 */
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

if (has('--fail')) {
  // A real server that cannot start usually explains itself on stderr; the
  // client must surface that instead of a bare "server closed".
  process.stderr.write('fatal: missing required configuration FOO_API_KEY\n');
  process.exit(3);
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

const SECOND_PAGE = [
  {
    name: 'later',
    description: 'Only appears on the second page of tools/list.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const RESOURCES = [
  { uri: 'file:///notes.md', name: 'notes', description: 'Project notes', mimeType: 'text/markdown' },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    return;
  }
  // Notifications carry no id and must not be answered.
  if (request.id === undefined) return;

  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: has('--resources') ? { tools: {}, resources: {} } : { tools: {} },
        serverInfo: { name: 'sleepycode-test-server', version: '1.0.0' },
        instructions: 'Test server: only the echo tool is available.',
      },
    });
    return;
  }

  if (request.method === 'tools/list') {
    if (has('--slow')) {
      setTimeout(() => send({ jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } }), 60_000);
      return;
    }
    if (has('--paginate')) {
      const cursor = request.params?.cursor;
      if (!cursor) {
        send({ jsonrpc: '2.0', id: request.id, result: { tools: TOOLS, nextCursor: 'page-2' } });
      } else if (cursor === 'page-2') {
        send({ jsonrpc: '2.0', id: request.id, result: { tools: SECOND_PAGE } });
      } else {
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `unknown cursor ${cursor}` } });
      }
      return;
    }
    send({ jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } });
    return;
  }

  if (request.method === 'resources/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { resources: has('--resources') ? RESOURCES : [] } });
    return;
  }

  if (request.method === 'resources/templates/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { resourceTemplates: [] } });
    return;
  }

  if (request.method === 'resources/read') {
    const uri = request.params?.uri;
    if (uri !== 'file:///notes.md') {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `unknown resource ${uri}` } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: { contents: [{ uri, mimeType: 'text/markdown', text: '# Notes\n\nHello from the fixture.' }] },
    });
    return;
  }

  if (request.method === 'tools/call') {
    const callArgs = request.params?.arguments ?? {};
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [{ type: 'text', text: `echo:${callArgs.text ?? ''}` }], isError: false },
    });
    return;
  }

  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unknown method ${request.method}` } });
});