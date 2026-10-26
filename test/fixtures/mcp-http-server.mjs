/**
 * Minimal MCP Streamable HTTP server used by test/mcp-connection.direct.mjs.
 *
 * Accepts JSON-RPC over POST, answers with a single JSON body, and issues a
 * session id on initialize so the client can send it back on later requests —
 * the same shape a hosted MCP endpoint presents.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const TOOLS = [
  {
    name: 'ping',
    description: 'Return a pong for the provided text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

const sessions = new Set();

function handle(request) {
  if (request.method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'sleepycode-http-test-server', version: '1.0.0' },
      instructions: 'HTTP test server: only the ping tool is available.',
    };
  }
  if (request.method === 'tools/list') return { tools: TOOLS };
  if (request.method === 'tools/call') {
    const args = request.params?.arguments ?? {};
    return { content: [{ type: 'text', text: `pong:${args.text ?? ''}` }], isError: false };
  }
  return undefined;
}

const server = createServer((req, res) => {
  if (req.method === 'GET') {
    // The stream endpoint the spec allows when sessions use server-sent events.
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'SSE not supported' }, id: null }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }
    const headers = { 'content-type': 'application/json' };
    if (request.method === 'initialize') {
      const sessionId = randomUUID();
      sessions.add(sessionId);
      headers['mcp-session-id'] = sessionId;
    }
    // Notifications are acknowledged without a body.
    if (request.id === undefined) {
      res.writeHead(202, headers).end();
      return;
    }
    const result = handle(request);
    if (result === undefined) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unknown method ${request.method}` } }));
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`PORT=${address.port}\n`);
});