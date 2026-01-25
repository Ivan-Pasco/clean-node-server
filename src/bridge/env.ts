import { WasmState } from '../types';
import { readString, writeString } from './helpers';

/**
 * Create environment variable bridge functions
 */
export function createEnvBridge(getState: () => WasmState) {
  return {
    /**
     * Get environment variable value
     *
     * @returns Pointer to value string or empty if not set
     */
    _env_get(namePtr: number, nameLen: number): number {
      const state = getState();
      const name = readString(state, namePtr, nameLen);
      const value = process.env[name] || '';
      return writeString(state, value);
    },

    /**
     * Check if environment variable exists
     */
    _env_has(namePtr: number, nameLen: number): number {
      const state = getState();
      const name = readString(state, namePtr, nameLen);
      return name in process.env ? 1 : 0;
    },

    /**
     * Get all environment variables as JSON
     * (filtered to exclude sensitive values)
     */
    _env_all(): number {
      const state = getState();

      // Filter out potentially sensitive environment variables
      const sensitiveKeys = [
        'AWS_SECRET',
        'API_KEY',
        'SECRET',
        'PASSWORD',
        'TOKEN',
        'PRIVATE',
      ];

      const filtered: Record<string, string> = {};

      for (const [key, value] of Object.entries(process.env)) {
        const upperKey = key.toUpperCase();
        const isSensitive = sensitiveKeys.some(
          (sensitive) => upperKey.includes(sensitive)
        );

        if (!isSensitive && value !== undefined) {
          filtered[key] = value;
        }
      }

      return writeString(state, JSON.stringify(filtered));
    },

    /**
     * Get NODE_ENV
     */
    _env_node_env(): number {
      const state = getState();
      return writeString(state, process.env.NODE_ENV || 'development');
    },

    /**
     * Check if running in production
     */
    _env_is_production(): number {
      return process.env.NODE_ENV === 'production' ? 1 : 0;
    },

    /**
     * Check if running in development
     */
    _env_is_development(): number {
      return process.env.NODE_ENV !== 'production' ? 1 : 0;
    },
  };
}
