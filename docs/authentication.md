# Authentication Guide

This guide shows you how to add user authentication to your Clean Language apps - including password hashing, sessions, and JWT tokens.

## Overview

Clean Node Server provides two approaches:

1. **Sessions** - Traditional cookie-based auth, great for web apps
2. **JWT Tokens** - Stateless token auth, great for APIs

You can use either or both!

## Password Hashing

Never store passwords in plain text. Use bcrypt hashing:

### Hashing a Password

```clean
function handleRegister(): string {
    string email = _req_body_field("email")
    string password = _req_body_field("password")

    // Hash the password (bcrypt, secure!)
    string hashedPassword = _auth_hash_password(password)

    // Store the hash in your database
    string params = '["' + email + '", "' + hashedPassword + '"]'
    _db_execute(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2)",
        params
    )

    return _http_json('{"registered": true}')
}
```

### Verifying a Password

```clean
function handleLogin(): string {
    string email = _req_body_field("email")
    string password = _req_body_field("password")

    // Get the stored hash from database
    string result = _db_query(
        "SELECT id, password_hash FROM users WHERE email = $1",
        '["' + email + '"]'
    )

    if (result == "[]") {
        return _http_unauthorized("Invalid email or password")
    }

    // Check if password matches
    // (you'd parse the hash from result in real code)
    string storedHash = getHashFromResult(result)

    integer valid = _auth_verify_password(password, storedHash)

    if (valid == 0) {
        return _http_unauthorized("Invalid email or password")
    }

    // Password correct! Create session or token...
    return _http_json('{"loggedIn": true}')
}
```

## Session-Based Authentication

Sessions store user info on the server, with a cookie pointing to it.

### Creating a Session

```clean
function handleLogin(): string {
    // After verifying password...
    string userId = "42"
    string role = "user"
    string claims = '{"name": "Alice"}'

    // Create session - returns session ID and sets cookie
    string sessionId = _session_create(userId, role, claims)

    return _http_json('{"loggedIn": true}')
}
```

### Reading Session Data

```clean
function handleProfile(): string {
    // Get current session
    string session = _session_get()

    if (session == "") {
        return _http_unauthorized("Please log in")
    }

    // Session contains userId, role, and claims
    return _http_json(session)
}
```

### Destroying a Session (Logout)

```clean
function handleLogout(): string {
    _session_destroy()
    return _http_json('{"loggedOut": true}')
}
```

### Setting Cookies Manually

```clean
function setPreferences(): string {
    // Set a cookie with options
    _http_set_cookie(
        "theme",
        "dark",
        '{"maxAge": 86400, "httpOnly": false}'
    )

    return _http_json('{"saved": true}')
}
```

## JWT Token Authentication

JWTs are self-contained tokens - great for APIs and mobile apps.

### Creating a Token

```clean
function handleLogin(): string {
    // After verifying password...
    string payload = '{"userId": 42, "role": "user", "name": "Alice"}'
    string secret = "your-secret-key"
    string expiresIn = "24h"

    string token = _jwt_sign(payload, secret, expiresIn)

    return _http_json('{"token": "' + token + '"}')
}
```

### Verifying a Token

```clean
function handleProtectedRoute(): string {
    // Get token from Authorization header
    string token = _req_auth_token()

    if (token == "") {
        return _http_unauthorized("No token provided")
    }

    string secret = "your-secret-key"
    string payload = _jwt_verify(token, secret)

    if (payload == "") {
        return _http_unauthorized("Invalid or expired token")
    }

    // Token is valid! payload contains the user data
    return _http_json('{"user": ' + payload + '}')
}
```

### Token Expiration Options

```clean
// Different expiration formats
_jwt_sign(payload, secret, "15m")   // 15 minutes
_jwt_sign(payload, secret, "1h")    // 1 hour
_jwt_sign(payload, secret, "7d")    // 7 days
_jwt_sign(payload, secret, "30d")   // 30 days
```

## Protected Routes

Instead of checking authentication in every handler, use protected routes:

```clean
function main(): void {
    // Public routes - anyone can access
    _http_route("POST", "/login", handleLogin)
    _http_route("POST", "/register", handleRegister)

    // Protected routes - must be logged in
    _http_route_protected("GET", "/profile", handleProfile, "")
    _http_route_protected("PUT", "/profile", updateProfile, "")

    // Admin routes - must have admin role
    _http_route_protected("GET", "/admin/users", listAllUsers, "admin")
    _http_route_protected("DELETE", "/admin/users/:id", deleteUser, "admin")

    _http_listen(3000)
}
```

