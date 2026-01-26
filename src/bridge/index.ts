import { WasmState } from '../types';
import { WasmImports } from '../wasm/instance';
import { createConsoleBridge } from './console';
import { createMathBridge } from './math';
import { createStringBridge } from './string';
import { createHttpServerBridge } from './http-server';
import { createRequestBridge } from './request';
import { createSessionBridge } from './session';
import { createAuthBridge } from './auth';
import { createCryptoBridge } from './crypto';
import { createDatabaseBridge } from './database';
import { createHttpClientBridge } from './http-client';
import { createFileBridge } from './file';
import { createEnvBridge } from './env';
import { createTimeBridge } from './time';
import { createMemoryRuntimeBridge } from './memory-runtime';
import { createInputBridge } from './input';
import { readString, writeString } from './helpers';

/**
 * Create all bridge imports for WASM instantiation
 *
 * @param getState - Function to get the current WASM state
 * @returns WASM import object
 */
export function createBridgeImports(getState: () => WasmState): WasmImports {
  // Create all bridge function sets
  const consoleBridge = createConsoleBridge(getState);
  const mathBridge = createMathBridge();
  const stringBridge = createStringBridge(getState);
  const httpServerBridge = createHttpServerBridge(getState);
  const requestBridge = createRequestBridge(getState);
  const sessionBridge = createSessionBridge(getState);
  const authBridge = createAuthBridge(getState);
  const cryptoBridge = createCryptoBridge(getState);
  const databaseBridge = createDatabaseBridge(getState);
  const httpClientBridge = createHttpClientBridge(getState);
  const fileBridge = createFileBridge(getState);
  const envBridge = createEnvBridge(getState);
  const timeBridge = createTimeBridge(getState);
  const memoryRuntimeBridge = createMemoryRuntimeBridge(getState);
  const inputBridge = createInputBridge(getState);

  // Assemble into WASM import object
  // Functions are organized by module namespace
  return {
    // Memory runtime module (separate namespace)
    memory_runtime: {
      ...memoryRuntimeBridge,
    },

    // Main env module with all functions
    env: {
      // Console functions
      print: consoleBridge.print,
      printl: consoleBridge.printl,
      print_integer: consoleBridge.print_integer,
      print_float: consoleBridge.print_float,
      print_boolean: consoleBridge.print_boolean,
      print_error: consoleBridge.print_error,
      print_debug: consoleBridge.print_debug,

      // Input functions
      input: inputBridge.input,
      input_integer: inputBridge.input_integer,
      input_float: inputBridge.input_float,
      input_yesno: inputBridge.input_yesno,
      input_range: inputBridge.input_range,

      // Math functions (all prefixed with math_ or math.)
      math_pow: mathBridge.math_pow,
      math_sin: mathBridge.math_sin,
      math_cos: mathBridge.math_cos,
      math_tan: mathBridge.math_tan,
      math_asin: mathBridge.math_asin,
      math_acos: mathBridge.math_acos,
      math_atan: mathBridge.math_atan,
      math_atan2: mathBridge.math_atan2,
      math_sinh: mathBridge.math_sinh,
      math_cosh: mathBridge.math_cosh,
      math_tanh: mathBridge.math_tanh,
      math_sqrt: mathBridge.math_sqrt,
      math_cbrt: mathBridge.math_cbrt,
      math_exp: mathBridge.math_exp,
      math_exp2: mathBridge.math_exp2,
      math_ln: mathBridge.math_log, // ln is natural log
      math_log: mathBridge.math_log,
      math_log10: mathBridge.math_log10,
      math_log2: mathBridge.math_log2,
      math_abs: mathBridge.math_abs,
      math_floor: mathBridge.math_floor,
      math_ceil: mathBridge.math_ceil,
      math_round: mathBridge.math_round,
      math_trunc: mathBridge.math_trunc,
      math_sign: mathBridge.math_sign,
      math_min: mathBridge.math_min,
      math_max: mathBridge.math_max,
      math_random: mathBridge.math_random,
      math_pi: mathBridge.math_pi,
      math_e: mathBridge.math_e,

      // String functions
      float_to_string: stringBridge.float_to_string,
      string_to_float: stringBridge.string_to_float,
      int_to_string: stringBridge.int_to_string,
      string_to_int: stringBridge.string_to_int,
      bool_to_string: stringBridge.bool_to_string,
      string_to_bool: stringBridge.string_to_bool,
      'string.concat': stringBridge.string_concat,
      'string.split': stringBridge.string_split,
      string_concat: stringBridge.string_concat,
      string_split: stringBridge.string_split,
      string_substring: stringBridge.string_substring,
      string_length: stringBridge.string_length,
      string_trim: stringBridge.string_trim,
      string_trim_start: stringBridge.string_trim_start,
      string_trim_end: stringBridge.string_trim_end,
      string_to_upper: stringBridge.string_to_upper,
      string_to_lower: stringBridge.string_to_lower,
      string_replace: stringBridge.string_replace,
      string_index_of: stringBridge.string_index_of,
      string_last_index_of: stringBridge.string_last_index_of,
      string_contains: stringBridge.string_contains,
      string_starts_with: stringBridge.string_starts_with,
      string_ends_with: stringBridge.string_ends_with,
      string_compare: stringBridge.string_compare,
      string_equals: stringBridge.string_equals,
      string_char_at: stringBridge.string_char_at,
      string_repeat: stringBridge.string_repeat,
      string_pad_start: stringBridge.string_pad_start,
      string_pad_end: stringBridge.string_pad_end,

      // HTTP client functions
      http_get: httpClientBridge.http_get,
      http_post: httpClientBridge.http_post,
      http_put: httpClientBridge.http_put,
      http_patch: httpClientBridge.http_patch,
      http_delete: httpClientBridge.http_delete,
      http_head: httpClientBridge.http_get, // HEAD treated as GET for now
      http_options: httpClientBridge.http_get, // OPTIONS treated as GET for now
      http_get_with_headers: httpClientBridge.http_get_with_headers,
      http_post_with_headers: httpClientBridge.http_post_with_headers,
      http_post_json: httpClientBridge.http_post_json,
      http_put_json: httpClientBridge.http_put,
      http_patch_json: httpClientBridge.http_patch,
      http_post_form: httpClientBridge.http_post,
      http_set_user_agent: httpClientBridge.http_set_user_agent,
      http_set_timeout: httpClientBridge.http_set_timeout,
      http_set_max_redirects: httpClientBridge.http_set_max_redirects,
      http_enable_cookies: httpClientBridge.http_enable_cookies,
      http_get_response_code: httpClientBridge.http_get_response_code,
      http_get_response_headers: httpClientBridge.http_get_response_headers,
      http_encode_url: (ptr: number, len: number) => {
        const state = getState();
        const str = readString(state, ptr, len);
        return writeString(state, encodeURIComponent(str));
      },
      http_decode_url: (ptr: number, len: number) => {
        const state = getState();
        const str = readString(state, ptr, len);
        return writeString(state, decodeURIComponent(str));
      },
      http_build_query: (ptr: number, len: number) => {
        const state = getState();
        const jsonStr = readString(state, ptr, len);
        try {
          const obj = JSON.parse(jsonStr);
          const params = new URLSearchParams(obj);
          return writeString(state, params.toString());
        } catch {
          return writeString(state, '');
        }
      },

      // HTTP server functions
      _http_route: httpServerBridge._http_route,
      _http_listen: httpServerBridge._http_listen,
      _http_route_protected: httpServerBridge._http_route_protected,
      _http_set_status: httpServerBridge._http_set_status,
      _http_set_header: httpServerBridge._http_set_header,
      _http_set_body: httpServerBridge._http_set_body,
      _http_json: httpServerBridge._http_json,
      _http_html: httpServerBridge._http_html,
      _http_text: httpServerBridge._http_text,
      _http_redirect: httpServerBridge._http_redirect,
      _http_not_found: httpServerBridge._http_not_found,
      _http_bad_request: httpServerBridge._http_bad_request,
      _http_unauthorized: httpServerBridge._http_unauthorized,
      _http_forbidden: httpServerBridge._http_forbidden,
      _http_server_error: httpServerBridge._http_server_error,
      _http_respond: httpServerBridge._http_respond,
      _http_set_cache: httpServerBridge._http_set_cache,
      _http_no_cache: httpServerBridge._http_no_cache,
      _json_encode: httpServerBridge._json_encode,
      _json_decode: httpServerBridge._json_decode,

      // Request context functions
      _req_param: requestBridge._req_param,
      _req_param_int: requestBridge._req_param_int,
      _req_query: requestBridge._req_query,
      _req_body: requestBridge._req_body,
      _req_body_field: requestBridge._req_body_field,
      _req_header: requestBridge._req_header,
      _req_method: requestBridge._req_method,
      _req_path: requestBridge._req_path,
      _req_cookie: requestBridge._req_cookie,
      _req_params: requestBridge._req_params,
      _req_queries: requestBridge._req_queries,
      _req_headers: requestBridge._req_headers,
      _req_cookies: requestBridge._req_cookies,
      _req_json: requestBridge._req_json,
      _req_content_type: requestBridge._req_content_type,
      _req_is_json: requestBridge._req_is_json,
      _req_auth_token: requestBridge._req_auth_token,
      _req_has_auth: requestBridge._req_has_auth,
      _req_form: requestBridge._req_form,
      _req_ip: requestBridge._req_ip,

      // File I/O functions
      file_read: fileBridge.file_read,
      file_write: fileBridge.file_write,
      file_exists: fileBridge.file_exists,
      file_delete: fileBridge.file_delete,
      file_append: fileBridge.file_append,
      file_size: fileBridge.file_size,
      file_list_dir: fileBridge.file_list_dir,
      file_mkdir: fileBridge.file_mkdir,
      file_copy: fileBridge.file_copy,
      file_rename: fileBridge.file_rename,

      // Session management
      ...sessionBridge,

      // Authentication
      ...authBridge,

      // Cryptography
      ...cryptoBridge,

      // Database
      ...databaseBridge,

      // Environment variables
      ...envBridge,

      // Time/date functions
      ...timeBridge,

      // Memory management stubs
      __stack_pointer: new WebAssembly.Global(
        { value: 'i32', mutable: true },
        65536
      ),
    },
  };
}

// Re-export individual bridges for testing
export { createConsoleBridge } from './console';
export { createMathBridge } from './math';
export { createStringBridge } from './string';
export { createHttpServerBridge, setRouteRegistry, getRouteRegistry } from './http-server';
export { createRequestBridge } from './request';
export { createSessionBridge } from './session';
export { createAuthBridge } from './auth';
export { createCryptoBridge } from './crypto';
export { createDatabaseBridge } from './database';
export { createHttpClientBridge } from './http-client';
export { createFileBridge, setSandboxRoot } from './file';
export { createEnvBridge } from './env';
export { createTimeBridge } from './time';
export { createMemoryRuntimeBridge, resetMemoryRuntime } from './memory-runtime';
export { createInputBridge } from './input';
