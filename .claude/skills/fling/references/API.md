# Fling API Reference

## HTTP (Hono)

Fling uses [Hono](https://hono.dev) for HTTP routing. The `app` export is a configured Hono instance.

### Basic Routes

```typescript
import { app } from "flingit";

// GET request
app.get("/path", (c) => {
  return c.text("Plain text response");
});

// POST request with JSON body
app.post("/api/items", async (c) => {
  const body = await c.req.json();
  return c.json({ id: 1, ...body });
});

// URL parameters
app.get("/items/:id", (c) => {
  const id = c.req.param("id");
  return c.json({ id });
});

// Query parameters
app.get("/search", (c) => {
  const q = c.req.query("q");
  return c.json({ query: q });
});
```

### Response Types

```typescript
// Plain text
return c.text("Hello");

// JSON
return c.json({ key: "value" });

// HTML
return c.html("<h1>Hello</h1>");

// Custom content type
return c.text(xmlContent, 200, { "Content-Type": "application/rss+xml" });

// Binary data
return c.body(buffer, 200, { "Content-Type": "image/png" });

// Status codes
return c.text("Not found", 404);
return c.json({ error: "Bad request" }, 400);
```

### Headers and Cookies

```typescript
// Read headers
const auth = c.req.header("Authorization");

// Set headers
return c.text("OK", 200, { "X-Custom": "value" });

// Cookies
const session = c.req.cookie("session");
c.cookie("session", "value", { httpOnly: true });
```

## Migrations

Database migrations run automatically on app startup. Each migration executes exactly once and is tracked in the `_migrations` table.

### Basic Usage

```typescript
import { migrate, db } from "flingit";

// Migrations run in alphabetical order by name
migrate("001_create_users", async () => {
  await db.prepare(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
});

migrate("002_create_posts", async () => {
  await db.prepare(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
});

migrate("003_add_user_avatar", async () => {
  await db.prepare(`ALTER TABLE users ADD COLUMN avatar_url TEXT`).run();
});
```

### Naming Convention

Use numeric prefixes to ensure correct execution order:
- `001_create_users`
- `002_create_posts`
- `003_add_user_avatar`
- `010_add_comments` (leaves room for insertions)

Migrations run in **alphabetical order**, so numeric prefixes guarantee the intended sequence.

### Startup Sequence

When your app starts:

1. **Import phase**: Routes and migrations are registered (not executed)
2. **Migration phase**: All pending migrations run in order
3. **Server phase**: HTTP server begins accepting requests

**Critical**: The HTTP server does NOT start until all migrations complete successfully. If any migration fails, the entire startup aborts.

### Failure Behavior

If a migration fails:
- A detailed error is logged with the migration name and stack trace
- The failed migration is NOT recorded (allowing retry on restart)
- The server does NOT start
- Previously successful migrations in the same run ARE recorded

```
============================================================
MIGRATION FAILED: 003_add_user_avatar
============================================================
Type: SqliteError
Message: duplicate column name: avatar_url
Code: SQLITE_ERROR

Stack trace:
SqliteError: duplicate column name: avatar_url
    at Database.prepare (...)
    at Object.handler (file:///path/to/src/app.ts:25:9)
    at runMigrations (...)
============================================================
```

The error output includes:
- **Type**: The error class (e.g., `SqliteError`)
- **Message**: Human-readable description
- **Code**: SQLite error code (e.g., `SQLITE_ERROR`, `SQLITE_CONSTRAINT_UNIQUE`)
- **Stack trace**: Points to the exact line that failed

### Idempotent Migrations

Each migration runs exactly once. Use `IF NOT EXISTS` and `IF EXISTS` for safety:

```typescript
migrate("001_create_users", async () => {
  // Safe to run multiple times if migration tracking fails
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    )
  `).run();
});
```

### Data Migrations

Migrations can also modify data:

```typescript
migrate("004_normalize_emails", async () => {
  await db.prepare(`
    UPDATE users SET email = LOWER(email) WHERE email IS NOT NULL
  `).run();
});
```

### Important Notes

- Migrations MUST be declared at module top-level (not inside functions)
- Each migration must have a unique name
- `db.exec()` doesn't return results, so it is not suitable for `SELECT` queries.
- Tables starting with `_` are reserved for the system (`_migrations`, `_fling_logs`)
- Do NOT perform database operations at module top-level outside of migrations
- The `_migrations` table is created automatically on first migration

### Migration vs Top-Level Code

**Wrong** - DB access at module load time:
```typescript
// DON'T DO THIS - runs during import, before migrations
const users = await db.prepare("SELECT * FROM users").all();
```

**Correct** - DB access in migrations and handlers:
```typescript
// Migrations run at startup in correct order
migrate("001_create_users", async () => {
  await db.prepare(`CREATE TABLE users ...`).run();
});

