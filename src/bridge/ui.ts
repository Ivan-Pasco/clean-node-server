import * as fs from 'fs';
import * as path from 'path';
import { WasmState } from '../types';
import { readString, writeString, log } from './helpers';

/**
 * Resolve the project root for layout loading.
 *
 * Priority:
 *  1. state.projectRoot (set explicitly, e.g. from server startup config)
 *  2. process.cwd() (fallback to working directory)
 */
function getProjectRoot(state: WasmState): string {
  if (state.projectRoot) {
    return path.resolve(state.projectRoot);
  }
  return process.cwd();
}

/**
 * Create UI bridge functions
 */
export function createUiBridge(getState: () => WasmState) {
  return {
    /**
     * Load an HTML layout file from the app/layouts directory.
     *
     * The layout is resolved at:
     *   {projectRoot}/app/layouts/{layout_name}.html
     *
     * Returns a pointer to the HTML contents string, or an empty string if the
     * file does not exist or cannot be read.
     */
    _ui_loadLayout(layoutNamePtr: number, layoutNameLen: number): number {
      const state = getState();
      const layoutName = readString(state, layoutNamePtr, layoutNameLen);

      if (!layoutName.trim()) {
        log(state, 'UI', 'Attempted to load layout with empty name');
        return writeString(state, '');
      }

      const projectRoot = getProjectRoot(state);
      const layoutPath = path.join(projectRoot, 'app', 'layouts', `${layoutName}.html`);

      // Ensure the resolved path stays within the project root (prevent traversal)
      const resolved = path.resolve(layoutPath);
      if (!resolved.startsWith(projectRoot)) {
        log(state, 'UI', `Layout path traversal blocked: ${layoutName}`);
        return writeString(state, '');
      }

      if (!fs.existsSync(resolved)) {
        log(state, 'UI', `Layout not found: ${resolved}`);
        return writeString(state, '');
      }

      try {
        const contents = fs.readFileSync(resolved, 'utf8');
        log(state, 'UI', `Loaded layout '${layoutName}' (${contents.length} bytes)`);
        return writeString(state, contents);
      } catch (err) {
        log(state, 'UI', `Failed to read layout '${layoutName}': ${(err as Error).message}`);
        return writeString(state, '');
      }
    },

    /**
     * Accumulate a CSS string for injection into the response <head>.
     *
     * Multiple calls concatenate the CSS strings in order.  The server's
     * response builder checks state.injectedCss before sending HTML responses
     * and injects a <style> block before </head>.
     *
     * Returns 1 on success.
     */
    _ui_injectHeadCss(cssPtr: number, cssLen: number): number {
      const state = getState();
      const css = readString(state, cssPtr, cssLen);

      if (!state.injectedCss) {
        state.injectedCss = [];
      }

      state.injectedCss.push(css);
      log(state, 'UI', `Injected CSS (${css.length} bytes)`);

      return 1;
    },
  };
}
