# Getting Started with Clean Node Server

Welcome! This guide will help you get up and running with Clean Node Server in just a few minutes.

## What You'll Need

- **Node.js 18 or later** - Download from [nodejs.org](https://nodejs.org)
- **A compiled Clean Language file** - A `.wasm` file created by the Clean compiler

## Step 1: Install Clean Node Server

You have two options:

### Option A: Install Globally (Recommended)

```bash
npm install -g @ivan-pasco/clean-node-server
```

Now you can use `clean-node-server` from anywhere on your system.

### Option B: Use Without Installing

```bash
npx @ivan-pasco/clean-node-server your-app.wasm
```

This downloads and runs the server in one command. Great for trying things out!

## Step 2: Run Your Application

Got a `.wasm` file? Let's run it:

```bash
clean-node-server my-app.wasm
```

You should see something like:

```
Clean Node Server v0.1.1
Loading WASM module: my-app.wasm
Server listening on http://localhost:3000
```

That's it - your app is running!

## Step 3: Try Some Options

### Change the Port

Don't want to use port 3000? No problem:

```bash
clean-node-server my-app.wasm --port 8080
```

### See What's Happening

Want to see detailed logs? Use verbose mode:

```bash
clean-node-server my-app.wasm --verbose
```

You'll see every route registration, every request, and more.

### Connect to a Database

If your app needs a database:

```bash
# PostgreSQL
clean-node-server my-app.wasm --database "postgresql://user:password@localhost:5432/mydb"

# SQLite (file)
clean-node-server my-app.wasm --database "sqlite:///path/to/data.db"

# SQLite (in memory - great for testing)
clean-node-server my-app.wasm --database "sqlite::memory:"
```

## Your First Clean Language Server

Here's a simple Clean Language program that creates a web server:

```clean
// A simple health check endpoint
function handleHealth(): string {
    return _http_json('{"status": "healthy"}')
}

// A greeting endpoint
function handleHello(): string {
    string name = _req_query("name")
    if (name == "") {
        name = "World"
    }
    return _http_json('{"message": "Hello, ' + name + '!"}')
}

// Main function - runs when the server starts
function main(): void {
    // Register our routes
    _http_route("GET", "/health", handleHealth)
    _http_route("GET", "/hello", handleHello)

    // Start listening
    _http_listen(3000)

    print("Server is ready!")
}
```

After compiling this to `server.wasm`, run it:

```bash
clean-node-server server.wasm
```

Then test it:

```bash
# Check health
curl http://localhost:3000/health
# Returns: {"status": "healthy"}

# Say hello
curl http://localhost:3000/hello?name=Ivan
# Returns: {"message": "Hello, Ivan!"}
```

## Common Issues

### "Command not found"

If you installed globally but get this error, you might need to:
- Restart your terminal
- Check that npm's global bin folder is in your PATH

Try using npx instead:
```bash
npx @ivan-pasco/clean-node-server my-app.wasm
```

### "Port already in use"

Another program is using port 3000. Pick a different port:
```bash
clean-node-server my-app.wasm --port 8080
```

### "WASM module failed to load"

Make sure:
- The file exists and is a valid `.wasm` file
- It was compiled with a compatible version of the Clean compiler
- The file isn't corrupted

## Next Steps

Now that you're up and running:

- [Build HTTP APIs](http-server.md) - Create routes and handle requests
- [Work with Databases](database.md) - Store and retrieve data
- [Add Authentication](authentication.md) - Secure your app with sessions and JWT
- [See All Functions](functions-reference.md) - Everything you can do

Happy coding!