// Route handlers run after migrations complete
app.get("/users", async (c) => {
  const { results } = await db.prepare("SELECT * FROM users").all();
  return c.json(results);
});
```

## Database

SQLite locally, Cloudflare D1 in production. API matches D1.

### Queries

```typescript
import { db } from "flingit";

// Single row
const user = await db.prepare("SELECT * FROM users WHERE id = ?")
  .bind(userId)
  .first();
// Returns: { id: 1, name: "Alice" } or null

// All rows
const users = await db.prepare("SELECT * FROM users ORDER BY name")
  .all();
// Returns: { results: [{ id: 1, name: "Alice" }, ...] }

// With multiple parameters
const items = await db.prepare("SELECT * FROM items WHERE status = ? AND category = ?")
  .bind("active", "tools")
  .all();
```

### Mutations

```typescript
// Insert
const result = await db.prepare("INSERT INTO users (name, email) VALUES (?, ?)")
  .bind("Alice", "alice@example.com")
  .run();
// Returns: { success: true, meta: { changes: 1, last_row_id: 5 } }

// Update
await db.prepare("UPDATE users SET name = ? WHERE id = ?")
  .bind("Bob", 1)
  .run();

// Delete
await db.prepare("DELETE FROM users WHERE id = ?")
  .bind(1)
  .run();
```

### Batch

Execute multiple statements atomically:

```typescript
const results = await db.batch([
  db.prepare("INSERT INTO users (name) VALUES (?)").bind("Alice"),
  db.prepare("INSERT INTO users (name) VALUES (?)").bind("Bob"),
]);
// Returns: [{ success: true, meta: ... }, { success: true, meta: ... }]
```

This is also faster than executing statements individually.

### Schema (DDL)

Schema changes should be done in migrations (see Migrations section above):

```typescript
migrate("001_create_users", async () => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)
  `).run();
});
```

### Important Notes

- Schema changes should be done in migrations (see Migrations section)
- Database queries should be in route handlers, not at module top-level
- Use parameterized queries (?) to prevent SQL injection
- `first()` returns null if no row found (undefined in local SQLite)
- `all()` always returns `{ results: [...] }`
- Tables starting with `_` are reserved for the system

## Secrets

Secure credential management. Throws if secret not set.

```typescript
import { secrets } from "flingit";

// Get a secret (throws if not set)
const apiKey = secrets.get("API_KEY");

// Check if secret exists
if (secrets.has("OPTIONAL_KEY")) {
  const key = secrets.get("OPTIONAL_KEY");
}
```

### Managing Secrets

```bash
# Set/manage secrets locally
fling secret set GITHUB_TOKEN=ghp_xxxx   # Set a secret
fling secret list                         # List secret names
fling secret remove GITHUB_TOKEN          # Remove a secret

# Secrets are deployed automatically with:
fling push
```

Secrets are always stored locally in `.fling/secrets`. When you run `fling push`, secrets are automatically synced to production along with your code.

### Naming Convention

Secret names must be uppercase with underscores:
- `API_KEY` ✓
- `GITHUB_TOKEN` ✓
- `apiKey` ✗
- `github-token` ✗

## Cron Jobs

Schedule tasks to run automatically on a schedule using standard cron syntax:

