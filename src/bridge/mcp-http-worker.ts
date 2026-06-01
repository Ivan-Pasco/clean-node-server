import { workerData, parentPort } from 'worker_threads';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { ServerResponse, IncomingMessage } from 'http';

interface WorkerInit {
  startBuffer: SharedArrayBuffer;
  reqControlBuffer: SharedArrayBuffer;
  reqDataBuffer: SharedArrayBuffer;
  port: number;
  host: string;
}

const { startBuffer, reqControlBuffer, reqDataBuffer, port, host } = workerData as WorkerInit;
const startCtrl = new Int32Array(startBuffer);
const reqCtrl = new Int32Array(reqControlBuffer);
const reqData = new Uint8Array(reqDataBuffer);

const IDLE = 0;
const READY = 1;
const SHUTDOWN = 2;

const encoder = new TextEncoder();

interface PendingRequest {
  requestId: string;
  body: string;
  res: ServerResponse;
}

const requestQueue: PendingRequest[] = [];
const pendingResponses = new Map<string, ServerResponse>();
const sseClients = new Map<string, ServerResponse>();
let isProcessing = false;

function signalNextRequest(): void {
  if (isProcessing || requestQueue.length === 0) return;

  const req = requestQueue.shift()!;
  pendingResponses.set(req.requestId, req.res);
  isProcessing = true;

  const payload = JSON.stringify({ body: req.body, requestId: req.requestId });
  const bytes = encoder.encode(payload);
  const len = Math.min(bytes.length, reqData.byteLength);
  reqData.set(bytes.subarray(0, len));
  Atomics.store(reqCtrl, 1, len);
  Atomics.store(reqCtrl, 0, READY);
  Atomics.notify(reqCtrl, 0, 1);
}

const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.setHeader('Mcp-Session-Id', randomUUID());

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/mcp') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const requestId = randomUUID();
      requestQueue.push({ requestId, body, res });
      signalNextRequest();
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/sse') {
    const clientId = randomUUID();
    sseClients.set(clientId, res);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.writeHead(200);
    res.write(`event: connected\ndata: {"clientId":"${clientId}"}\n\n`);

    req.on('close', () => {
      sseClients.delete(clientId);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(port, host, () => {
  Atomics.store(startCtrl, 0, 1);
  Atomics.notify(startCtrl, 0, 1);
});

server.on('error', () => {
  Atomics.store(startCtrl, 0, 2);
  Atomics.notify(startCtrl, 0, 1);
});

if (!parentPort) {
  throw new Error('mcp-http-worker must be run as a worker thread');
}

interface RespondMessage {
  type: 'respond';
  requestId: string;
  body: string;
}

interface SseSendMessage {
  type: 'sse_send';
  clientId: string;
  event: string;
}

interface ShutdownMessage {
  type: 'shutdown';
}

type WorkerMessage = RespondMessage | SseSendMessage | ShutdownMessage;

parentPort.on('message', (msg: WorkerMessage) => {
  if (msg.type === 'respond') {
    const res = pendingResponses.get(msg.requestId);
    if (res) {
      pendingResponses.delete(msg.requestId);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(msg.body);
      isProcessing = false;
      signalNextRequest();
    }
  } else if (msg.type === 'sse_send') {
    const client = sseClients.get(msg.clientId);
    if (client && !client.writableEnded) {
      client.write(msg.event);
    }
  } else if (msg.type === 'shutdown') {
    server.close();
    Atomics.store(reqCtrl, 0, SHUTDOWN);
    Atomics.notify(reqCtrl, 0, 1);
  }
});

void IDLE;
