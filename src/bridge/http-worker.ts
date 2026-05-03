import { workerData, parentPort } from 'worker_threads';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { HttpWorkerRequest, HttpWorkerResponse } from '../types';

const DONE = 2;

interface WorkerInit {
  controlBuffer: SharedArrayBuffer;
  dataBuffer: SharedArrayBuffer;
}

const { controlBuffer, dataBuffer } = workerData as WorkerInit;

const ctrl = new Int32Array(controlBuffer);
const dataBuf = new Uint8Array(dataBuffer);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeResponse(response: unknown): void {
  const json = JSON.stringify(response);
  const bytes = encoder.encode(json);

  if (bytes.length > dataBuffer.byteLength) {
    const errBytes = encoder.encode(JSON.stringify({
      ok: false, status: 0, headers: {}, body: '', updatedCookies: {},
    } satisfies HttpWorkerResponse));
    dataBuf.set(errBytes);
    Atomics.store(ctrl, 1, errBytes.length);
  } else {
    dataBuf.set(bytes);
    Atomics.store(ctrl, 1, bytes.length);
  }

  Atomics.store(ctrl, 0, DONE);
  Atomics.notify(ctrl, 0, 1);
}

function parseCookieHeader(setCookieValues: string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of setCookieValues) {
    const firstPart = header.split(';')[0].trim();
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx > 0) {
      cookies[firstPart.slice(0, eqIdx).trim()] = firstPart.slice(eqIdx + 1).trim();
    }
  }
  return cookies;
}

async function executeRequest(req: HttpWorkerRequest): Promise<HttpWorkerResponse> {
  let url = req.url;
  let method = req.method.toUpperCase();
  let remainingRedirects = req.maxRedirects;
  const updatedCookies: Record<string, string> = {};

  while (true) {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestHeaders: Record<string, string> = { ...req.headers };

    if (req.cookiesEnabled) {
      const allCookies = { ...req.cookies, ...updatedCookies };
      const cookieStr = Object.entries(allCookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      if (cookieStr) {
        requestHeaders['Cookie'] = cookieStr;
      }
    }

    if (req.body) {
      requestHeaders['Content-Length'] = String(Buffer.byteLength(req.body, 'utf8'));
    }

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: requestHeaders,
      timeout: req.timeout,
    };

    const response = await new Promise<HttpWorkerResponse>((resolve) => {
      const clientReq = transport.request(options, (res) => {
        const responseHeaders: Record<string, string> = {};
        const setCookieHeaders: string[] = [];

        for (const [key, val] of Object.entries(res.headers)) {
          if (key.toLowerCase() === 'set-cookie') {
            const vals = Array.isArray(val) ? val : [val as string];
            setCookieHeaders.push(...vals.filter(Boolean));
          } else if (val !== undefined) {
            responseHeaders[key.toLowerCase()] = Array.isArray(val) ? val.join(', ') : val;
          }
        }

        const newCookies = parseCookieHeader(setCookieHeaders);
        Object.assign(updatedCookies, newCookies);

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            ok: true,
            status: res.statusCode ?? 0,
            headers: responseHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
            updatedCookies,
          });
        });
        res.on('error', (err) => {
          resolve({ ok: false, status: 0, headers: {}, body: err.message, updatedCookies: {} });
        });
      });

      clientReq.on('timeout', () => {
        clientReq.destroy();
        resolve({ ok: false, status: 0, headers: {}, body: `Request timed out after ${req.timeout}ms`, updatedCookies: {} });
      });

      clientReq.on('error', (err) => {
        resolve({ ok: false, status: 0, headers: {}, body: err.message, updatedCookies: {} });
      });

      if (req.body) {
        clientReq.write(req.body);
      }
      clientReq.end();
    });

    const status = response.status;
    const isRedirect = [301, 302, 303, 307, 308].includes(status);
    const location = response.headers['location'];

    if (isRedirect && location && remainingRedirects > 0) {
      remainingRedirects--;
      url = new URL(location, url).toString();
      if ([301, 302, 303].includes(status)) {
        method = 'GET';
      }
      continue;
    }

    return response;
  }
}

if (!parentPort) {
  throw new Error('http-worker must be run as a worker thread');
}

parentPort.on('message', async () => {
  try {
    const reqLen = Atomics.load(ctrl, 1);
    const req = JSON.parse(decoder.decode(dataBuf.slice(0, reqLen))) as HttpWorkerRequest;
    const response = await executeRequest(req);
    writeResponse(response);
  } catch (err) {
    writeResponse({ ok: false, status: 0, headers: {}, body: (err as Error).message, updatedCookies: {} });
  }
});
