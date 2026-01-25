# Functions Reference

This is a complete list of all functions available to your Clean Language code when running on Clean Node Server.

## Console Output

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `print` | `message: string` | void | Print text (no newline) |
| `printl` | `message: string` | void | Print text with newline |
| `print_integer` | `value: integer` | void | Print an integer |
| `print_float` | `value: number` | void | Print a float/number |
| `print_boolean` | `value: boolean` | void | Print true or false |
| `print_error` | `message: string` | void | Print to stderr |
| `print_debug` | `message: string` | void | Print debug message (only in verbose mode) |

```clean
print("Hello ")
printl("World!")      // "Hello World!\n"
print_integer(42)     // "42"
print_float(3.14)     // "3.14"
print_boolean(true)   // "true"
```

## Console Input

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `input` | `prompt: string` | string | Prompt for text input |
| `input_integer` | `prompt: string` | integer | Prompt for integer input |
| `input_float` | `prompt: string` | number | Prompt for float input |
| `input_yesno` | `prompt: string` | boolean | Prompt for yes/no input |
| `input_range` | `prompt: string, min: integer, max: integer` | integer | Prompt for number in range |

## Math Functions

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `math_pow` | `base: number, exp: number` | number | Power (base^exp) |
| `math_sqrt` | `x: number` | number | Square root |
| `math_cbrt` | `x: number` | number | Cube root |
| `math_abs` | `x: number` | number | Absolute value |
| `math_floor` | `x: number` | number | Round down |
| `math_ceil` | `x: number` | number | Round up |
| `math_round` | `x: number` | number | Round to nearest |
| `math_trunc` | `x: number` | number | Truncate decimal |
| `math_sign` | `x: number` | number | Sign (-1, 0, or 1) |
| `math_min` | `a: number, b: number` | number | Minimum of two numbers |
| `math_max` | `a: number, b: number` | number | Maximum of two numbers |
| `math_random` | none | number | Random number 0-1 |

### Trigonometry

| Function | Description |
|----------|-------------|
| `math_sin(x)` | Sine |
| `math_cos(x)` | Cosine |
| `math_tan(x)` | Tangent |
| `math_asin(x)` | Arc sine |
| `math_acos(x)` | Arc cosine |
| `math_atan(x)` | Arc tangent |
| `math_atan2(y, x)` | Arc tangent of y/x |
| `math_sinh(x)` | Hyperbolic sine |
| `math_cosh(x)` | Hyperbolic cosine |
| `math_tanh(x)` | Hyperbolic tangent |

### Logarithms

| Function | Description |
|----------|-------------|
| `math_log(x)` | Natural logarithm |
| `math_ln(x)` | Natural logarithm (alias) |
| `math_log10(x)` | Base-10 logarithm |
| `math_log2(x)` | Base-2 logarithm |
| `math_exp(x)` | e^x |

### Constants

| Function | Returns |
|----------|---------|
| `math_pi()` | 3.14159... |
| `math_e()` | 2.71828... |

## String Functions

### Type Conversion

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `int_to_string` | `value: integer` | string | Integer to string |
| `string_to_int` | `s: string` | integer | String to integer |
| `float_to_string` | `value: number` | string | Float to string |
| `string_to_float` | `s: string` | number | String to float |
| `bool_to_string` | `value: boolean` | string | Boolean to string |
| `string_to_bool` | `s: string` | boolean | String to boolean |

