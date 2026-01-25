# Clean Node Server

Node.js host bridge for Clean Language WASM modules. This provides feature parity with the Rust `clean-server`, allowing Clean Language applications to run on Node.js.

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
# Basic usage
clean-node-server <wasm-file>

# With options
clean-node-server app.wasm --port 3000 --verbose

# With database
clean-node-server app.wasm --database "postgresql://user:pass@localhost/db"

# Full options
clean-node-server app.wasm \
  --port 8080 \
  --host 0.0.0.0 \
  --database "sqlite:///data/app.db" \
  --verbose \
  --session-secret "your-secret-key" \
  --jwt-secret "your-jwt-secret"
```

## Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--port` | `-p` | 3000 | Port to listen on |
| `--host` | `-h` | 0.0.0.0 | Host to bind to |
| `--database` | `-d` | - | Database connection URL |
| `--verbose` | `-v` | false | Enable verbose logging |
| `--session-secret` | - | auto | Secret key for sessions |
| `--jwt-secret` | - | auto | Secret key for JWT tokens |
| `--sandbox` | - | wasm dir | Root directory for file operations |

## Supported Database URLs

- **PostgreSQL**: `postgresql://user:pass@host:port/database`
- **SQLite**: `sqlite:///path/to/database.db` or `sqlite::memory:`

## Bridge Functions

The following bridge functions are available to WASM modules:

### Console
- `print(ptr, len)` - Print string without newline
- `printl(ptr, len)` - Print string with newline
- `print_integer(value)` - Print integer
- `print_float(value)` - Print float
- `print_boolean(value)` - Print boolean

### Math
All standard math functions: `sin`, `cos`, `tan`, `sqrt`, `pow`, `abs`, `floor`, `ceil`, `round`, `log`, `exp`, etc.

### String
- `string_concat`, `string_substring`, `string_trim`
- `string_to_upper`, `string_to_lower`
- `string_replace`, `string_split`, `string_index_of`
- Type conversions: `int_to_string`, `float_to_string`, `string_to_int`, etc.

### HTTP Server
- `_http_listen(port)` - Set listening port
- `_http_route(method, path, handler)` - Register route
- `_http_route_protected(...)` - Register protected route
- `_http_set_status(code)` - Set response status
- `_http_set_header(name, value)` - Set response header
- `_http_json(body)` - Send JSON response
- `_http_redirect(url, permanent)` - Redirect
- Response helpers: `_http_not_found`, `_http_bad_request`, `_http_unauthorized`, etc.

### Request Context
- `_req_method()` - Get request method
- `_req_path()` - Get request path
- `_req_param(name)` - Get URL parameter
- `_req_query(name)` - Get query parameter
- `_req_body()` - Get request body
- `_req_header(name)` - Get request header
- `_req_cookie(name)` - Get cookie value

### Session Management
- `_session_create(userId, role, claims)` - Create session
- `_session_get()` - Get current session
- `_session_destroy()` - Destroy session
- `_http_set_cookie(name, value, options)` - Set cookie

### Authentication
- `_auth_get_session()` - Get session data
- `_auth_require_auth()` - Check if authenticated
- `_auth_require_role(role)` - Check role
- `_auth_hash_password(password)` - Hash password (bcrypt)
- `_auth_verify_password(password, hash)` - Verify password

### Cryptography
- `_jwt_sign(payload, secret, expiresIn)` - Sign JWT
- `_jwt_verify(token, secret)` - Verify JWT
- `_crypto_random_hex(bytes)` - Generate random hex
- `_crypto_hash_sha256(data)` - SHA-256 hash
- `_crypto_encrypt_aes(data, key)` - AES encryption
- `_crypto_decrypt_aes(encrypted, key)` - AES decryption

### Database
- `_db_query(sql, params)` - Execute query
- `_db_execute(sql, params)` - Execute statement
- `_db_begin()` - Begin transaction
- `_db_commit(txId)` - Commit transaction
- `_db_rollback(txId)` - Rollback transaction

### HTTP Client
- `http_get(url)` - HTTP GET
- `http_post(url, body)` - HTTP POST
- `http_put(url, body)` - HTTP PUT
- `http_delete(url)` - HTTP DELETE
- `http_get_with_headers(url, headers)` - GET with custom headers

### File I/O
- `file_read(path)` - Read file
- `file_write(path, data)` - Write file
- `file_exists(path)` - Check if file exists
- `file_delete(path)` - Delete file
- `file_list_dir(path)` - List directory

### Environment
- `_env_get(name)` - Get environment variable
- `_env_is_production()` - Check if production

### Time
- `_time_now()` - Get current time
- `_time_epoch_ms()` - Get Unix timestamp (ms)
- `_time_format_iso(epoch)` - Format as ISO string
- `_time_parse_iso(iso)` - Parse ISO string

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Development mode (with ts-node)
npm run dev -- app.wasm --verbose
```

## Architecture

```
src/
├── index.ts          # CLI entry point
├── server.ts         # Express HTTP server
├── wasm/
│   ├── instance.ts   # WASM module loading
│   ├── state.ts      # Per-request state
│   └── memory.ts     # Memory helpers
├── bridge/
│   ├── index.ts      # Bridge assembly
│   ├── console.ts    # Print functions
│   ├── math.ts       # Math operations
│   ├── string.ts     # String operations
│   ├── http-server.ts# Route registration
│   ├── request.ts    # Request context
│   ├── session.ts    # Session management
│   ├── auth.ts       # Authentication
│   ├── crypto.ts     # Cryptography
│   ├── database.ts   # Database operations
│   ├── http-client.ts# Outbound HTTP
│   ├── file.ts       # File I/O
│   ├── env.ts        # Environment
│   └── time.ts       # Time operations
├── router/
│   └── index.ts      # Route registry
├── session/
│   └── store.ts      # Session store
├── database/
│   ├── index.ts      # Driver factory
│   ├── postgres.ts   # PostgreSQL driver
│   └── sqlite.ts     # SQLite driver
└── types/
    └── index.ts      # TypeScript interfaces
```

## Memory Format

Strings between WASM and the host use a length-prefixed format:

```
[4-byte LE length][UTF-8 bytes]
```

When passing strings from WASM to the host (function arguments), raw `(ptr, len)` pairs are used.

When returning strings from the host to WASM, the host allocates memory using the WASM module's exported `malloc` function and writes the length-prefixed string.

## License

MIT
