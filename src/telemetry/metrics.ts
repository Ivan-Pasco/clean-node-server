import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'cln_' });

export const httpRequestsTotal = new Counter({
  name: 'cln_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'cln_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const workerPoolAvailable = new Gauge({
  name: 'cln_worker_pool_available',
  help: 'WASM worker slots available (idle)',
  registers: [registry],
});

export const workerPoolInUse = new Gauge({
  name: 'cln_worker_pool_in_use',
  help: 'WASM worker slots currently executing a request',
  registers: [registry],
});

export const workerPoolQueued = new Gauge({
  name: 'cln_worker_pool_queued',
  help: 'Requests waiting for a free WASM worker slot',
  registers: [registry],
});

export const workerPoolTotal = new Gauge({
  name: 'cln_worker_pool_total',
  help: 'Total WASM worker threads (including restarting)',
  registers: [registry],
});
