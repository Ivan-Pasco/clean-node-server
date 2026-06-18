import * as fs from 'fs';
import * as path from 'path';
import { WasmState } from '../types';
import { readString, writeString, log } from './helpers';

function getNestedValue(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const part of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evaluateCondition(condition: string, data: unknown): boolean {
  const value = getNestedValue(data, condition.trim());
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return false;
}

function findTagStart(html: string, attrPos: number): number | null {
  const before = html.slice(0, attrPos);
  const idx = before.lastIndexOf('<');
  return idx === -1 ? null : idx;
}

function extractTagName(html: string, tagStart: number): string {
  const after = html.slice(tagStart + 1);
  const match = after.match(/^[A-Za-z][A-Za-z0-9-]*/);
  return match ? match[0] : '';
}

/**
 * Find the end position (exclusive) of the element starting at tagStart.
 * Handles nesting by counting open/close pairs for tagName.
 */
function findElementEnd(html: string, tagStart: number, tagName: string): number | null {
  const openPattern = `<${tagName}`;
  const closePattern = `</${tagName}>`;

  const firstClose = html.indexOf('>', tagStart);
  if (firstClose === -1) return null;
  // Self-closing tag (e.g. <input/>) — element ends right after '>'
  if (html[firstClose - 1] === '/') return firstClose + 1;

  let depth = 1;
  let pos = firstClose + 1;

  while (pos < html.length) {
    const nextOpen = html.indexOf(openPattern, pos);
    const nextClose = html.indexOf(closePattern, pos);

    if (nextClose === -1) return null;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Make sure the "open" is actually a new tag and not a substring match
      const after = html.charAt(nextOpen + openPattern.length);
      if (after === ' ' || after === '>' || after === '/' || after === '\t' || after === '\n') {
        depth += 1;
      }
      pos = nextOpen + openPattern.length;
    } else {
      depth -= 1;
      if (depth === 0) return nextClose + closePattern.length;
      pos = nextClose + closePattern.length;
    }
  }
  return null;
}

function processIterateDirective(html: string, data: unknown): string {
  const MARKER = ' cl-iterate="';
  let result = html;

  while (true) {
    const attrPos = result.indexOf(MARKER);
    if (attrPos === -1) break;

    const tagStart = findTagStart(result, attrPos);
    if (tagStart === null) break;

    const tagName = extractTagName(result, tagStart);
    if (!tagName) break;

    const valStart = attrPos + MARKER.length;
    const valEnd = result.indexOf('"', valStart);
    if (valEnd === -1) break;
    const attrValue = result.slice(valStart, valEnd);

    const parts = attrValue.split(/\s+/);
    if (parts.length !== 3 || parts[1] !== 'in') break;
    const itemVar = parts[0];
    const arrayPath = parts[2];

    const elementEnd = findElementEnd(result, tagStart, tagName);
    if (elementEnd === null) break;

    const openTagEnd = result.indexOf('>', tagStart);
    if (openTagEnd === -1) break;
    const innerStart = openTagEnd + 1;
    const innerEnd = elementEnd - (tagName.length + 3); // </name>
    const inner = result.slice(innerStart, innerEnd);

    const items = getNestedValue(data, arrayPath);
    const array: unknown[] = Array.isArray(items) ? items : [];

    let expanded = '';
    for (const item of array) {
      let itemHtml = inner;
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        for (const [field, value] of Object.entries(item as Record<string, unknown>)) {
          const placeholder = `{${itemVar}.${field}}`;
          const replacement =
            value === null || value === undefined ? '' : String(value);
          itemHtml = itemHtml.split(placeholder).join(replacement);
        }
      }
      const scalarPlaceholder = `{${itemVar}}`;
      const scalar =
        item === null || item === undefined ? '' : String(item);
      itemHtml = itemHtml.split(scalarPlaceholder).join(scalar);
      expanded += itemHtml;
    }

    result = result.slice(0, tagStart) + expanded + result.slice(elementEnd);
  }

  return result;
}

