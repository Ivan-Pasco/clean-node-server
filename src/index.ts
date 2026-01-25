#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import { CleanNodeServer } from './server';
import { InMemorySessionStore } from './session/store';
import { createDatabaseDriver } from './database';
import { setSandboxRoot } from './bridge/file';
import { ServerConfig, DatabaseDriver } from './types';

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
  .option('--sandbox <path>', 'Sandbox root for file operations (default: current directory)')
  .action(async (wasmFile: string, options) => {
    try {
      // Resolve WASM file path
      const wasmPath = path.resolve(wasmFile);

      // Build configuration
      const config: ServerConfig = {
        port: parseInt(options.port, 10),
        host: options.host,
        databaseUrl: options.database,
        verbose: options.verbose,
        sessionSecret: options.sessionSecret,
        jwtSecret: options.jwtSecret,
      };

      if (config.verbose) {
        console.log('Configuration:', {
          wasmFile: wasmPath,
          port: config.port,
          host: config.host,
          database: config.databaseUrl ? '***' : undefined,
          verbose: config.verbose,
        });
      }

      // Set sandbox root
      const sandboxRoot = options.sandbox
        ? path.resolve(options.sandbox)
        : path.dirname(wasmPath);
      setSandboxRoot(sandboxRoot);

      if (config.verbose) {
        console.log(`File sandbox root: ${sandboxRoot}`);
      }

      // Create session store
      const sessionStore = new InMemorySessionStore();

      // Create database driver if configured
      let database: DatabaseDriver | undefined;
      if (config.databaseUrl) {
        try {
          database = await createDatabaseDriver(config.databaseUrl);
          console.log('Database connected');
        } catch (err) {
          console.error('Failed to connect to database:', err);
          process.exit(1);
        }
      }

      // Create and initialize server
      const server = new CleanNodeServer(
        wasmPath,
        config,
        sessionStore,
        database
      );

      console.log('Loading WASM module...');
      await server.initialize();

      // Start server
      await server.start();

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log('\nShutting down...');

        if (database) {
          await database.close();
        }

        sessionStore.close();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  });

program.parse();
