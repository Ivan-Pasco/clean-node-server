#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import { CleanNodeServer } from './server';
import { InMemorySessionStore } from './session/store';
import { RedisSessionStore } from './session/redis-store';
import { createDatabaseDriver } from './database';
import { setSandboxRoot } from './bridge/file';
import { createLogger } from './telemetry/logger';
import { startMemoryGuard } from './telemetry/memory-guard';
import { ServerConfig, DatabaseDriver, AnySessionStore } from './types';

const program = new Command();

program
  .name('clean-node-server')
  .description('Node.js host bridge for Clean Language WASM modules')
  .version('0.1.0')
  .argument('<wasm-file>', 'Path to the compiled WASM file')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .option('-h, --host <string>', 'Host to bind to', '0.0.0.0')
  .option('-d, --database <url>', 'Database connection URL (postgres://, sqlite://)')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .option('--session-secret <string>', 'Session secret key', 'clean-node-server-secret')
  .option('--jwt-secret <string>', 'JWT secret key', 'clean-node-server-jwt-secret')
  .option('--sandbox <path>', 'Sandbox root for file operations (default: wasm file directory)')
  .option('--memory-limit <MB>', 'Cap WASM linear memory per instance (MB)')
  .option('--memory-soft-limit <MB>', 'When process RSS crosses this (MB), drain in-flight requests and exit(0). Prevents the kernel cgroup throttle wedge.')
  .option('--memory-soft-limit-poll <ms>', 'Sampling interval for --memory-soft-limit, in ms (default 5000)', '5000')
  .option('--tls-cert <path>', 'Path to TLS certificate file')
  .option('--tls-key <path>', 'Path to TLS private key file')
  .option('--rate-limit <n>', 'Max requests per window per IP (0 = disabled)', '0')
  .option('--rate-limit-window <ms>', 'Rate limit window in milliseconds', '60000')
  .option('--cors-origin <origin>', 'CORS allowed origin (e.g. * or https://myapp.com)')
  .option('--pg-pool-size <n>', 'Total PostgreSQL connections across all workers (default 20)', '20')
  .option('--session-redis <url>', 'Redis URL for session storage (e.g. redis://localhost:6379)')
  .action(async (wasmFile: string, options) => {
    process.on('uncaughtException', (err) => {
      console.error('[FATAL] Uncaught exception:', err);
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      console.error('[FATAL] Unhandled rejection:', reason);
      process.exit(1);
    });

    try {
      const wasmPath = path.resolve(wasmFile);

      let memoryLimitBytes: number | undefined;
      if (options.memoryLimit !== undefined) {
        const mb = Number(options.memoryLimit);
        if (!Number.isFinite(mb) || mb <= 0) {
          console.error(`Invalid --memory-limit: ${options.memoryLimit} (must be a positive number of MB)`);
          process.exit(1);
        }
        memoryLimitBytes = Math.floor(mb * 1024 * 1024);
      }

      let memorySoftLimitBytes: number | undefined;
      if (options.memorySoftLimit !== undefined) {
        const mb = Number(options.memorySoftLimit);
        if (!Number.isFinite(mb) || mb <= 0) {
          console.error(`Invalid --memory-soft-limit: ${options.memorySoftLimit} (must be a positive number of MB)`);
          process.exit(1);
        }
        memorySoftLimitBytes = Math.floor(mb * 1024 * 1024);
      }

      const memorySoftLimitPollMs = parseInt(options.memorySoftLimitPoll, 10) || 5000;
      if (memorySoftLimitPollMs < 250) {
        console.error(`Invalid --memory-soft-limit-poll: ${options.memorySoftLimitPoll} (minimum 250ms)`);
        process.exit(1);
      }

      const config: ServerConfig = {
        port: parseInt(options.port, 10),
        host: options.host,
        databaseUrl: options.database,
        verbose: options.verbose,
        sessionSecret: options.sessionSecret,
        jwtSecret: options.jwtSecret,
        memoryLimitBytes,
        tlsCert: options.tlsCert,
        tlsKey: options.tlsKey,
        rateLimitMax: parseInt(options.rateLimit, 10) || 0,
        rateLimitWindowMs: parseInt(options.rateLimitWindow, 10) || 60000,
        corsOrigin: options.corsOrigin,
        pgPoolSize: parseInt(options.pgPoolSize, 10) || 20,
        memorySoftLimitBytes,
        memorySoftLimitPollMs,
      };

      const log = createLogger(config.verbose);

      if (config.verbose) {
        log.debug({
          wasmFile: wasmPath,
          port: config.port,
          host: config.host,
          database: config.databaseUrl ? '***' : undefined,
          tls: !!config.tlsCert,
          rateLimitMax: config.rateLimitMax,
          corsOrigin: config.corsOrigin,
          pgPoolSize: config.pgPoolSize,
          memoryLimitBytes: config.memoryLimitBytes,
        }, 'Configuration');
      }

      const sandboxRoot = options.sandbox
        ? path.resolve(options.sandbox)
        : path.dirname(wasmPath);
      setSandboxRoot(sandboxRoot);

      if (config.verbose) {
        log.debug({ sandboxRoot }, 'File sandbox');
      }

      let sessionStore: AnySessionStore;
      if (options.sessionRedis) {
        const redisStore = new RedisSessionStore(options.sessionRedis);
        try {
          await redisStore.connect();
          log.info({ url: options.sessionRedis.replace(/\/\/.*@/, '//<redacted>@') }, 'Redis session store connected');
        } catch (err) {
          log.error({ err }, 'Failed to connect to Redis session store');
          process.exit(1);
        }
        sessionStore = redisStore;
      } else {
        sessionStore = new InMemorySessionStore();
      }

      let database: DatabaseDriver | undefined;
      if (config.databaseUrl) {
        try {
          database = await createDatabaseDriver(config.databaseUrl, config.pgPoolSize);
          log.info('Database connected');
        } catch (err) {
          log.error({ err }, 'Failed to connect to database');
          process.exit(1);
        }
      }

      const server = new CleanNodeServer(wasmPath, config, sessionStore, database);

      log.info('Loading WASM module...');
      await server.initialize();
      await server.start(config.port);

      let shuttingDown = false;
      const shutdown = async (exitCode = 0) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info('Shutting down...');
        memoryGuard?.stop();
        // Start the force-exit watchdog only once shutdown begins, not at startup.
        const forceExit = setTimeout(() => {
          console.error('[shutdown] Forced exit after 35s timeout');
          process.exit(1);
        }, 35000);
        forceExit.unref();
        await server.gracefulShutdown(30000);
        if (database) await database.close();
        await sessionStore.close();
        process.exit(exitCode);
      };

      let memoryGuard: ReturnType<typeof startMemoryGuard> | undefined;
      if (config.memorySoftLimitBytes) {
        memoryGuard = startMemoryGuard(
          config.memorySoftLimitBytes,
          config.memorySoftLimitPollMs ?? 5000,
          (_rss) => {
            // Fire-and-forget: shutdown() itself is idempotent via `shuttingDown`.
            void shutdown(0);
          },
        );
        log.info({
          softLimitMB: Math.round(config.memorySoftLimitBytes / (1024 * 1024)),
          pollMs: config.memorySoftLimitPollMs,
        }, 'Memory soft-limit guard active');
      }

      process.on('SIGINT', () => { void shutdown(0); });
      process.on('SIGTERM', () => { void shutdown(0); });
    } catch (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  });

program.parse();
