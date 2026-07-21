# Fling Examples

Common patterns for building personal tools with Fling.

## Simple API with Authentication

Protected endpoints with API key auth.

```typescript
import { app, db, secrets } from "flingit";

const API_KEY = secrets.get("API_KEY");

// Auth middleware
function requireAuth(c: any, next: () => Promise<void>) {
  const auth = c.req.header("Authorization");
  if (auth !== `Bearer ${API_KEY}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
}

// Public endpoint
app.get("/health", (c) => c.json({ status: "ok" }));

// Protected endpoints
app.post("/api/items", requireAuth, async (c) => {
  const { name, value } = await c.req.json();

  const result = await db.prepare(
    "INSERT INTO items (name, value) VALUES (?, ?)"
  ).bind(name, value).run();

  console.log("Created item", name, result.meta.last_row_id);

  return c.json({
    id: result.meta.last_row_id,
    name,
    value
  }, 201);
});

app.get("/api/items", requireAuth, async (c) => {
  const { results } = await db.prepare("SELECT * FROM items").all();
  return c.json(results);
});

app.get("/api/items/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  const item = await db.prepare(
    "SELECT * FROM items WHERE id = ?"
  ).bind(id).first();

  if (!item) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json(item);
});
```

## Webhook Receiver

Process incoming webhooks and store data.

```typescript
import { app, db, secrets } from "flingit";

async function initDb() {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      type TEXT,
      payload TEXT NOT NULL,
      received_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
}

// Verify GitHub webhook signature using Web Crypto API
async function verifyGitHubSignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = "sha256=" + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  return signature === expected;
}

// GitHub webhook
app.post("/webhooks/github", async (c) => {
  const signature = c.req.header("X-Hub-Signature-256");
  const event = c.req.header("X-GitHub-Event");
  const body = await c.req.text();

  // Optional: Verify signature (uncomment to enable)
  // const secret = secrets.get("GITHUB_WEBHOOK_SECRET");
  // if (signature && !await verifyGitHubSignature(body, signature, secret)) {
  //   return c.text("Invalid signature", 401);
  // }

  await db.prepare(
    "INSERT INTO events (source, type, payload) VALUES (?, ?, ?)"
  ).bind("github", event, body).run();

  console.log("GitHub webhook received", event);

  return c.json({ ok: true });
});

// Generic webhook
app.post("/webhooks/:source", async (c) => {
  const source = c.req.param("source");
  const body = await c.req.text();

  await db.prepare(
    "INSERT INTO events (source, payload) VALUES (?, ?)"
  ).bind(source, body).run();

  console.log("Webhook received", source);

  return c.json({ ok: true });
});

// View recent events
app.get("/events", async (c) => {
  const { results } = await db.prepare(
    "SELECT * FROM events ORDER BY received_at DESC LIMIT 100"
  ).all();
  return c.json(results);
});
```

## Data Sync API

Pull data from an external API and store it.

```typescript
import { app, db, secrets, migrate } from "flingit";

const API_TOKEN = secrets.get("DATA_API_TOKEN");

migrate("001_create_sync_data", async () => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS sync_data (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      synced_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
});

// Sync data from external API
async function syncData() {
  console.log("Starting data sync");

  const response = await fetch("https://api.example.com/data", {
    headers: { "Authorization": `Bearer ${API_TOKEN}` }
  });

  if (!response.ok) {
    throw new Error(`Sync failed: ${response.status}`);
  }

  const items = await response.json();
  let synced = 0;

  for (const item of items) {
    await db.prepare(
      "INSERT OR REPLACE INTO sync_data (id, data, synced_at) VALUES (?, ?, datetime('now'))"
    ).bind(item.id, JSON.stringify(item)).run();
    synced++;
  }

  console.log("Sync completed", synced);
  return synced;
}

// View synced data
app.get("/api/data", async (c) => {
  const { results } = await db.prepare(
    "SELECT * FROM sync_data ORDER BY synced_at DESC"
  ).all();

  return c.json(results.map((r: any) => ({
    id: r.id,
    data: JSON.parse(r.data),
    synced_at: r.synced_at
  })));
});

// Trigger sync via API
app.post("/api/sync", async (c) => {
  const count = await syncData();
  return c.json({ message: "Sync completed", count });
});
```