```typescript
cron("daily-cleanup", "0 3 * * *", async () => {
  // Runs at 3 AM daily
  await db.prepare("DELETE FROM old_logs WHERE created_at < ?")
    .bind(Date.now() - 86400000).run();
});

cron("hourly-report", "0 * * * *", async () => {
  // Runs every hour - can return a result that's stored in history
  const count = await processRecords();
  return { processed: count };
});
```

Cron expressions: `minute hour day-of-month month day-of-week`
- `"0 9 * * *"` - 9 AM daily
- `"*/15 * * * *"` - Every 15 minutes
- `"0 0 * * 1"` - Midnight on Mondays

Manage cron jobs with CLI:
```bash
npx fling cron list           # List all cron jobs
npx fling cron history <name> # View invocation history
npx fling cron trigger <name> # Manually trigger a job
```

## Storage (R2)

Object storage for files and binary data. Uses local filesystem in development, Cloudflare R2 in production.

### Basic Usage

```typescript
import { storage } from "flingit";

// Store a file
await storage.put("images/logo.png", imageBuffer, { contentType: "image/png" });

// Retrieve a file
const file = await storage.get("images/logo.png");
if (file) {
  const buffer = await file.arrayBuffer();
  console.log(`Downloaded ${file.size} bytes`);
}
```

### Storing Objects

```typescript
// String content (auto-detects content type from key extension)
await storage.put("data/config.json", JSON.stringify({ setting: true }));

// Binary data
const imageBuffer = await fetch("https://example.com/image.png").then(r => r.arrayBuffer());
await storage.put("images/photo.png", imageBuffer, { contentType: "image/png" });

// From request body (streaming)
app.post("/api/upload", async (c) => {
  const body = await c.req.arrayBuffer();
  const result = await storage.put("uploads/file.bin", body);
  return c.json({ key: result.key, size: result.size });
});

// With custom metadata
await storage.put("documents/report.pdf", pdfBuffer, {
  contentType: "application/pdf",
  customMetadata: { uploadedBy: "user123", version: "2" }
});
```

**Returns:** `StorageObject` with metadata:
```typescript
{
  key: string;        // Object key
  size: number;       // Size in bytes
  etag: string;       // Content hash
  uploaded: Date;     // Upload timestamp
  contentType?: string;
  customMetadata?: Record<string, string>;
}
```

### Retrieving Objects

```typescript
const file = await storage.get("images/logo.png");

if (file) {
  // Read as different formats
  const buffer = await file.arrayBuffer();  // Raw bytes
  const text = await file.text();           // UTF-8 string
  const json = await file.json<MyType>();   // Parsed JSON

  // Or stream the body
  const stream = file.body;  // ReadableStream<Uint8Array>

  // Access metadata
  console.log(file.key);           // "images/logo.png"
  console.log(file.size);          // 12800
  console.log(file.etag);          // '"abc123"'
  console.log(file.uploaded);      // Date object
  console.log(file.contentType);   // "image/png"
  console.log(file.customMetadata);// { uploadedBy: "user123" }
}
```

**Returns:** `StorageObjectBody | null` (null if not found)

### Range Gets (Partial Reads)

Read a byte range from an object (e.g., seeking into audio/video files):

```typescript
const chunk = await storage.get("audio/song.mp3", {
  range: { offset: 1000, length: 500 },
});

if (chunk) {
  chunk.size;   // full object size (not the range size)
  chunk.range;  // { offset: 1000, length: 500 } — actual bytes returned
  const bytes = await chunk.arrayBuffer(); // only the ranged bytes
}
```

**Range rules:**
- Both `offset` and `length` are **required** when specifying a range
- `offset` and `length` must be non-negative integers
- If `length` extends past the end of the object, it is clamped to the available bytes
- If `offset` is beyond the object size, an error is thrown (except `offset == size` with `length == 0`, which returns an empty body)
- `size` always reports the full object size; range size is in `result.range.length`
- The `range` property is only present on the result when a range was requested

### Checking Existence (Head)

Get metadata without downloading the content:

```typescript
const meta = await storage.head("images/logo.png");

if (meta) {
  console.log(`File exists: ${meta.size} bytes`);
  console.log(`Uploaded: ${meta.uploaded}`);
  console.log(`Content-Type: ${meta.contentType}`);
} else {
  console.log("File not found");
}
```

