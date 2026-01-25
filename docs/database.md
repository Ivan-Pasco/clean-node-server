# Working with Databases

Clean Node Server supports PostgreSQL and SQLite databases. This guide shows you how to connect and run queries.

## Connecting to a Database

Pass the database URL when starting your server:

### PostgreSQL

```bash
clean-node-server my-app.wasm --database "postgresql://user:password@localhost:5432/mydb"
```

### SQLite (File-based)

```bash
clean-node-server my-app.wasm --database "sqlite:///path/to/database.db"
```

### SQLite (In-Memory)

Great for testing - data is lost when the server stops:

```bash
clean-node-server my-app.wasm --database "sqlite::memory:"
```

## Running Queries

### SELECT - Get Data

```clean
function getUsers(): string {
    string result = _db_query("SELECT * FROM users", "[]")
    return _http_json(result)
}
```

The result is a JSON array of objects:
```json
[
    {"id": 1, "name": "Alice", "email": "alice@example.com"},
    {"id": 2, "name": "Bob", "email": "bob@example.com"}
]
```

### Using Parameters (Safe from SQL Injection!)

Always use parameters for user input - never put user data directly in your SQL:

```clean
function getUserById(): string {
    integer id = _req_param_int("id")

    // Parameters are passed as a JSON array
    string params = '[' + int_to_string(id) + ']'

    string result = _db_query(
        "SELECT * FROM users WHERE id = $1",
        params
    )

    return _http_json(result)
}
```

**Good:** `"SELECT * FROM users WHERE id = $1"` with params `[42]`

**Bad:** `"SELECT * FROM users WHERE id = " + userId` (SQL injection risk!)

### Multiple Parameters

```clean
function searchUsers(): string {
    string name = _req_query("name")
    string city = _req_query("city")

    // Parameters in order: $1, $2, $3...
    string params = '["' + name + '", "' + city + '"]'

    string result = _db_query(
        "SELECT * FROM users WHERE name LIKE $1 AND city = $2",
        params
    )

    return _http_json(result)
}
```

## Modifying Data

### INSERT - Add New Records

```clean
function createUser(): string {
    string name = _req_body_field("name")
    string email = _req_body_field("email")

    string params = '["' + name + '", "' + email + '"]'

    // _db_execute returns the number of affected rows (or last insert ID for INSERT)
    string result = _db_execute(
        "INSERT INTO users (name, email) VALUES ($1, $2)",
        params
    )

    _http_set_status(201)
    return _http_json('{"created": true, "id": ' + result + '}')
}
```

### UPDATE - Change Existing Records

```clean
function updateUser(): string {
    integer id = _req_param_int("id")
    string name = _req_body_field("name")

    string params = '["' + name + '", ' + int_to_string(id) + ']'

    string affected = _db_execute(
        "UPDATE users SET name = $1 WHERE id = $2",
        params
    )

    if (affected == "0") {
        return _http_not_found("User not found")
    }

    return _http_json('{"updated": true}')
}
```

### DELETE - Remove Records

```clean
function deleteUser(): string {
    integer id = _req_param_int("id")

    string params = '[' + int_to_string(id) + ']'

    string affected = _db_execute(
        "DELETE FROM users WHERE id = $1",
        params
    )

    if (affected == "0") {
        return _http_not_found("User not found")
    }

    return _http_json('{"deleted": true}')
}
```

## Transactions

For operations that must succeed or fail together:

```clean
function transferMoney(): string {
    string fromId = _req_body_field("from")
    string toId = _req_body_field("to")
    string amount = _req_body_field("amount")

    // Start a transaction
    string txId = _db_begin()

    // Try to do the transfer
    string debit = _db_execute(
        "UPDATE accounts SET balance = balance - $1 WHERE id = $2",
        '[' + amount + ', ' + fromId + ']'
    )

    string credit = _db_execute(
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
        '[' + amount + ', ' + toId + ']'
    )

    // If both succeeded, commit
    if (debit != "0" && credit != "0") {
        _db_commit(txId)
        return _http_json('{"transferred": true}')
    }

    // Something went wrong - roll back
    _db_rollback(txId)
    return _http_bad_request("Transfer failed")
}
```

## Query vs Execute

Use the right function:

| Function | Use For | Returns |
|----------|---------|---------|
| `_db_query` | SELECT (reading data) | JSON array of results |
| `_db_execute` | INSERT, UPDATE, DELETE | Affected row count or last insert ID |

## PostgreSQL vs SQLite Differences

Most queries work the same, but watch out for:

### Parameter Placeholders

- **PostgreSQL:** `$1`, `$2`, `$3`
- **SQLite:** Also supports `$1`, `$2`, `$3` (Clean Node Server normalizes this)

### Auto-increment IDs

- **PostgreSQL:** Use `SERIAL` or `BIGSERIAL`
- **SQLite:** Use `INTEGER PRIMARY KEY AUTOINCREMENT`

### Date/Time

- **PostgreSQL:** Full datetime support with `TIMESTAMP`
- **SQLite:** Stores as text or integer, less built-in support

## Example: Complete CRUD API

```clean
// Get all items
function listItems(): string {
    return _http_json(_db_query("SELECT * FROM items ORDER BY created_at DESC", "[]"))
}

// Get single item
function getItem(): string {
    integer id = _req_param_int("id")
    string result = _db_query(
        "SELECT * FROM items WHERE id = $1",
        '[' + int_to_string(id) + ']'
    )

    if (result == "[]") {
        return _http_not_found("Item not found")
    }

    return _http_json(result)
}

// Create item
function createItem(): string {
    string title = _req_body_field("title")
    string description = _req_body_field("description")

    if (title == "") {
        return _http_bad_request("Title is required")
    }

    string params = '["' + title + '", "' + description + '"]'
    string id = _db_execute(
        "INSERT INTO items (title, description) VALUES ($1, $2)",
        params
    )

    _http_set_status(201)
    return _http_json('{"id": ' + id + '}')
}

// Update item
function updateItem(): string {
    integer id = _req_param_int("id")
    string title = _req_body_field("title")

    string params = '["' + title + '", ' + int_to_string(id) + ']'
    string affected = _db_execute(
        "UPDATE items SET title = $1 WHERE id = $2",
        params
    )

    if (affected == "0") {
        return _http_not_found("Item not found")
    }

    return _http_json('{"updated": true}')
}

// Delete item
function deleteItem(): string {
    integer id = _req_param_int("id")
    string affected = _db_execute(
        "DELETE FROM items WHERE id = $1",
        '[' + int_to_string(id) + ']'
    )

    if (affected == "0") {
        return _http_not_found("Item not found")
    }

    return _http_json('{"deleted": true}')
}

// Register routes
function main(): void {
    _http_route("GET", "/items", listItems)
    _http_route("GET", "/items/:id", getItem)
    _http_route("POST", "/items", createItem)
    _http_route("PUT", "/items/:id", updateItem)
    _http_route("DELETE", "/items/:id", deleteItem)

    _http_listen(3000)
    print("Items API ready!")
}
```

## Tips

1. **Always use parameters** - Never concatenate user input into SQL strings

2. **Check for empty results** - A SELECT returns `"[]"` when nothing matches

3. **Use transactions** - When multiple changes must succeed together

4. **Test with SQLite first** - It's easy to set up with `sqlite::memory:`

5. **Index your columns** - Create indexes on columns you search by often

## Next Steps

- [Authentication Guide](authentication.md) - Secure your API
- [HTTP Server Guide](http-server.md) - Handle requests and responses
- [Functions Reference](functions-reference.md) - All database functions