function processIfDirective(html: string, data: unknown): string {
  const MARKER = ' cl-if="';
  let result = html;

  while (true) {
    const attrPos = result.indexOf(MARKER);
    if (attrPos === -1) break;

    const tagStart = findTagStart(result, attrPos);
    if (tagStart === null) break;
    const tagName = extractTagName(result, tagStart);
    if (!tagName) break;

    const valStart = attrPos + MARKER.length;
    const valEnd = result.indexOf('"', valStart);
    if (valEnd === -1) break;
    const condition = result.slice(valStart, valEnd);
    const isTruthy = evaluateCondition(condition, data);

    const elementEnd = findElementEnd(result, tagStart, tagName);
    if (elementEnd === null) break;
    const attrFull = ` cl-if="${condition}"`;

    // Check for a cl-else sibling element immediately following (ignoring whitespace)
    const after = result.slice(elementEnd);
    const trimmedStart = elementEnd + (after.length - after.trimStart().length);
    const rest = result.slice(trimmedStart);
    let hasElse = false;
    if (rest.startsWith('<')) {
      const tagEnd = rest.indexOf('>');
      if (tagEnd !== -1 && rest.slice(0, tagEnd).includes(' cl-else')) {
        hasElse = true;
      }
    }

    let keep: string;
    let totalEnd: number;

    if (hasElse) {
      const elseTagStart = trimmedStart;
      const elseTagName = extractTagName(result, elseTagStart);
      const elseElementEnd = findElementEnd(result, elseTagStart, elseTagName) ?? elseTagStart;

      if (isTruthy) {
        // Keep the full element with attrs (minus cl-if), drop the cl-else sibling
        keep = result.slice(tagStart, elementEnd).replace(attrFull, '');
        totalEnd = elseElementEnd;
      } else {
        // Drop the cl-if element, keep the cl-else sibling (minus cl-else attr)
        keep = result.slice(elseTagStart, elseElementEnd).replace(' cl-else', '');
        totalEnd = elseElementEnd;
      }
    } else if (isTruthy) {
      // SRV-CLIF-STRIP fix: keep the full element + attrs, only strip the cl-if attribute
      keep = result.slice(tagStart, elementEnd).replace(attrFull, '');
      totalEnd = elementEnd;
    } else {
      keep = '';
      totalEnd = elementEnd;
    }

    result = result.slice(0, tagStart) + keep + result.slice(totalEnd);
  }

  return result;
}

function processShowDirective(html: string, data: unknown): string {
  const MARKER = ' cl-show="';
  let result = html;

  while (true) {
    const attrPos = result.indexOf(MARKER);
    if (attrPos === -1) break;

    const valStart = attrPos + MARKER.length;
    const valEnd = result.indexOf('"', valStart);
    if (valEnd === -1) break;
    const condition = result.slice(valStart, valEnd);
    const isTruthy = evaluateCondition(condition, data);

    const attrFull = ` cl-show="${condition}"`;
    if (isTruthy) {
      result = result.replace(attrFull, '');
      continue;
    }

    const tagStart = findTagStart(result, attrPos);
    if (tagStart === null) break;
    const tagEnd = result.indexOf('>', tagStart);
    if (tagEnd === -1) break;
    const openingTag = result.slice(tagStart, tagEnd + 1);
    let newTag: string;
    if (openingTag.includes('style="')) {
      newTag = openingTag
        .replace(attrFull, '')
        .replace('style="', 'style="display:none;');
    } else {
      newTag = openingTag
        .replace(attrFull, '')
        .replace('>', ' style="display:none;">');
    }
    result = result.slice(0, tagStart) + newTag + result.slice(tagEnd + 1);
  }

  return result;
}

function processDirectives(html: string, data: unknown): string {
  let result = processIterateDirective(html, data);
  result = processIfDirective(result, data);
  result = processShowDirective(result, data);
  return result;
}