**Returns:** `StorageObject | null` (same as put result, null if not found)

### Deleting Objects

```typescript
// Delete single object
await storage.delete("old-file.txt");

// Delete multiple objects (batch)
await storage.delete(["file1.txt", "file2.txt", "file3.txt"]);
```

**Returns:** `void` (no error if object doesn't exist)

### Listing Objects

```typescript
// List all objects
const result = await storage.list();
for (const obj of result.objects) {
  console.log(`${obj.key}: ${obj.size} bytes`);
}

// Filter by prefix
const images = await storage.list({ prefix: "images/" });

// Pagination
const page1 = await storage.list({ limit: 100 });
if (page1.truncated) {
  const page2 = await storage.list({ limit: 100, cursor: page1.cursor });
}
```

**Options:**
```typescript
{
  prefix?: string;   // Filter to keys starting with this
  cursor?: string;   // Pagination cursor from previous response
  limit?: number;    // Max results (default 1000, max 1000)
}
```

**Returns:**
```typescript
{
  objects: StorageObject[];  // Array of object metadata
  truncated: boolean;        // true if more results available
  cursor?: string;           // Use in next request for pagination
}
```

### Serving Files via HTTP

```typescript
app.get("/files/:key", async (c) => {
  const key = c.req.param("key");
  const file = await storage.get(key);

  if (!file) {
    return c.text("Not found", 404);
  }

  return new Response(file.body, {
    headers: {
      "Content-Type": file.contentType ?? "application/octet-stream",
      "Content-Length": String(file.size),
      "ETag": file.etag,
    }
  });
});
```

### Key Naming Rules

- **Max length:** 1024 characters
- **Cannot start with:** `/`
- **Cannot contain:** `..`
- Use path-like structure for organization: `images/2024/photo.png`

### CLI Commands

```bash
# List objects
npx fling storage list              # Local storage
npx fling -- --prod storage list    # Production R2
npx fling storage list images/      # Filter by prefix

# Upload file
npx fling storage put images/logo.png ./logo.png
npx fling storage put data.json - < data.json  # From stdin

# Download file
npx fling storage get images/logo.png ./output.png
npx fling storage get data.json     # Output to stdout

# Delete object
npx fling storage delete old-file.txt --yes

# Storage info
npx fling storage info              # Local stats
npx fling -- --prod storage info    # Production R2 stats
```

### Important Notes

- **Storage is provisioned automatically** on first `fling push` - no setup required
- **Keys are flat** - `images/logo.png` is just a string, not a directory structure
- **5GB max object size** for direct uploads (streamed, not buffered)
- **Streaming** - Large files are streamed, not buffered in memory

### Presigned URLs (Direct Browser Upload/Download)

For large files (up to 5GB), create presigned URLs that let browsers upload/download directly to/from R2, bypassing the worker's 100MB request limit.

#### `storage.createUploadUrl(key, options?)`

Create a presigned URL for uploading a file directly to storage.

```typescript
import { app, storage } from "flingit";

// Worker endpoint that generates an upload URL
app.post("/api/upload-url", async (c) => {
  const { filename, contentType } = await c.req.json();
  const key = `uploads/${Date.now()}-${filename}`;

  const { url, expiresAt } = await storage.createUploadUrl(key, {
    expiresIn: 600,        // URL valid for 10 minutes (default: 3600)
    contentType,           // informational, NOT signed into URL
  });

  return c.json({ url, key, expiresAt: expiresAt.toISOString() });
});
```

Frontend code to use the upload URL:

```typescript
// Get presigned URL from your API
const { url, key } = await fetch("/api/upload-url", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ filename: file.name, contentType: file.type }),
}).then(r => r.json());

// Upload directly to R2 (bypasses worker)
await fetch(url, {
  method: "PUT",
  body: file,
  headers: { "Content-Type": file.type },
});
```

**Options (`CreateUploadUrlOptions`):**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `expiresIn` | `number` | `3600` | URL expiry in seconds (clamped to credential lifetime) |
| `contentType` | `string` | — | Informational only; NOT signed into URL |

#### `storage.createDownloadUrl(key, options?)`

Create a presigned URL for downloading a file directly from storage.

```typescript
// Redirect pattern — browser downloads directly from R2
app.get("/api/download/:key", async (c) => {
  const key = c.req.param("key");
  const { url } = await storage.createDownloadUrl(key, {
    expiresIn: 300,
    responseContentDisposition: `attachment; filename="${key.split("/").pop()}"`,
  });
  return c.redirect(url);
});

// JSON URL pattern — return URL for frontend to use
app.get("/api/file-url/:key", async (c) => {
  const key = c.req.param("key");
  const { url, expiresAt } = await storage.createDownloadUrl(key);
  return c.json({ url, expiresAt: expiresAt.toISOString() });
});
```

**Options (`CreateDownloadUrlOptions`):**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `expiresIn` | `number` | `3600` | URL expiry in seconds |
| `responseContentDisposition` | `string` | — | Override Content-Disposition (e.g., force download) |

**Return type (`PresignedUrl`):**
| Field | Type | Description |
|-------|------|-------------|
| `url` | `string` | The presigned URL for browser use |
| `expiresAt` | `Date` | When the URL expires |

#### Important Notes

- **Content-Type is NOT signed** into upload URLs — the browser sends it at upload time. This avoids charset mismatch issues.
- **URLs expire** — default 1 hour, configurable via `expiresIn`. If the URL is near credential expiry, `expiresIn` is clamped to the remaining credential lifetime.
- **Max file size:** 5GB per upload (R2 single PUT limit).
- **CORS is configured automatically** on R2 buckets during deploy.

## WebAssembly (WASM)

Fling supports importing WebAssembly modules in your backend code. This enables using libraries like `@resvg/resvg-wasm` for SVG rendering, image processing, and other compute-intensive tasks.

### Basic Usage

```typescript
import { app } from "flingit";
import wasmBinary from "@resvg/resvg-wasm/index_bg.wasm";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

// Initialize WASM once
let initialized = false;

app.get("/api/svg-to-png", async (c) => {
  if (!initialized) {
    await initWasm(wasmBinary);
    initialized = true;
  }

  const svg = c.req.query("svg") ?? '<svg width="100" height="100"><circle cx="50" cy="50" r="40" fill="red"/></svg>';
  const resvg = new Resvg(svg);
  const png = resvg.render().asPng();

  return c.body(png, 200, { "Content-Type": "image/png" });
});
```

### How It Works

WASM files are handled differently in local development vs production, but the same code works for both:

| Environment | What `import wasm from "*.wasm"` returns |
|-------------|------------------------------------------|
| Local (Node.js) | `Uint8Array` (raw bytes) |
| Production (Cloudflare) | `WebAssembly.Module` (pre-compiled) |

Most WASM libraries (like `@resvg/resvg-wasm`) accept both types in their init functions, so your code works unchanged in both environments.

### TypeScript Support

Add a type declaration file (e.g., `src/worker/wasm.d.ts`):

```typescript
declare module "*.wasm" {
  const content: WebAssembly.Module | Uint8Array;
  export default content;
}
```

### Direct WASM Instantiation

For custom WASM modules without a library wrapper:

```typescript
import wasmModule from "./my-module.wasm";

let instance: WebAssembly.Instance | null = null;

app.get("/api/compute", async (c) => {
  if (!instance) {
    const result = await WebAssembly.instantiate(wasmModule);
    instance = result instanceof WebAssembly.Instance ? result : result.instance;
  }

  const compute = instance.exports.compute as (x: number) => number;
  const result = compute(42);

  return c.json({ result });
});
```

### Important Notes

- **Cloudflare blocks dynamic WASM compilation** - You cannot use `WebAssembly.instantiate(bytes)` with raw bytes fetched at runtime. WASM must be imported statically so Cloudflare can pre-compile it at deploy time.
- **Initialize once** - WASM initialization is expensive. Cache the instance and reuse it across requests.
- **Bundle size** - WASM modules count toward the 10MB bundle limit. Large WASM files may require optimization.