### String Operations

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `string_concat` | `a: string, b: string` | string | Concatenate strings |
| `string_length` | `s: string` | integer | String length |
| `string_substring` | `s: string, start: integer, len: integer` | string | Extract substring |
| `string_char_at` | `s: string, index: integer` | string | Get character at index |
| `string_index_of` | `s: string, search: string` | integer | Find first occurrence |
| `string_last_index_of` | `s: string, search: string` | integer | Find last occurrence |
| `string_contains` | `s: string, search: string` | boolean | Check if contains |
| `string_starts_with` | `s: string, prefix: string` | boolean | Check if starts with |
| `string_ends_with` | `s: string, suffix: string` | boolean | Check if ends with |
| `string_trim` | `s: string` | string | Remove whitespace from both ends |
| `string_trim_start` | `s: string` | string | Remove whitespace from start |
| `string_trim_end` | `s: string` | string | Remove whitespace from end |
| `string_to_upper` | `s: string` | string | Convert to uppercase |
| `string_to_lower` | `s: string` | string | Convert to lowercase |
| `string_replace` | `s: string, find: string, replace: string` | string | Replace occurrences |
| `string_split` | `s: string, delimiter: string` | string | Split into JSON array |
| `string_repeat` | `s: string, count: integer` | string | Repeat string n times |
| `string_pad_start` | `s: string, length: integer, pad: string` | string | Pad start to length |
| `string_pad_end` | `s: string, length: integer, pad: string` | string | Pad end to length |
| `string_compare` | `a: string, b: string` | integer | Compare strings (-1, 0, 1) |
| `string_equals` | `a: string, b: string` | boolean | Check equality |

## HTTP Server

### Route Registration

| Function | Parameters | Description |
|----------|------------|-------------|
| `_http_route` | `method: string, path: string, handler: function` | Register a route |
| `_http_route_protected` | `method: string, path: string, handler: function, role: string` | Register protected route |
| `_http_listen` | `port: integer` | Set listening port |

### Response Functions

| Function | Parameters | Description |
|----------|------------|-------------|
| `_http_json` | `body: string` | Send JSON response |
| `_http_html` | `body: string` | Send HTML response |
| `_http_text` | `body: string` | Send plain text response |
| `_http_respond` | `status: integer, contentType: string, body: string` | Send custom response |
| `_http_set_status` | `code: integer` | Set status code |
| `_http_set_header` | `name: string, value: string` | Set response header |
| `_http_set_body` | `body: string` | Set response body |
| `_http_redirect` | `url: string, permanent: integer` | Redirect to URL |

### Error Responses

| Function | Parameters | Description |
|----------|------------|-------------|
| `_http_not_found` | `message: string` | 404 Not Found |
| `_http_bad_request` | `message: string` | 400 Bad Request |
| `_http_unauthorized` | `message: string` | 401 Unauthorized |
| `_http_forbidden` | `message: string` | 403 Forbidden |
| `_http_server_error` | `message: string` | 500 Internal Server Error |

## Request Context

### Request Info

| Function | Returns | Description |
|----------|---------|-------------|
| `_req_method()` | string | HTTP method (GET, POST, etc.) |
| `_req_path()` | string | Request path |
| `_req_content_type()` | string | Content-Type header |
| `_req_is_json()` | integer | 1 if JSON content type |

### Parameters and Data

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `_req_param` | `name: string` | string | URL parameter |
| `_req_param_int` | `name: string` | integer | URL parameter as integer |
| `_req_params` | none | string | All URL params as JSON |
| `_req_query` | `name: string` | string | Query string parameter |
| `_req_queries` | none | string | All query params as JSON |
| `_req_body` | none | string | Request body |
| `_req_body_field` | `name: string` | string | Field from JSON body |
| `_req_json` | none | string | Body parsed as JSON |

### Headers and Cookies

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `_req_header` | `name: string` | string | Request header value |
| `_req_headers` | none | string | All headers as JSON |
| `_req_has_header` | `name: string` | integer | 1 if header exists |
| `_req_cookie` | `name: string` | string | Cookie value |
| `_req_cookies` | none | string | All cookies as JSON |
| `_req_has_cookie` | `name: string` | integer | 1 if cookie exists |

### Authentication

| Function | Returns | Description |
|----------|---------|-------------|
| `_req_auth_token()` | string | Bearer token from Authorization header |
| `_req_has_auth()` | integer | 1 if Authorization header present |

## Session Management

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `_session_create` | `userId: string, role: string, claims: string` | string | Create session |
| `_session_get` | none | string | Get current session |
| `_session_destroy` | none | void | Destroy current session |
| `_http_set_cookie` | `name: string, value: string, options: string` | void | Set a cookie |

## Authentication

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `_auth_hash_password` | `password: string` | string | Hash password (bcrypt) |
| `_auth_verify_password` | `password: string, hash: string` | integer | Verify password (1=match) |
| `_auth_get_session` | none | string | Get session data |
| `_auth_require_auth` | none | integer | Check if authenticated |
| `_auth_require_role` | `role: string` | integer | Check if has role |