function extractAttrValueFromTag(tag: string, attr: string): string | undefined {
  const search = `${attr}="`;
  const start = tag.indexOf(search);
  if (start === -1) return undefined;
  const valStart = start + search.length;
  const valEnd = tag.indexOf('"', valStart);
  if (valEnd === -1) return undefined;
  return tag.slice(valStart, valEnd);
}

/**
 * Replace custom component element tags with their registered server-side HTML.
 *
 * For each <tag-name [attrs]>...</tag-name> where tag-name contains a hyphen:
 * - Registered: emit <div data-island="tag-name" data-client="MODE">HTML</div>
 * - Unregistered with client= attr: emit <div data-island=...></div> wrapper
 * - Otherwise leave unchanged.
 */
function expandComponentTags(html: string, registry: Map<string, string>): string {
  let result = html;
  let offset = 0;

  while (true) {
    const remaining = result.slice(offset);
    const relOpen = remaining.indexOf('<');
    if (relOpen === -1) break;
    const absOpen = offset + relOpen;

    const afterOpen = result.slice(absOpen + 1);
    const tagEndInName = afterOpen.search(/[ \t\n>/]/);
    if (tagEndInName === -1) {
      offset = absOpen + 1;
      continue;
    }
    const tagName = afterOpen.slice(0, tagEndInName).trim();

    if (!tagName.includes('-') || tagName.startsWith('/')) {
      offset = absOpen + 1;
      continue;
    }

    const closeBracket = result.indexOf('>', absOpen);
    if (closeBracket === -1) {
      offset = absOpen + 1;
      continue;
    }

    const openingTag = result.slice(absOpen, closeBracket + 1);
    const selfClosing = openingTag.endsWith('/>');
    const clientVal = extractAttrValueFromTag(openingTag, 'client');

    let innerHtml = '';
    let elementEnd: number;
    if (selfClosing) {
      elementEnd = closeBracket + 1;
    } else {
      const closeTag = `</${tagName}>`;
      const rel = result.indexOf(closeTag, closeBracket + 1);
      if (rel === -1) {
        offset = absOpen + 1;
        continue;
      }
      innerHtml = result.slice(closeBracket + 1, rel);
      elementEnd = rel + closeTag.length;
    }

    let replacement: string;
    const registered = registry.get(tagName);
    if (registered !== undefined) {
      const mode = clientVal ?? 'on';
      replacement = `<div data-island="${tagName}" data-client="${mode}">${registered}</div>`;
    } else if (clientVal !== undefined) {
      replacement = `<div data-island="${tagName}" data-client="${clientVal}">${innerHtml}</div>`;
    } else {
      offset = absOpen + 1;
      continue;
    }

    result = result.slice(0, absOpen) + replacement + result.slice(elementEnd);
    offset = absOpen + replacement.length;
  }

  return result;
}

/**
 * Inject the frame.ui runtime loader <script src="/loader.js" defer></script> into
 * the rendered document when at least one hydration island wrapper is present.
 *
 * Idempotent: documents already referencing /loader.js are returned unchanged.
 * Placement: inserted before the last </body> tag (case-insensitive); if no
 * </body> exists, appended to the end of the document.
 */
