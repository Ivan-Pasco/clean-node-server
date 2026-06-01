import * as path from 'path';
import { Worker } from 'worker_threads';
import { WasmState } from '../types';
import { readString, writeString } from './helpers';

const CTRL_BYTES = 8;
const STDIO_DATA_SIZE = 1 * 1024 * 1024;
const HTTP_DATA_SIZE = 4 * 1024 * 1024;
const READ_TIMEOUT_MS = 300_000;

const IDLE = 0;
const READY = 1;
const CLOSED = 2;

interface McpInstanceState {
  transport: 'stdio' | 'http' | null;
  stdioCtrl?: Int32Array;
  stdioData?: Uint8Array;
  stdioWorker?: Worker;
  httpStartCtrl?: Int32Array;
  httpReqCtrl?: Int32Array;
  httpReqData?: Uint8Array;
  httpWorker?: Worker;
  lastRequestId?: string;
}

const mcpStates = new WeakMap<WasmState, McpInstanceState>();

function getMcpState(state: WasmState): McpInstanceState {
  let s = mcpStates.get(state);
  if (!s) {
    s = { transport: null };
    mcpStates.set(state, s);
  }
  return s;
}

export function createMcpBridge(getState: () => WasmState) {
  return {
    _mcp_stdio_read(): number {
      const state = getState();
      const mcp = getMcpState(state);

      if (!mcp.stdioWorker) {
        mcp.transport = 'stdio';
        const ctrlBuf = new SharedArrayBuffer(CTRL_BYTES);
        const dataBuf = new SharedArrayBuffer(STDIO_DATA_SIZE);
        mcp.stdioCtrl = new Int32Array(ctrlBuf);
        mcp.stdioData = new Uint8Array(dataBuf);
        mcp.stdioWorker = new Worker(
          path.join(__dirname, 'mcp-stdio-worker.js'),
          { workerData: { controlBuffer: ctrlBuf, dataBuffer: dataBuf } }
        );
        mcp.stdioWorker.on('error', (err) => {
          process.stderr.write(`[frame.mcp] stdio worker error: ${err.message}\n`);
        });
        mcp.stdioWorker.postMessage(null);
      }

      const outcome = Atomics.wait(mcp.stdioCtrl!, 0, IDLE, READ_TIMEOUT_MS);
      if (outcome === 'timed-out') {
        return writeString(state, '');
      }

      const status = Atomics.load(mcp.stdioCtrl!, 0);
      if (status === CLOSED) {
        return writeString(state, '');
      }

      const len = Atomics.load(mcp.stdioCtrl!, 1);
      const line = new TextDecoder().decode(mcp.stdioData!.slice(0, len));

      Atomics.store(mcp.stdioCtrl!, 0, IDLE);
      mcp.stdioWorker!.postMessage(null);

      return writeString(state, line);
    },

    _mcp_stdio_write(msgPtr: number, msgLen: number): number {
      const state = getState();
      const mcp = getMcpState(state);
      const msg = readString(state, msgPtr, msgLen);

      if (mcp.transport === 'http' && mcp.httpWorker && mcp.lastRequestId) {
        mcp.httpWorker.postMessage({ type: 'respond', requestId: mcp.lastRequestId, body: msg });
        mcp.lastRequestId = undefined;
      } else {
        process.stdout.write(msg + '\n');
      }
      return 1;
    },

    _mcp_http_serve(port: number, hostPtr: number, hostLen: number): number {
      const state = getState();
      const mcp = getMcpState(state);
      const host = readString(state, hostPtr, hostLen) || '0.0.0.0';

      mcp.transport = 'http';

      const startBuf = new SharedArrayBuffer(CTRL_BYTES);
      const reqCtrlBuf = new SharedArrayBuffer(CTRL_BYTES);
      const reqDataBuf = new SharedArrayBuffer(HTTP_DATA_SIZE);

      mcp.httpStartCtrl = new Int32Array(startBuf);
      mcp.httpReqCtrl = new Int32Array(reqCtrlBuf);
      mcp.httpReqData = new Uint8Array(reqDataBuf);

      mcp.httpWorker = new Worker(
        path.join(__dirname, 'mcp-http-worker.js'),
        { workerData: { startBuffer: startBuf, reqControlBuffer: reqCtrlBuf, reqDataBuffer: reqDataBuf, port, host } }
      );
      mcp.httpWorker.on('error', (err) => {
        process.stderr.write(`[frame.mcp] http worker error: ${err.message}\n`);
      });

      const outcome = Atomics.wait(mcp.httpStartCtrl, 0, 0, 10_000);
      if (outcome === 'timed-out') {
        process.stderr.write(`[frame.mcp] error: HTTP server startup timed out\n`);
        return 0;
      }

      const startStatus = Atomics.load(mcp.httpStartCtrl, 0);
      if (startStatus === 2) {
        process.stderr.write(`[frame.mcp] error: HTTP server failed to start\n`);
        return 0;
      }

      return 1;
    },

    _mcp_http_accept(): number {
      const state = getState();
      const mcp = getMcpState(state);

      if (!mcp.httpReqCtrl || !mcp.httpReqData) {
        return writeString(state, '');
      }

      const outcome = Atomics.wait(mcp.httpReqCtrl, 0, IDLE, READ_TIMEOUT_MS);
      if (outcome === 'timed-out') {
        return writeString(state, '');
      }

      const status = Atomics.load(mcp.httpReqCtrl, 0);
      if (status === CLOSED) {
        return writeString(state, '');
      }

      const len = Atomics.load(mcp.httpReqCtrl, 1);
      const json = new TextDecoder().decode(mcp.httpReqData.slice(0, len));

      let requestBody = '';
      try {
        const parsed = JSON.parse(json) as { body: string; requestId: string };
        requestBody = parsed.body;
        mcp.lastRequestId = parsed.requestId;
      } catch {
        requestBody = json;
      }

      Atomics.store(mcp.httpReqCtrl, 0, IDLE);

      return writeString(state, requestBody);
    },

    _mcp_sse_send(clientIdPtr: number, clientIdLen: number, eventPtr: number, eventLen: number): number {
      const state = getState();
      const mcp = getMcpState(state);
      const clientId = readString(state, clientIdPtr, clientIdLen);
      const event = readString(state, eventPtr, eventLen);

      if (mcp.httpWorker) {
        mcp.httpWorker.postMessage({ type: 'sse_send', clientId, event });
        return 1;
      }
      return 0;
    },

    _mcp_log(levelPtr: number, levelLen: number, msgPtr: number, msgLen: number): number {
      const state = getState();
      const level = readString(state, levelPtr, levelLen);
      const msg = readString(state, msgPtr, msgLen);
      process.stderr.write(`[frame.mcp] ${level}: ${msg}\n`);
      return 1;
    },
  };
}
