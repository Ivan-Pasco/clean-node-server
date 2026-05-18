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

// No-op stub: returns 0 (null/empty) — never called from server-side WASM at runtime
// but the linker requires all declared imports to be satisfied.
function noop(): number { return 0; }

// Converts a camelCase suffix to snake_case (e.g. "setState" → "set_state").
function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * No-op stubs for all frame.ui client-side bridge functions.
 *
 * frame.ui registers its full client-side bridge function set as WASM imports even
 * when the compiler targets a server module. These functions are never called at
 * runtime from server code, but the WASM linker fails if any declared import is
 * missing a callable. All stubs safely return 0 / empty pointer.
 *
 * The compiler generates both camelCase and snake_case dot-notation variants for
 * every bridge function. The snake_case aliases are derived automatically from the
 * camelCase entries below — no manual listing needed, so future additions stay in sync.
 *
 * Function list is derived from frame.ui plugin.toml [bridge] section.
 */
export function createUiClientStubs(): Record<string, () => number> {
  const stubs: Record<string, () => number> = {
    // Component registry
    _ui_register_component: noop,
    _ui_get_component: noop,

    // Slot management
    _ui_set_slot: noop,
    _ui_get_slot: noop,

    // Event handler registration (client-side hydration)
    _ui_on_event: noop,

    // State management
    _ui_set_state: noop,
    _ui_get_state: noop,

    // DOM manipulation
    _ui_update_element: noop,
    _ui_update_attr: noop,
    _ui_update_element_self: noop,
    _ui_get_text: noop,
    _ui_get_attr: noop,

    // DOM class/style
    _ui_toggle_class: noop,
    _ui_add_class: noop,
    _ui_remove_class: noop,
    _ui_set_style: noop,

    // DOM batch (querySelectorAll)
    _ui_query_set_style: noop,
    _ui_query_set_attr: noop,
    _ui_query_add_class: noop,
    _ui_query_remove_class: noop,
    _ui_filter_by_attr: noop,
    _ui_filter_by_text: noop,

    // Form binding and validation
    _ui_bind_input: noop,
    _ui_validate: noop,
    _ui_input_value: noop,
    _ui_form_json: noop,
    _ui_form_data: noop,
    _ui_checked: noop,
    _ui_set_input: noop,

    // Event handler context
    _ui_event_attr: noop,
    _ui_event_value: noop,
    _ui_event_closest_attr: noop,
    _ui_event_type: noop,

    // Clipboard
    _ui_clipboard_write: noop,

    // URL / location
    _ui_location_href: noop,
    _ui_location_query: noop,
    _ui_location_path: noop,

    // IntersectionObserver
    _ui_observe_visible: noop,

    // Timers
    _ui_set_timeout: noop,

    // Dot-notation camelCase entries (compiler may generate these).
    // snake_case aliases are generated automatically below.
    'ui.registerComponent': noop,
    'ui.getComponent': noop,
    'ui.setSlot': noop,
    'ui.getSlot': noop,
    'ui.onEvent': noop,
    'ui.setState': noop,
    'ui.getState': noop,
    'ui.updateElement': noop,
    'ui.updateAttr': noop,
    'ui.updateElementSelf': noop,
    'ui.getText': noop,
    'ui.getAttr': noop,
    'ui.toggleClass': noop,
    'ui.addClass': noop,
    'ui.removeClass': noop,
    'ui.setStyle': noop,
    'ui.querySetStyle': noop,
    'ui.querySetAttr': noop,
    'ui.queryAddClass': noop,
    'ui.queryRemoveClass': noop,
    'ui.filterByAttr': noop,
    'ui.filterByText': noop,
    'ui.bindInput': noop,
    'ui.validate': noop,
    'ui.inputValue': noop,
    'ui.formJson': noop,
    'ui.formData': noop,
    'ui.checked': noop,
    'ui.setInput': noop,
    'ui.eventAttr': noop,
    'ui.eventValue': noop,
    'ui.eventClosestAttr': noop,
    'ui.eventType': noop,
    'ui.clipboardWrite': noop,
    'ui.locationHref': noop,
    'ui.locationQuery': noop,
    'ui.locationPath': noop,
    'ui.observeVisible': noop,
    'ui.setTimeout': noop,
  };

  // Auto-generate snake_case aliases for all ui.* dot-notation entries.
  // Iterates the camelCase keys already present and fills in any missing
  // snake_case variant so that both naming conventions are always covered.
  for (const key of Object.keys(stubs)) {
    if (key.startsWith('ui.')) {
      const snakeKey = `ui.${camelToSnake(key.slice(3))}`;
      if (!(snakeKey in stubs)) {
        stubs[snakeKey] = noop;
      }
    }
  }

  return stubs;
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
    _ui_load_layout(layoutNamePtr: number, layoutNameLen: number): number {
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
    _ui_inject_head_css(cssPtr: number, cssLen: number): number {
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