function injectLoaderScript(html: string): string {
  if (!html.includes('data-island="')) return html;
  if (html.includes('/loader.js')) return html;

  const SCRIPT_TAG = '<script src="/loader.js" defer data-wasm="/frontend.wasm"></script>';
  const lower = html.toLowerCase();
  const pos = lower.lastIndexOf('</body>');
  if (pos !== -1) {
    return html.slice(0, pos) + SCRIPT_TAG + html.slice(pos);
  }
  return html + SCRIPT_TAG;
}

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

    // DOM query — §FEXT-2 (browser-only; returns LP empty string on server)
    _ui_get_bounds: noop,
    _ui_get_offset_bounds: noop,
    _ui_get_scroll: noop,
    _ui_set_scroll: noop,
    _ui_query_all: noop,
    _ui_get_computed_style: noop,

    // DOM patching — §FEXT-5 (browser-only no-op on server)
    _ui_patch: noop,

    // iframe communication — §FEXT-3 (browser-only no-op on server)
    _ui_iframe_send: noop,
    _ui_iframe_on_message: noop,
    _ui_iframe_get_bounds: noop,
    _ui_iframe_inject: noop,

    // Drag data — §FEXT-1 (browser-only no-op on server)
    _ui_set_drag_data: noop,
    _ui_get_drag_data: noop,
    _ui_event_data_json: noop,

    // Compiler-owned build_state keystore — no-op at runtime
    // (registered at compile time by WasmPluginAdapter; runtime stub exists
    // so WASM modules referencing them can instantiate)
    _build_state_get: noop,
    _build_state_set: noop,

    // Browser-only frame.ui extensions — SSR-safe no-ops
    // (these are declared hosts = ["browser"] in the registry; the host
    // contract test still requires them registered so apps targeting any
    // host can instantiate against this linker)
    _ui_clipboard_read_cb: noop,
    _ui_clipboard_write_cb: noop,
    _ui_download_text: noop,
    _ui_download_url: noop,
    _ui_focus_trap: noop,
    _ui_focus_trap_release: noop,
    _ui_history_back: noop,
    _ui_history_forward: noop,
    _ui_history_push: noop,
    _ui_history_replace: noop,
    _ui_intersect_observe: noop,
    _ui_intersect_unobserve: noop,
    _ui_navigate: noop,
    _ui_resize_observe: noop,
    _ui_resize_unobserve: noop,
    _ui_shortcut_clear: noop,
    _ui_shortcut_register: noop,
    _ui_shortcut_remove: noop,
    _ui_toast: noop,
    _ui_toast_dismiss: noop,
    _ui_toast_dismiss_all: noop,

    // Browser-only frame.client API helpers — SSR-safe no-ops
    _api_auth: noop,
    _api_body: noop,
    _api_clearAuth: noop,
    _api_delete: noop,
    _api_get: noop,
    _api_header: noop,
    _api_json: noop,
    _api_ok: noop,
    _api_patch: noop,
    _api_post: noop,
    _api_put: noop,
    _api_responseHeader: noop,
    _api_status: noop,
    _api_submit: noop,
    _api_timeout: noop,

    // Browser-only Server-Sent Events feed — SSR-safe no-ops
    _feed_close: noop,
    _feed_connId: noop,
    _feed_data: noop,
    _feed_eventType: noop,
    _feed_lastId: noop,
    _feed_on: noop,
    _feed_open: noop,

    // Browser-only LIVE-endpoint client — SSR-safe no-ops
    _live_close: noop,
    _live_closeCode: noop,
    _live_closeReason: noop,
    _live_connId: noop,
    _live_error: noop,
    _live_message: noop,
    _live_open: noop,
    _live_send: noop,
    _live_state: noop,

    // Browser storage (localStorage / sessionStorage) — no-op on server
    _storage_local_get: noop,
    _storage_local_set: noop,
    _storage_local_remove: noop,
    _storage_local_clear: noop,
    _storage_session_get: noop,
    _storage_session_set: noop,
    _storage_session_remove: noop,
    _storage_session_clear: noop,

    // Focus / selection / CSS-var helpers — no-op on server
    _ui_focus: noop,
    _ui_blur: noop,
    _ui_get_focus: noop,
    _ui_get_selection: noop,
    _ui_insert_at_cursor: noop,
    _ui_text_diff: noop,
    _ui_set_css_var: noop,
    _ui_set_css_var_on: noop,
    _ui_get_css_var: noop,
    _ui_apply_css_vars: noop,
    _ui_current_path: noop,
    _ui_form_submit: noop,

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
    'ui.inputValue': noop,
    'ui.formJson': noop,
    'ui.formData': noop,
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

    // DOM query dot-notation (§FEXT-2)
    'ui.getBounds': noop,
    'ui.getOffsetBounds': noop,
    'ui.getScroll': noop,
    'ui.setScroll': noop,
    'ui.queryAll': noop,
    'ui.getComputedStyle': noop,

    // iframe communication dot-notation (§FEXT-3)
    'ui.iframeSend': noop,
    'ui.iframeOnMessage': noop,
    'ui.iframeGetBounds': noop,
    'ui.iframeInject': noop,

    // Drag data dot-notation (§FEXT-1)
    'ui.setDragData': noop,
    'ui.getDragData': noop,
    'ui.eventDataJson': noop,
  };

  return stubs;
}