The server automatically:
- Returns 401 Unauthorized if not logged in
- Returns 403 Forbidden if user lacks required role

## Checking Auth in Handlers

```clean
function handleSomething(): string {
    // Check if logged in
    integer hasAuth = _req_has_auth()
    if (hasAuth == 0) {
        return _http_unauthorized("Please log in")
    }

    // Get the auth token
    string token = _req_auth_token()

    // Use the session helper
    string session = _auth_get_session()

    // Require specific role
    integer isAdmin = _auth_require_role("admin")
    if (isAdmin == 0) {
        return _http_forbidden("Admin access required")
    }

    return _http_json('{"authorized": true}')
}
```

## Cryptography Helpers

Additional security functions:

### Random Token Generation

```clean
function generateResetToken(): string {
    // Generate 32 bytes of random hex (64 characters)
    string token = _crypto_random_hex(32)
    return token
}
```

### SHA-256 Hashing

```clean
function hashData(): string {
    string data = "some data to hash"
    string hash = _crypto_hash_sha256(data)
    return hash
}
```

### AES Encryption

```clean
function encryptSensitiveData(): string {
    string data = "sensitive information"
    string key = "32-character-encryption-key!!"

    // Encrypt
    string encrypted = _crypto_encrypt_aes(data, key)

    // Later, decrypt
    string decrypted = _crypto_decrypt_aes(encrypted, key)

    return decrypted
}
```

## Complete Example: Auth System

```clean
// Register a new user
function handleRegister(): string {
    string email = _req_body_field("email")
    string password = _req_body_field("password")
    string name = _req_body_field("name")

    if (email == "" || password == "") {
        return _http_bad_request("Email and password required")
    }

    // Check if user exists
    string existing = _db_query(
        "SELECT id FROM users WHERE email = $1",
        '["' + email + '"]'
    )
    if (existing != "[]") {
        return _http_bad_request("Email already registered")
    }

    // Hash password and create user
    string hash = _auth_hash_password(password)
    string params = '["' + email + '", "' + hash + '", "' + name + '"]'

    _db_execute(
        "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)",
        params
    )

    _http_set_status(201)
    return _http_json('{"registered": true}')
}

// Log in
function handleLogin(): string {
    string email = _req_body_field("email")
    string password = _req_body_field("password")

    // Find user
    string result = _db_query(
        "SELECT id, password_hash, role, name FROM users WHERE email = $1",
        '["' + email + '"]'
    )

    if (result == "[]") {
        return _http_unauthorized("Invalid credentials")
    }

    // Verify password (simplified - you'd parse the result)
    // integer valid = _auth_verify_password(password, storedHash)

    // Create JWT token
    string payload = '{"userId": 1, "role": "user", "email": "' + email + '"}'
    string token = _jwt_sign(payload, "your-secret", "24h")

    return _http_json('{"token": "' + token + '"}')
}

// Get current user profile
function handleProfile(): string {
    string token = _req_auth_token()
    string payload = _jwt_verify(token, "your-secret")

    if (payload == "") {
        return _http_unauthorized("Invalid token")
    }

    return _http_json('{"user": ' + payload + '}')
}

// Routes
function main(): void {
    _http_route("POST", "/auth/register", handleRegister)
    _http_route("POST", "/auth/login", handleLogin)
    _http_route_protected("GET", "/auth/profile", handleProfile, "")

    _http_listen(3000)
}
```

## Security Tips

1. **Use strong secrets** - Generate random strings for JWT and session secrets
   ```bash
   clean-node-server app.wasm --jwt-secret "$(openssl rand -hex 32)"
   ```

2. **Use HTTPS in production** - Tokens and cookies should only travel over secure connections

3. **Short token expiration** - Use refresh tokens for long-lived sessions

4. **Validate all input** - Check email format, password strength, etc.

5. **Rate limit login attempts** - Prevent brute force attacks

## Next Steps

- [HTTP Server Guide](http-server.md) - Building APIs
- [Database Guide](database.md) - Storing user data
- [Functions Reference](functions-reference.md) - All auth functions
