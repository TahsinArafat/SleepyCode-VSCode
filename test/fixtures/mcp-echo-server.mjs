/**
 * Minimal MCP stdio server used by test/mcp-connection.direct.mjs.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdio with exactly the handshake a
 * real server performs: `initialize`, the `notifications/initialized` note,
 * `tools/list`, and `tools/call`. Keeping it in-process-free means the MCP
 * client is exercised over a genuine pipe rather than a mocked transport.
 */
import { createInterface } from 'node:readline';

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
        capabilities: { tools: {} },
        serverInfo: { name: 'sleepycode-test-server', version: '1.0.0' },
        instructions: 'Test server: only the echo tool is available.',
      },
    });
    return;
  }

  if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } });
    return;
  }

  if (request.method === 'tools/call') {
    const args = request.params?.arguments ?? {};
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }], isError: false },
    });
    return;
  }

  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unknown method ${request.method}` } });
});