# Building HTTP APIs

This guide shows you how to create web APIs with Clean Language and Clean Node Server.

## The Basics

Your Clean Language code can register routes that respond to HTTP requests. Here's the pattern:

```clean
function handleSomething(): string {
    // Do something and return a response
    return _http_json('{"message": "Hello!"}')
}

function main(): void {
    _http_route("GET", "/something", handleSomething)
    _http_listen(3000)
}
```

## Registering Routes

Use `_http_route` to tell the server which function handles which URL:

```clean
// Basic routes
_http_route("GET", "/users", handleListUsers)
_http_route("POST", "/users", handleCreateUser)
_http_route("GET", "/users/:id", handleGetUser)
_http_route("PUT", "/users/:id", handleUpdateUser)
_http_route("DELETE", "/users/:id", handleDeleteUser)
```

### URL Parameters

Use `:paramName` in your route path to capture parts of the URL:

```clean
// Route: GET /users/:id
function handleGetUser(): string {
    string userId = _req_param("id")
    // userId contains whatever was in the URL
    // GET /users/42 -> userId = "42"
    return _http_json('{"id": "' + userId + '"}')
}
```

### Getting Parameters as Numbers

If you need the parameter as an integer:

```clean
function handleGetUser(): string {
    integer userId = _req_param_int("id")
    // Now you can do math with it!
    return _http_json('{"id": ' + int_to_string(userId) + '}')
}
```

## Reading Request Data

### Query String Parameters

For URLs like `/search?q=hello&limit=10`:

```clean
function handleSearch(): string {
    string query = _req_query("q")        // "hello"
    string limit = _req_query("limit")    // "10"

    return _http_json('{"query": "' + query + '"}')
}
```

### Request Body

For POST/PUT requests with a body:

```clean
function handleCreateUser(): string {
    // Get the entire body as a string
    string body = _req_body()

    // Or get the body as parsed JSON (if it's valid JSON)
    string jsonBody = _req_json()

    return _http_json('{"received": true}')
}
```

### Individual Fields from JSON Body

Extract specific fields from a JSON request body:

```clean
function handleLogin(): string {
    string email = _req_body_field("email")
    string password = _req_body_field("password")

    // Now use email and password...
    return _http_json('{"user": "' + email + '"}')
}
```

### Request Headers

```clean
function handleRequest(): string {
    string authHeader = _req_header("Authorization")
    string contentType = _req_header("Content-Type")
    string userAgent = _req_header("User-Agent")

    return _http_json('{"ok": true}')
}
```

### Cookies

```clean
function handleRequest(): string {
    string sessionId = _req_cookie("session_id")

    return _http_json('{"hasSession": true}')
}
```

### Other Request Info

```clean
function handleRequest(): string {
    string method = _req_method()    // "GET", "POST", etc.
    string path = _req_path()        // "/users/42"

    return _http_json('{"method": "' + method + '"}')
}
```

## Sending Responses

### JSON Responses (Most Common)

```clean
function handleApi(): string {
    return _http_json('{"status": "ok", "data": [1, 2, 3]}')
}
```

This automatically sets `Content-Type: application/json`.

### HTML Responses

```clean
function handlePage(): string {
    return _http_html('<html><body><h1>Hello!</h1></body></html>')
}
```

### Plain Text Responses

```clean
function handleText(): string {
    return _http_text('Just some plain text')
}
```

### Custom Status and Headers

For more control over the response:

```clean
function handleCustom(): string {
    _http_set_status(201)                              // Created
    _http_set_header("X-Custom-Header", "my-value")
    _http_set_body('{"created": true}')
    return ""
}
```

### Combined Response (Status + Content-Type + Body)

```clean
function handleRespond(): string {
    return _http_respond(200, "application/json", '{"ok": true}')
}
```

## Error Responses

Built-in helpers for common error responses:

```clean
function handleNotFound(): string {
    return _http_not_found("User not found")
}

function handleBadInput(): string {
    return _http_bad_request("Email is required")
}

function handleUnauthorized(): string {
    return _http_unauthorized("Please log in")
}

function handleForbidden(): string {
    return _http_forbidden("You don't have permission")
}

function handleServerError(): string {
    return _http_server_error("Something went wrong")
}
```

Each of these returns a JSON response like:
```json
{
    "ok": false,
    "err": {
        "code": "NOT_FOUND",
        "message": "User not found"
    }
}
```

## Redirects

Send users to another URL:

```clean
function handleOldUrl(): string {
    // Temporary redirect (302)
    return _http_redirect("/new-url", 0)
}

function handleMovedPermanently(): string {
    // Permanent redirect (301)
    return _http_redirect("/new-url", 1)
}
```

## Protected Routes

For routes that require authentication:

```clean
function main(): void {
    // Anyone can access this
    _http_route("GET", "/public", handlePublic)

    // Must be logged in
    _http_route_protected("GET", "/profile", handleProfile, "")

    // Must be an admin
    _http_route_protected("GET", "/admin", handleAdmin, "admin")

    _http_listen(3000)
}
```

The server automatically checks authentication and returns 401/403 errors if needed.

## Complete Example: A User API

```clean
// List all users
function handleListUsers(): string {
    string result = _db_query("SELECT id, name, email FROM users", "[]")
    return _http_json(result)
}

// Get one user by ID
function handleGetUser(): string {
    integer id = _req_param_int("id")
    string params = '[' + int_to_string(id) + ']'
    string result = _db_query("SELECT * FROM users WHERE id = $1", params)

    if (result == "[]") {
        return _http_not_found("User not found")
    }

    return _http_json(result)
}

// Create a new user
function handleCreateUser(): string {
    string name = _req_body_field("name")
    string email = _req_body_field("email")

    if (name == "" || email == "") {
        return _http_bad_request("Name and email are required")
    }

    string params = '["' + name + '", "' + email + '"]'
    string result = _db_execute(
        "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
        params
    )

    _http_set_status(201)
    return _http_json('{"id": ' + result + ', "name": "' + name + '"}')
}

// Set up routes
function main(): void {
    _http_route("GET", "/users", handleListUsers)
    _http_route("GET", "/users/:id", handleGetUser)
    _http_route("POST", "/users", handleCreateUser)

    _http_listen(3000)
    print("User API running on port 3000")
}
```

## Tips

1. **Always return something** - Every handler should return a string (even if empty)

2. **Use JSON for APIs** - It's the standard and works great with `_http_json`

3. **Validate input** - Check that required fields are present before using them

4. **Use meaningful error messages** - Help your API users understand what went wrong

5. **Log in verbose mode** - Run with `--verbose` during development to see all requests

## Next Steps

- [Database Guide](database.md) - Store and retrieve data
- [Authentication Guide](authentication.md) - Add login and security
- [Functions Reference](functions-reference.md) - All available functions