## JWT Tokens

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `_jwt_sign` | `payload: string, secret: string, expiresIn: string` | string | Create JWT |
| `_jwt_verify` | `token: string, secret: string` | string | Verify JWT, returns payload |

## Cryptography

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `_crypto_random_hex` | `bytes: integer` | string | Random hex string |
| `_crypto_hash_sha256` | `data: string` | string | SHA-256 hash |
| `_crypto_encrypt_aes` | `data: string, key: string` | string | AES encrypt |
| `_crypto_decrypt_aes` | `encrypted: string, key: string` | string | AES decrypt |

## Database

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `_db_query` | `sql: string, params: string` | string | SELECT query, returns JSON |
| `_db_execute` | `sql: string, params: string` | string | INSERT/UPDATE/DELETE |
| `_db_begin` | none | string | Begin transaction |
| `_db_commit` | `txId: string` | void | Commit transaction |
| `_db_rollback` | `txId: string` | void | Rollback transaction |

## HTTP Client

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `http_get` | `url: string` | string | GET request |
| `http_post` | `url: string, body: string` | string | POST request |
| `http_put` | `url: string, body: string` | string | PUT request |
| `http_patch` | `url: string, body: string` | string | PATCH request |
| `http_delete` | `url: string` | string | DELETE request |
| `http_get_with_headers` | `url: string, headers: string` | string | GET with headers |
| `http_post_json` | `url: string, body: string` | string | POST with JSON content-type |
| `http_set_timeout` | `ms: integer` | void | Set request timeout |
| `http_get_response_code` | none | integer | Last response status |
| `http_get_response_headers` | none | string | Last response headers |
| `http_encode_url` | `str: string` | string | URL encode |
| `http_decode_url` | `str: string` | string | URL decode |
| `http_build_query` | `params: string` | string | Build query string |

## File I/O

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `file_read` | `path: string` | string | Read file |
| `file_write` | `path: string, data: string` | void | Write file |
| `file_append` | `path: string, data: string` | void | Append to file |
| `file_exists` | `path: string` | integer | 1 if exists |
| `file_delete` | `path: string` | void | Delete file |
| `file_size` | `path: string` | integer | File size in bytes |
| `file_list_dir` | `path: string` | string | List directory as JSON |
| `file_mkdir` | `path: string` | void | Create directory |
| `file_copy` | `src: string, dst: string` | void | Copy file |
| `file_rename` | `old: string, new: string` | void | Rename/move file |

## Environment

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `_env_get` | `name: string` | string | Get environment variable |
| `_env_is_production` | none | integer | 1 if NODE_ENV=production |

## Time and Date

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `_time_now` | none | string | Current time as ISO string |
| `_time_epoch_ms` | none | integer | Unix timestamp in milliseconds |
| `_time_format_iso` | `epoch: integer` | string | Format timestamp as ISO |
| `_time_parse_iso` | `iso: string` | integer | Parse ISO string to timestamp |

```clean
string now = _time_now()           // "2024-01-15T10:30:00.000Z"
integer ts = _time_epoch_ms()       // 1705315800000
string iso = _time_format_iso(ts)   // "2024-01-15T10:30:00.000Z"
integer parsed = _time_parse_iso(iso) // 1705315800000
```

## Quick Reference by Category

### Building APIs
`_http_route`, `_http_listen`, `_http_json`, `_http_not_found`, `_http_bad_request`

### Reading Requests
`_req_method`, `_req_path`, `_req_param`, `_req_query`, `_req_body`, `_req_body_field`, `_req_header`

### Database
`_db_query`, `_db_execute`, `_db_begin`, `_db_commit`, `_db_rollback`

### Authentication
`_auth_hash_password`, `_auth_verify_password`, `_jwt_sign`, `_jwt_verify`, `_session_create`

### Files
`file_read`, `file_write`, `file_exists`, `file_delete`, `file_list_dir`

### HTTP Client
`http_get`, `http_post`, `http_get_with_headers`, `http_get_response_code`

### Utilities
`print`, `printl`, `_env_get`, `_time_now`, `_time_epoch_ms`
