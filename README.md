# Clean Node Server

A Node.js runtime for Clean Language applications. Run your compiled Clean Language WebAssembly modules with full access to HTTP servers, databases, file systems, and more.

## What is this?

Clean Node Server lets you run Clean Language `.wasm` files on any machine with Node.js. It provides all the "bridge functions" your Clean code needs to interact with the outside world - things like:

- Starting a web server and handling HTTP requests
- Connecting to PostgreSQL or SQLite databases
- Reading and writing files
- Making HTTP requests to other services
- User authentication with sessions and JWT tokens
- And much more!

## Quick Start

### Installation

```bash
npm install -g @ivan-pasco/clean-node-server
```

Or use it directly with npx:

```bash
npx @ivan-pasco/clean-node-server your-app.wasm
```

### Running Your First App

Once you've compiled your Clean Language code to WebAssembly:

```bash
clean-node-server my-app.wasm
```

That's it! Your app is now running on http://localhost:3000

### Common Options

```bash
# Run on a different port
clean-node-server my-app.wasm --port 8080

# Connect to a database
clean-node-server my-app.wasm --database "postgresql://user:pass@localhost/mydb"

# See what's happening under the hood
clean-node-server my-app.wasm --verbose
```

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | First steps with Clean Node Server |
| [HTTP Server](docs/http-server.md) | Building web APIs and handling requests |
| [Database](docs/database.md) | Working with PostgreSQL and SQLite |
| [Authentication](docs/authentication.md) | Sessions, passwords, and JWT tokens |
| [File System](docs/files.md) | Reading and writing files |
| [HTTP Client](docs/http-client.md) | Making requests to external services |
| [All Functions](docs/functions-reference.md) | Complete reference of available functions |

## Command Line Options

| Option | Short | Default | What it does |
|--------|-------|---------|--------------|
| `--port` | `-p` | 3000 | Which port to listen on |
| `--host` | `-h` | 0.0.0.0 | Which network interface to use |
| `--database` | `-d` | none | Database connection URL |
| `--verbose` | `-v` | off | Print detailed logs |
| `--session-secret` | | auto | Secret for encrypting sessions |
| `--jwt-secret` | | auto | Secret for signing JWT tokens |
| `--sandbox` | | wasm dir | Root folder for file operations |

## Database Connection URLs

**PostgreSQL:**
```
postgresql://username:password@hostname:5432/database_name
```

**SQLite (file):**
```
sqlite:///path/to/database.db
```

**SQLite (in memory):**
```
sqlite::memory:
```

## Example: A Simple API

Here's what a Clean Language API might look like:

```clean
// Define a route that returns JSON
function handleHealth(): string {
    return _http_json('{"status": "ok", "message": "Server is running!"}')
}

// Set up the server
function main(): void {
    _http_route("GET", "/health", handleHealth)
    _http_listen(3000)
    print("Server started on port 3000")
}
```

Compile it and run:

```bash
clean-node-server my-api.wasm --verbose
```

Then visit http://localhost:3000/health to see your API in action!

## Project Structure

```
src/
├── index.ts          # CLI - where it all starts
├── server.ts         # The Express HTTP server
├── bridge/           # All the functions your Clean code can call
│   ├── console.ts    # print, printl, etc.
│   ├── http-server.ts# Routes and responses
│   ├── request.ts    # Reading request data
│   ├── database.ts   # SQL queries
│   ├── auth.ts       # Authentication helpers
│   ├── crypto.ts     # Encryption and hashing
│   ├── file.ts       # File operations
│   └── ...more
├── wasm/             # WebAssembly loading and management
├── router/           # Route matching logic
├── session/          # Session storage
└── database/         # Database drivers
```

## Development

Want to contribute or run from source?

```bash
# Clone the repo
git clone https://github.com/Ivan-Pasco/clean-node-server.git
cd clean-node-server

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Try it out
npm run dev -- path/to/your-app.wasm --verbose
```

## Requirements

- Node.js 18 or later
- Your compiled Clean Language `.wasm` files

## License

MIT - Use it however you like!

## Links

- [npm package](https://www.npmjs.com/package/@ivan-pasco/clean-node-server)
- [GitHub repository](https://github.com/Ivan-Pasco/clean-node-server)
- [Report an issue](https://github.com/Ivan-Pasco/clean-node-server/issues)
