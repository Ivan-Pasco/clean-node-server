# Making HTTP Requests

Your Clean Language apps can call external APIs and services. This guide shows you how.

## Basic Requests

### GET Request

```clean
function fetchData(): string {
    string response = http_get("https://api.example.com/data")
    return _http_json(response)
}
```

### POST Request

```clean
function createResource(): string {
    string url = "https://api.example.com/items"
    string body = '{"name": "New Item", "price": 29.99}'

    string response = http_post(url, body)
    return _http_json(response)
}
```

### PUT Request

```clean
function updateResource(): string {
    string url = "https://api.example.com/items/42"
    string body = '{"name": "Updated Item"}'

    string response = http_put(url, body)
    return _http_json(response)
}
```

### DELETE Request

```clean
function deleteResource(): string {
    string response = http_delete("https://api.example.com/items/42")
    return _http_json(response)
}
```

### PATCH Request

```clean
function patchResource(): string {
    string url = "https://api.example.com/items/42"
    string body = '{"price": 19.99}'

    string response = http_patch(url, body)
    return _http_json(response)
}
```

## Adding Headers

### GET with Custom Headers

```clean
function fetchWithAuth(): string {
    string url = "https://api.example.com/protected"
    string headers = '{"Authorization": "Bearer your-token-here", "Accept": "application/json"}'

    string response = http_get_with_headers(url, headers)
    return _http_json(response)
}
```

### POST with JSON Content-Type

```clean
function postJson(): string {
    string url = "https://api.example.com/data"
    string body = '{"message": "Hello!"}'

    // http_post_json automatically sets Content-Type: application/json
    string response = http_post_json(url, body)
    return _http_json(response)
}
```

## Response Information

### Get Response Status Code

```clean
function checkStatus(): string {
    http_get("https://api.example.com/health")

    integer statusCode = http_get_response_code()

    if (statusCode == 200) {
        return _http_json('{"status": "healthy"}')
    } else {
        return _http_json('{"status": "unhealthy", "code": ' + int_to_string(statusCode) + '}')
    }
}
```

### Get Response Headers

```clean
function getHeaders(): string {
    http_get("https://api.example.com/data")

    string headers = http_get_response_headers()
    // Returns JSON object with all response headers

    return _http_json(headers)
}
```

## Configuration

### Set Timeout

```clean
function slowRequest(): string {
    // Set timeout to 30 seconds (30000 ms)
    http_set_timeout(30000)

    string response = http_get("https://slow-api.example.com/data")
    return _http_json(response)
}
```

## URL Encoding

### Encode URL Parameters

```clean
function searchWithQuery(): string {
    string query = "hello world & more"

    // Encode the query for URL safety
    string encoded = http_encode_url(query)
    // Result: "hello%20world%20%26%20more"

    string url = "https://api.example.com/search?q=" + encoded
    string response = http_get(url)

    return _http_json(response)
}
```

### Decode URL Parameters

```clean
function decodeParam(): string {
    string encoded = "hello%20world"
    string decoded = http_decode_url(encoded)
    // Result: "hello world"

    return _http_json('{"decoded": "' + decoded + '"}')
}
```

### Build Query String from Object

```clean
function buildQuery(): string {
    string params = '{"name": "John", "age": "30", "city": "NYC"}'

    string queryString = http_build_query(params)
    // Result: "name=John&age=30&city=NYC"

    string url = "https://api.example.com/users?" + queryString
    string response = http_get(url)

    return _http_json(response)
}
```

## Example: API Proxy

Forward requests to an external API:

```clean
function proxyWeather(): string {
    string city = _req_query("city")
    if (city == "") {
        return _http_bad_request("City parameter required")
    }

    string encoded = http_encode_url(city)
    string url = "https://api.weather.com/v1/current?city=" + encoded

    string headers = '{"X-API-Key": "your-api-key"}'
    string response = http_get_with_headers(url, headers)

    integer status = http_get_response_code()
    if (status != 200) {
        return _http_server_error("Weather API error")
    }

    return _http_json(response)
}

function main(): void {
    _http_route("GET", "/weather", proxyWeather)
    _http_listen(3000)
}
```

## Example: Webhook Sender

Send webhooks to external services:

```clean
function sendSlackNotification(message: string): void {
    string webhookUrl = _env_get("SLACK_WEBHOOK_URL")

    string body = '{"text": "' + message + '"}'
    http_post_json(webhookUrl, body)
}

function handleOrderComplete(): string {
    string orderId = _req_body_field("orderId")
    string total = _req_body_field("total")

    // Process the order...

    // Send notification
    sendSlackNotification("New order #" + orderId + " for $" + total)

    return _http_json('{"processed": true}')
}
```

## Example: External API Integration

Fetch data from multiple APIs:

```clean
function getUserProfile(): string {
    string userId = _req_param("id")

    // Get user from one API
    string userUrl = "https://api.users.com/users/" + userId
    string userData = http_get(userUrl)

    // Get user's posts from another API
    string postsUrl = "https://api.posts.com/users/" + userId + "/posts"
    string postsData = http_get(postsUrl)

    // Combine the data
    string result = '{"user": ' + userData + ', "posts": ' + postsData + '}'

    return _http_json(result)
}
```

## Error Handling

```clean
function safeRequest(): string {
    string response = http_get("https://api.example.com/data")
    integer status = http_get_response_code()

    if (status >= 200 && status < 300) {
        return _http_json(response)
    }

    if (status == 404) {
        return _http_not_found("External resource not found")
    }

    if (status == 401) {
        return _http_server_error("API authentication failed")
    }

    if (status >= 500) {
        return _http_server_error("External API is down")
    }

    return _http_bad_request("Request failed with status " + int_to_string(status))
}
```

## HTTP Client Function Summary

| Function | What It Does |
|----------|--------------|
| `http_get(url)` | GET request |
| `http_post(url, body)` | POST request |
| `http_put(url, body)` | PUT request |
| `http_patch(url, body)` | PATCH request |
| `http_delete(url)` | DELETE request |
| `http_get_with_headers(url, headers)` | GET with custom headers |
| `http_post_json(url, body)` | POST with JSON content-type |
| `http_get_response_code()` | Get last response status code |
| `http_get_response_headers()` | Get last response headers |
| `http_set_timeout(ms)` | Set request timeout |
| `http_encode_url(str)` | URL-encode a string |
| `http_decode_url(str)` | URL-decode a string |
| `http_build_query(json)` | Build query string from JSON object |

## Tips

1. **Check status codes** - Don't assume requests always succeed

2. **Set timeouts** - External APIs can be slow

3. **Use environment variables** - Don't hardcode API keys

4. **Handle errors gracefully** - Return meaningful errors to your users

5. **Consider caching** - If data doesn't change often, cache the results

## Next Steps

- [File System Guide](files.md) - Read and write files
- [Environment Variables](functions-reference.md#environment) - Managing secrets
- [Functions Reference](functions-reference.md) - All HTTP functions
