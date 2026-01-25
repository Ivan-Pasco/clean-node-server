# File System Operations

Clean Node Server lets your apps read and write files on the server. This guide covers all file operations.

## Security: The Sandbox

By default, file operations are restricted to the directory containing your `.wasm` file. This prevents accidental (or malicious) access to system files.

You can change this with the `--sandbox` option:

```bash
# Only allow access to /var/data
clean-node-server app.wasm --sandbox /var/data

# Allow access to current directory
clean-node-server app.wasm --sandbox .
```

## Reading Files

### Read Entire File

```clean
function readConfig(): string {
    string content = file_read("config.json")

    if (content == "") {
        return _http_not_found("Config file not found")
    }

    return _http_json(content)
}
```

### Check If File Exists

```clean
function checkFile(): string {
    integer exists = file_exists("data.txt")

    if (exists == 1) {
        return _http_json('{"exists": true}')
    } else {
        return _http_json('{"exists": false}')
    }
}
```

### Get File Size

```clean
function getFileInfo(): string {
    integer size = file_size("document.pdf")
    return _http_json('{"size": ' + int_to_string(size) + '}')
}
```

## Writing Files

### Write New File (Overwrites If Exists)

```clean
function saveData(): string {
    string data = _req_body()

    file_write("output.txt", data)

    return _http_json('{"saved": true}')
}
```

### Append to File

```clean
function appendLog(): string {
    string message = _req_body_field("message")
    string timestamp = _time_format_iso(_time_epoch_ms())

    string logLine = timestamp + " - " + message + "\n"

    file_append("app.log", logLine)

    return _http_json('{"logged": true}')
}
```

## Deleting Files

```clean
function deleteFile(): string {
    string filename = _req_query("file")

    integer exists = file_exists(filename)
    if (exists == 0) {
        return _http_not_found("File not found")
    }

    file_delete(filename)

    return _http_json('{"deleted": true}')
}
```

## Working with Directories

### List Directory Contents

```clean
function listFiles(): string {
    string path = _req_query("path")
    if (path == "") {
        path = "."
    }

    // Returns JSON array of filenames
    string files = file_list_dir(path)

    return _http_json('{"files": ' + files + '}')
}
```

Result looks like:
```json
{
    "files": ["config.json", "data/", "README.md", "app.wasm"]
}
```

### Create Directory

```clean
function createFolder(): string {
    string name = _req_body_field("name")

    file_mkdir(name)

    return _http_json('{"created": true}')
}
```

## Moving and Copying Files

### Copy a File

```clean
function copyFile(): string {
    string source = _req_body_field("source")
    string dest = _req_body_field("destination")

    file_copy(source, dest)

    return _http_json('{"copied": true}')
}
```

### Rename/Move a File

```clean
function moveFile(): string {
    string oldPath = _req_body_field("from")
    string newPath = _req_body_field("to")

    file_rename(oldPath, newPath)

    return _http_json('{"moved": true}')
}
```

## Example: Simple File Storage API

```clean
// List all files in uploads directory
function listUploads(): string {
    string files = file_list_dir("uploads")
    return _http_json('{"files": ' + files + '}')
}

// Get a file's contents
function getFile(): string {
    string filename = _req_param("name")
    string path = "uploads/" + filename

    integer exists = file_exists(path)
    if (exists == 0) {
        return _http_not_found("File not found")
    }

    string content = file_read(path)

    // Return as plain text
    return _http_text(content)
}

// Save a file
function saveFile(): string {
    string filename = _req_param("name")
    string content = _req_body()
    string path = "uploads/" + filename

    file_write(path, content)

    _http_set_status(201)
    return _http_json('{"saved": "' + filename + '"}')
}

// Delete a file
function removeFile(): string {
    string filename = _req_param("name")
    string path = "uploads/" + filename

    integer exists = file_exists(path)
    if (exists == 0) {
        return _http_not_found("File not found")
    }

    file_delete(path)
    return _http_json('{"deleted": true}')
}

// Set up routes
function main(): void {
    // Make sure uploads folder exists
    file_mkdir("uploads")

    _http_route("GET", "/files", listUploads)
    _http_route("GET", "/files/:name", getFile)
    _http_route("PUT", "/files/:name", saveFile)
    _http_route("DELETE", "/files/:name", removeFile)

    _http_listen(3000)
    print("File API ready!")
}
```

## Example: JSON Config Manager

```clean
function loadConfig(): string {
    integer exists = file_exists("config.json")

    if (exists == 0) {
        // Return default config
        return '{"theme": "light", "language": "en"}'
    }

    return file_read("config.json")
}

function saveConfig(): string {
    string config = _req_body()

    // Validate it's valid JSON
    string parsed = _req_json()
    if (parsed == "") {
        return _http_bad_request("Invalid JSON")
    }

    file_write("config.json", config)
    return _http_json('{"saved": true}')
}

function handleGetConfig(): string {
    string config = loadConfig()
    return _http_json(config)
}

function handleUpdateConfig(): string {
    return saveConfig()
}

function main(): void {
    _http_route("GET", "/config", handleGetConfig)
    _http_route("PUT", "/config", handleUpdateConfig)
    _http_listen(3000)
}
```

## Tips

1. **Always check if files exist** before reading or deleting

2. **Use relative paths** - They're relative to the sandbox root

3. **Create directories first** - `file_write` won't create parent folders

4. **Be careful with user input** - Don't let users specify paths like `../../../etc/passwd`

5. **Use append for logs** - Don't read/modify/write the whole file

## File Function Summary

| Function | What It Does |
|----------|--------------|
| `file_read(path)` | Read entire file as string |
| `file_write(path, data)` | Write string to file (overwrites) |
| `file_append(path, data)` | Add string to end of file |
| `file_exists(path)` | Check if file exists (1=yes, 0=no) |
| `file_delete(path)` | Delete a file |
| `file_size(path)` | Get file size in bytes |
| `file_list_dir(path)` | List directory contents as JSON array |
| `file_mkdir(path)` | Create a directory |
| `file_copy(src, dst)` | Copy a file |
| `file_rename(old, new)` | Move or rename a file |

## Next Steps

- [HTTP Client Guide](http-client.md) - Make requests to other services
- [Database Guide](database.md) - Store structured data
- [Functions Reference](functions-reference.md) - All available functions