/**
 * Create UI bridge functions
 */
export function createUiBridge(getState: () => WasmState) {
  return {
    /**
     * Load an HTML layout file. Caller provides the full relative path from
     * project root (e.g. "app/ui/layouts/main.html"). Path construction is
     * the caller's responsibility.
     *
     * Returns a pointer to the HTML contents string, or an empty string if the
     * file does not exist or cannot be read.
     */
    _ui_load_layout(layoutNamePtr: number, layoutNameLen: number): number {
      const state = getState();
      const layoutPath = readString(state, layoutNamePtr, layoutNameLen);

      if (!layoutPath.trim()) {
        log(state, 'UI', 'Attempted to load layout with empty path');
        return writeString(state, '');
      }

      const projectRoot = getProjectRoot(state);
      const resolved = path.resolve(projectRoot, layoutPath);

      // Ensure the resolved path stays within the project root (prevent traversal)
      if (!resolved.startsWith(projectRoot)) {
        log(state, 'UI', `Layout path traversal blocked: ${layoutPath}`);
        return writeString(state, '');
      }

      if (!fs.existsSync(resolved)) {
        log(state, 'UI', `Layout not found: ${resolved}`);
        return writeString(state, '');
      }

      try {
        const contents = fs.readFileSync(resolved, 'utf8');
        log(state, 'UI', `Loaded layout '${layoutPath}' (${contents.length} bytes)`);
        return writeString(state, contents);
      } catch (err) {
        log(state, 'UI', `Failed to read layout '${layoutPath}': ${(err as Error).message}`);
        return writeString(state, '');
      }
    },

    /**
     * Load an HTML page template. Caller provides the full relative path from
     * project root (e.g. "app/ui/pages/index.html"). Path construction is
     * the caller's responsibility.
     *
     * Returns a pointer to the HTML contents string, or an empty string if the
     * file does not exist or cannot be read.
     */
    _ui_load_page(pageNamePtr: number, pageNameLen: number): number {
      const state = getState();
      const pagePath = readString(state, pageNamePtr, pageNameLen);

      if (!pagePath.trim()) {
        log(state, 'UI', 'Attempted to load page with empty path');
        return writeString(state, '');
      }

      const projectRoot = getProjectRoot(state);
      const resolved = path.resolve(projectRoot, pagePath);

      if (!resolved.startsWith(projectRoot)) {
        log(state, 'UI', `Page path traversal blocked: ${pagePath}`);
        return writeString(state, '');
      }

      if (!fs.existsSync(resolved)) {
        log(state, 'UI', `Page not found: ${resolved}`);
        return writeString(state, '');
      }

      try {
        const contents = fs.readFileSync(resolved, 'utf8');
        log(state, 'UI', `Loaded page '${pagePath}' (${contents.length} bytes)`);
        return writeString(state, contents);
      } catch (err) {
        log(state, 'UI', `Failed to read page '${pagePath}': ${(err as Error).message}`);
        return writeString(state, '');
      }
    },

    /**
     * Render an HTML template with {key} substitution. Caller provides the
     * full relative path from project root (e.g. "app/ui/pages/index.html").
     * Path construction is the caller's responsibility.
     *
     * Substitutes all {key} occurrences with the corresponding value from
     * the JSON data string. Missing keys produce an empty string. Returns the
     * rendered HTML as a length-prefixed string pointer, or an empty string on error.
     */
    _ui_render_page(pageNamePtr: number, pageNameLen: number, dataPtr: number, dataLen: number): number {
      const state = getState();
      const pagePath = readString(state, pageNamePtr, pageNameLen);

      if (!pagePath.trim()) {
        log(state, 'UI', 'Attempted to render page with empty path');
        return writeString(state, '');
      }

      const projectRoot = getProjectRoot(state);
      const resolved = path.resolve(projectRoot, pagePath);

      if (!resolved.startsWith(projectRoot)) {
        log(state, 'UI', `Page path traversal blocked: ${pagePath}`);
        return writeString(state, '');
      }

      if (!fs.existsSync(resolved)) {
        log(state, 'UI', `Page not found: ${resolved}`);
        return writeString(state, '');
      }

      let template: string;
      try {
        template = fs.readFileSync(resolved, 'utf8');
      } catch (err) {
        log(state, 'UI', `Failed to read page '${pagePath}': ${(err as Error).message}`);
        return writeString(state, '');
      }

      let data: Record<string, unknown> = {};
      if (dataLen > 0) {
        const dataStr = readString(state, dataPtr, dataLen);
        if (dataStr.trim()) {
          try {
            data = JSON.parse(dataStr);
          } catch {
            log(state, 'UI', `Invalid JSON data for page '${pagePath}' — rendering without substitution`);
          }
        }
      }

      const substituted = template.replace(/\{([\w.]+)\}/g, (_match, key) => {
        const value = getNestedValue(data, key);
        return value !== undefined && value !== null ? String(value) : '';
      });

      const withDirectives = processDirectives(substituted, data);

      const registry = state.componentRegistry ?? new Map<string, string>();
      const withComponents = expandComponentTags(withDirectives, registry);

      const rendered = injectLoaderScript(withComponents);

      log(state, 'UI', `Rendered page '${pagePath}' (${rendered.length} bytes)`);
      return writeString(state, rendered);
    },

    /**
     * Register a component's server-side HTML template.
     *
     * Called by the frame.ui plugin during WASM init so that _ui_render_page can
     * expand custom element tags (e.g. <my-widget>) into <div data-island> wrappers
     * with the registered HTML as inner content.
     *
     * @returns 1 on success, 0 on error
     */
    _ui_register_component_html(
      tagPtr: number,
      tagLen: number,
      htmlPtr: number,
      htmlLen: number
    ): number {
      const state = getState();
      const tag = readString(state, tagPtr, tagLen);
      if (!tag) {
        log(state, 'UI', '_ui_register_component_html: empty or missing tag name');
        return 0;
      }
      const html = readString(state, htmlPtr, htmlLen);
      if (!state.componentRegistry) {
        state.componentRegistry = new Map<string, string>();
      }
      state.componentRegistry.set(tag, html);
      log(state, 'UI', `_ui_register_component_html: registered <${tag}>`);
      return 1;
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

    /**
     * Inject a <link rel="stylesheet" href="..."> into the response <head>.
     *
     * Deduplicated by href — calling multiple times with the same href produces
     * only one <link> tag.  The server's response builder checks state.injectedLinks
     * before sending HTML responses.
     *
     * Returns 1 on success.
     */
    _ui_inject_head_link(hrefPtr: number, hrefLen: number): number {
      const state = getState();
      const href = readString(state, hrefPtr, hrefLen);

      if (!state.injectedLinks) {
        state.injectedLinks = [];
      }

      if (!state.injectedLinks.includes(href)) {
        state.injectedLinks.push(href);
        log(state, 'UI', `Injected head link: ${href}`);
      }

      return 1;
    },
  };
}
