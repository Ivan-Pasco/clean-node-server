import * as fs from 'fs';
import * as path from 'path';
import { WasmState } from '../types';
import { readString, writeString, log } from './helpers';

/**
 * Base directory for file operations (sandboxed)
 * This should be set to the project directory for security
 */
let sandboxRoot: string = process.cwd();

/**
 * Set the sandbox root directory
 */
export function setSandboxRoot(root: string): void {
  sandboxRoot = path.resolve(root);
}

/**
 * Resolve a path within the sandbox
 * Prevents directory traversal attacks
 */
function resolveSandboxPath(filePath: string): string | null {
  const resolved = path.resolve(sandboxRoot, filePath);

  // Ensure the resolved path is within the sandbox
  if (!resolved.startsWith(sandboxRoot)) {
    return null;
  }

  return resolved;
}

/**
 * Create file I/O bridge functions
 */
export function createFileBridge(getState: () => WasmState) {
  return {
    /**
     * Read file contents
     *
     * @returns Pointer to file contents string
     */
    file_read(pathPtr: number, pathLen: number): number {
      const state = getState();
      const filePath = readString(state, pathPtr, pathLen);
      const resolved = resolveSandboxPath(filePath);

      if (!resolved) {
        log(state, 'FILE', `Access denied (outside sandbox): ${filePath}`);
        return writeString(state, '');
      }

      try {
        const content = fs.readFileSync(resolved, 'utf8');
        log(state, 'FILE', `Read: ${filePath} (${content.length} bytes)`);
        return writeString(state, content);
      } catch (err) {
        log(state, 'FILE', `Read failed: ${filePath}`, err);
        return writeString(state, '');
      }
    },

    /**
     * Read file as binary (returns base64)
     */
    file_read_binary(pathPtr: number, pathLen: number): number {
      const state = getState();
      const filePath = readString(state, pathPtr, pathLen);
      const resolved = resolveSandboxPath(filePath);

      if (!resolved) {
        return writeString(state, '');
      }

      try {
        const content = fs.readFileSync(resolved);
        return writeString(state, content.toString('base64'));
      } catch {
        return writeString(state, '');
      }
    },

    /**
     * Write file contents
     *
     * @returns 0 on success, -1 on error
     */
    file_write(
      pathPtr: number,
      pathLen: number,
      dataPtr: number,
      dataLen: number
    ): number {
      const state = getState();
      const filePath = readString(state, pathPtr, pathLen);
      const data = readString(state, dataPtr, dataLen);
      const resolved = resolveSandboxPath(filePath);

      if (!resolved) {
        log(state, 'FILE', `Access denied (outside sandbox): ${filePath}`);
        return -1;
      }

      try {
        // Ensure directory exists
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(resolved, data, 'utf8');
        log(state, 'FILE', `Wrote: ${filePath} (${data.length} bytes)`);
        return 0;
      } catch (err) {
        log(state, 'FILE', `Write failed: ${filePath}`, err);
        return -1;
      }
    },

    /**
     * Write binary file (data is base64 encoded)
     */
    file_write_binary(
      pathPtr: number,
      pathLen: number,
      dataPtr: number,
      dataLen: number
    ): number {
      const state = getState();
      const filePath = readString(state, pathPtr, pathLen);
      const base64Data = readString(state, dataPtr, dataLen);
      const resolved = resolveSandboxPath(filePath);

      if (!resolved) {
        return -1;
      }

      try {
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(resolved, buffer);
        return 0;
      } catch {
        return -1;
      }
    },

    /**
     * Append to file
     */
    file_append(
      pathPtr: number,
      pathLen: number,
      dataPtr: number,
      dataLen: number
    ): number {
      const state = getState();
      const filePath = readString(state, pathPtr, pathLen);
      const data = readString(state, dataPtr, dataLen);
      const resolved = resolveSandboxPath(filePath);

      if (!resolved) {
        return -1;
      }

      try {
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.appendFileSync(resolved, data, 'utf8');
        log(state, 'FILE', `Appended: ${filePath} (${data.length} bytes)`);
        return 0;
      } catch (err) {
        log(state, 'FILE', `Append failed: ${filePath}`, err);
        return -1;
      }
    },

    /**
     * Check if file exists
     *
     * @returns 1 if exists, 0 otherwise
     */
    file_exists(pathPtr: number, pathLen: number): number {
      const state = getState();
      const filePath = readString(state, pathPtr, pathLen);
      const resolved = resolveSandboxPath(filePath);

      if (!resolved) {
        return 0;
      }

      return fs.existsSync(resolved) ? 1 : 0;
    },

    /**
     * Delete a file
     *
     * @returns 0 on success, -1 on error
     */
    file_delete(pathPtr: number, pathLen: number): number {
      const state = getState();
      const filePath = readString(state, pathPtr, pathLen);
      const resolved = resolveSandboxPath(filePath);

      if (!resolved) {
        log(state, 'FILE', `Access denied (outside sandbox): ${filePath}`);
        return -1;
      }

      try {
        fs.unlinkSync(resolved);
        log(state, 'FILE', `Deleted: ${filePath}`);
        return 0;
      } catch (err) {
        log(state, 'FILE', `Delete failed: ${filePath}`, err);
        return -1;
      }
    },

    /**
     * Get file size in bytes
     *
     * @returns File size or -1 on error
     */
    file_size(pathPtr: number, pathLen: number): number {
      const state = getState();
      const filePath = readString(state, pathPtr, pathLen);
      const resolved = resolveSandboxPath(filePath);

      if (!resolved) {
        return -1;
      }

      try {
        const stats = fs.statSync(resolved);
        return stats.size;
      } catch {
        return -1;
      }
    },

    /**
     * Check if path is a directory
     */
    file_is_directory(pathPtr: number, pathLen: number): number {
      const state = getState();
      const filePath = readString(state, pathPtr, pathLen);
      const resolved = resolveSandboxPath(filePath);

      if (!resolved) {
        return 0;
      }

      try {
        const stats = fs.statSync(resolved);
        return stats.isDirectory() ? 1 : 0;
      } catch {
        return 0;
      }
    },

    /**
     * List directory contents
     *
     * @returns Pointer to JSON array of filenames
     */
    file_list_dir(pathPtr: number, pathLen: number): number {
      const state = getState();
      const dirPath = readString(state, pathPtr, pathLen);
      const resolved = resolveSandboxPath(dirPath);

      if (!resolved) {
        return writeString(state, '[]');
      }

      try {
        const entries = fs.readdirSync(resolved);
        return writeString(state, JSON.stringify(entries));
      } catch {
        return writeString(state, '[]');
      }
    },

    /**
     * Create directory (recursive)
     */
    file_mkdir(pathPtr: number, pathLen: number): number {
      const state = getState();
      const dirPath = readString(state, pathPtr, pathLen);
      const resolved = resolveSandboxPath(dirPath);

      if (!resolved) {
        return -1;
      }

      try {
        fs.mkdirSync(resolved, { recursive: true });
        return 0;
      } catch {
        return -1;
      }
    },

    /**
     * Remove directory
     */
    file_rmdir(pathPtr: number, pathLen: number): number {
      const state = getState();
      const dirPath = readString(state, pathPtr, pathLen);
      const resolved = resolveSandboxPath(dirPath);

      if (!resolved) {
        return -1;
      }

      try {
        fs.rmdirSync(resolved, { recursive: true });
        return 0;
      } catch {
        return -1;
      }
    },

    /**
     * Copy file
     */
    file_copy(
      srcPtr: number,
      srcLen: number,
      destPtr: number,
      destLen: number
    ): number {
      const state = getState();
      const srcPath = readString(state, srcPtr, srcLen);
      const destPath = readString(state, destPtr, destLen);

      const resolvedSrc = resolveSandboxPath(srcPath);
      const resolvedDest = resolveSandboxPath(destPath);

      if (!resolvedSrc || !resolvedDest) {
        return -1;
      }

      try {
        fs.copyFileSync(resolvedSrc, resolvedDest);
        return 0;
      } catch {
        return -1;
      }
    },

    /**
     * Rename/move file
     */
    file_rename(
      srcPtr: number,
      srcLen: number,
      destPtr: number,
      destLen: number
    ): number {
      const state = getState();
      const srcPath = readString(state, srcPtr, srcLen);
      const destPath = readString(state, destPtr, destLen);

      const resolvedSrc = resolveSandboxPath(srcPath);
      const resolvedDest = resolveSandboxPath(destPath);

      if (!resolvedSrc || !resolvedDest) {
        return -1;
      }

      try {
        fs.renameSync(resolvedSrc, resolvedDest);
        return 0;
      } catch {
        return -1;
      }
    },
  };
}
