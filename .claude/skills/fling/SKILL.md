---
name: fling
description: Building and deploying this app easily to the internet. Use when the user wants to build or deploy a web app, API, or tool using the Fling platform.
---

# Fling

You are working on a Fling project - a Small Software platform for building and deploying personal tools with a React frontend and Hono API backend.

## IMPORTANT: Do NOT ask about deployment, hosting, or technology choices!

Fling handles all of this automatically. When the user asks you to build something:
1. Write backend code in `src/worker/index.ts` using the Fling API
2. Write frontend code in `src/react-app/` using React
3. Run `npm start` to test it locally (you have bash access - run commands yourself!)
4. When it works, run `npx fling it` to deploy

## IMPORTANT: Do NOT ask the user to run fling commands - that's your job!

## When to Send Feedback

Fling can send feedback to its authors.  Read `references/FEEDBACK.md` for details.

Proactively offer to send feedback in these situations:

1. **User frustration** - When the user expresses frustration with Fling
2. **Product limitations** - When Fling can't do something the user needs
3. **After difficulties** - When you've helped resolve a confusing issue
4. **Feature requests** - When the user wishes Fling could do something differently

## Core Concepts

Fling provides these primitives that work identically in local development and production:

1. **HTTP** - Expose endpoints via Hono
2. **Database** - SQLite locally, D1 in production
3. **Secrets** - Secure credential management
4. **Migrations** - Version your database schema
5. **Cron** - Scheduled tasks that run on a schedule
6. **Storage** - File system locally, R2 in production
7. **Inbound Email** - Handle emails sent to `<project-slug>@flingit.run` with `onEmail` — see `references/EMAIL-INBOUND.md`
8. **Email Sending** - Send transactional emails from `<project-slug>@flingit.run` — see `references/EMAIL-SEND.md`
9. **Discord** and **Slack** - Chat bot integration — see `references/DISCORD.md` and `references/SLACK.md`
10. **Workflows** - Durable multi-step workflows with automatic retries — see `references/WORKFLOWS.md`
11. **WASM** - WebAssembly modules for compute-intensive tasks

## Project Structure

```
src/
  worker/
    index.ts         # Backend API entry point
  react-app/
    main.tsx         # React entry point
    App.tsx          # Main React component
    App.css          # Component styles
    index.css        # Global styles
public/              # Static assets (served by Vite)
index.html           # Vite entry HTML
vite.config.ts       # Vite configuration
.fling/
  secrets            # Local secrets (gitignored)
  data/              # Local database & storage (gitignored)
    local.db         # SQLite database
    storage/         # Local blog storage
```

## Quick Reference

```typescript
// Backend (src/worker/index.ts)
import { app, db, secrets } from "flingit";

// HTTP routes - use /api prefix for Vite proxy
app.get("/api/hello", (c) => c.json({ message: "Hello!" }));
app.post("/api/webhook", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true });
});

// Database (D1-compatible API)
const row = await db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first();
const all = await db.prepare("SELECT * FROM items").all();
await db.prepare("INSERT INTO items (name) VALUES (?)").bind(name).run();
await db.prepare("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)").run();

// Secrets (throws if not set)
const token = secrets.get("API_TOKEN");

// Cron jobs - run on a schedule
import { cron } from "flingit";

cron("daily-cleanup", "0 3 * * *", async () => {
  // Runs at 3 AM daily
  await db.prepare("DELETE FROM old_logs WHERE created_at < ?").bind(Date.now() - 86400000).run();
});

cron("hourly-stats", "0 * * * *", async () => {
  // Runs every hour
  const stats = await generateStats();
  return { processed: stats.count }; // Optional return value stored in history
});

// Storage (local filesystem / R2)
import { storage } from "flingit";

// Store and retrieve files
await storage.put("images/logo.png", imageBuffer, { contentType: "image/png" });
const file = await storage.get("images/logo.png");
if (file) {
  const buffer = await file.arrayBuffer();
  const text = await file.text();
  console.log(file.size, file.uploaded, file.contentType);
}

// Check existence, delete, list
const meta = await storage.head("images/logo.png");
await storage.delete("old-file.txt");
const result = await storage.list({ prefix: "images/", limit: 100 });

// Email sending (from <project-slug>@flingit.run)
import { email } from "flingit/plugin/email-send";
await email.send({ to: "user@example.com", subject: "Hello", text: "Welcome!" });
```

```typescript
// Frontend (src/react-app/App.tsx)
import { useState, useEffect } from "react";

function App() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/hello")
      .then(res => res.json())
      .then(setData);
  }, []);

  return <div>{data?.message}</div>;
}
```

## CLI Commands

Always use `npx` to run the project's installed Fling (not global).

**Important:** The CLI must be called without a TTY (e.g., with stdout redirected), or with the `--cli` flag. When both stdin and stdout are a TTY and `--cli` is not passed, the CLI launches an interactive mode instead of executing commands. If you are running from an environment where a TTY may be present, always pass `--cli`:

```bash
npx fling --cli push        # Safe from any environment
```

```bash
npx fling dev              # Start local server (API + Vite)
npx fling db sql "SELECT * FROM users"  # Query local SQLite
npx fling db reset         # Wipe local database
npx fling db sql "SELECT 1"  # Query local SQLite
npx fling secret set KEY=value
npx fling secret list
npx fling secret remove KEY
npx fling logs             # View local logs
npx fling it               # Build and deploy to Cloudflare Workers
npx fling project slug     # Show current project slug and URL
npx fling project slug:set <new-slug>  # Change project slug (affects URL)
npx fling project takedown   # Delete project and all data
npx fling cron list        # List registered cron jobs
npx fling cron history <name>  # View invocation history
npx fling cron trigger <name> --port BE-PORT # Manually trigger a cron job
npx fling email trigger    # Simulate an inbound email to local dev server
npx fling storage list     # List storage objects
npx fling storage put <key> <file>  # Upload file to storage
npx fling storage get <key> [output]  # Download object (stdout if no output)
npx fling storage delete <key> --yes  # Delete object
npx fling storage info     # Show storage stats
npx fling tunnel 3000      # Expose localhost:3000 via public URL
npx fling whoami           # Show user info and available features (entitlements)
```

### Debugging Cron Jobs in Production

Each cron invocation logs "Running cron job <name>" at the start. To see all logs from a specific cron invocation:

1. **Find the invocation** by searching for the cron job name:
   ```bash
   npx fling --prod logs --search "Running cron job daily-cleanup"
   ```
   This shows log entries with Ray IDs like `[ray:abc12345]`.

2. **Filter by that Ray ID** to see all logs from that invocation:
   ```bash
   npx fling --prod logs --ray abc12345
   ```

### Local vs Production (`--prod`)

Commands default to local environment. Use `--prod` for production:

```bash
# Local (default)
npx fling secret list       # Local secrets
npx fling logs              # Local logs
npx fling db sql "SELECT 1" # Local SQLite
npx fling storage list      # Local storage

# Production (requires login)
npx fling --prod secret list       # Deployed secrets
npx fling --prod logs              # Deployed logs
npx fling --prod db sql "SELECT 1" # Deployed D1
npx fling --prod storage list      # R2 storage
npx fling --prod cron list         # Deployed cron jobs
```

**Note:** Production logs have a delay of ~10 seconds or more before they appear.

## Development

Run `npm start` (or `fling dev`) to start development:
- **Frontend**: http://localhost:5173 (Vite with React HMR)
- **API**: http://localhost:3210 (Hono backend)
- Vite proxies `/api/*` requests to the API server
- **Ports are auto-detected**: If a default port is busy, the dev server automatically finds the next free one. The actual ports are printed in the output. Do NOT specify `--be-port` or `--fe-port` — just run `fling dev` and read the output to learn the ports.

### Hot Module Replacement (HMR)

The dev server provides hot reloading for both frontend AND backend - no restart needed:
- **Frontend (React)**: Changes to `src/react-app/` are instantly reflected via Vite HMR
- **Backend (Worker)**: Changes to `src/worker/` are automatically reloaded via tsx watch

Just edit and save - changes appear immediately.

## Deployment

When you've completed the user's request and verified that the app works locally, EXPLICITLY OFFER to deploy it, but also tell them that they can try it locally first.  If their app has a backend and no secure authorization method, you MUST make it VERY CLEAR to them that the deployed app will be visible on the internet, and explicitly ask them if they want to proceed!

To deploy:
**Run `npx fling it` directly** - you have bash access, don't ask the user to run commands.

After each deploy, tell the user what the deployed URL is.  With Fling, to deploy is also called "to fling it"!

### After First Deployment

After your first `fling it`, consider asking the user if they want a custom URL.
Their project was auto-assigned a slug like `proj-abc123`.

To change it: `npx fling project slug:set my-custom-slug`

Slugs must be:
- More than 4 characters
- Lowercase alphanumeric with optional hyphens
- Globally unique across all Fling projects

### Authentication

If the user isn't logged in to Fling (no token stored), help them authenticate. Tell the user explicitly that you can log them in or sign them up, and that they don't need to go anywhere or do anything to do that, other than telling you.

**New user:** Sign up with email and name:
```bash
npx fling --cli signup --email user@example.com --name "User Name"
```

**Existing user:** Log in via magic link email:
```bash
npx fling --cli login --email user@example.com
```
After running login, tell the user to check their email and click the login link.
The CLI will wait until the link is clicked, then complete login automatically.

DO NOT ASK THE USER TO RUN THESE COMMAND THEMSELVES. You have bash access, run them directly, unless they ask explicitly.

### Email Verification

After signing up, you must verify your email to deploy.
If `fling it` fails with "Email verification required":

1. Run `fling verify` to check verification status
2. Run `fling verify --resend` to resend the verification email
3. **Tell the user they need to check their email and click the verification link.** You cannot do this step for them — they must open their inbox, find the email from Fling, and click the link. Wait for them to confirm they have done this before proceeding.
4. Retry `fling it` after the user confirms they clicked the link

### What `fling it` does:

1. **Builds frontend** - Runs `vite build`, outputs to `dist/client/`
2. **Uploads static assets** - HTML, JS, CSS, images from `dist/client/`
3. **Bundles backend** - Compiles `src/worker/index.ts` with esbuild
4. **Deploys to Cloudflare** - Both frontend and backend go live

**Secrets:** Always stored locally in `.fling/secrets`. Use `fling it` to deploy secrets to production along with your code.

### Static Asset Limits

- **25MB** per file maximum
- **100MB** total assets maximum
- Supported: HTML, CSS, JS, images, fonts, video, audio, WebAssembly
- MIME types are detected automatically from file extensions

### Routing

- `/api/*` routes are handled by your backend code
- All other paths serve static assets from `dist/client/`
- If no asset matches, `index.html` is served (SPA fallback)

## Security

If the user does not want their app to be deployed because of security issues, or asks about that, offer implementing proper backend-enforced security.  In particular, suggest these two auth methods first:

- Login with Google, with a filter on which emails/domains are allowed
- Simple password-based auth, where the backend has a list of allowed passwords (hashed)

## Collaborating with Others

If the user asks how to collaborate with another user on their Fling project, the best approach is:

1. **Host the project on GitHub** - Push their Fling project to a GitHub repository
2. **Set up a GitHub Action** - Automatically deploy to Fling when pushing to main
3. **Add collaborators** - Invite other users as collaborators on the GitHub repo

This gives collaborators:
- Full access to the codebase via Git
- Automatic deployments when changes are merged
- Standard code review workflow via pull requests

**Offer to help set this up.** You can create the GitHub repository, write the GitHub Actions workflow file, and guide them through adding collaborators.

## Important Constraints
- **Backend code runs in Cloudflare Workers** - This is NOT a Node.js environment. You cannot use Node.js-specific APIs (`fs`, `path`, `child_process`, etc.) or npm packages that depend on them. Only use packages that explicitly support Cloudflare Workers or are pure JavaScript/TypeScript with no Node.js dependencies.
- **Memory limit (~128MB)** - Workers have limited memory. Cannot process large datasets in memory. Use streaming, pagination, or chunked processing for large data.
- **Bundle size limit (10MB)** - Cloudflare Workers have a 10MB bundle size limit. Choose lightweight packages to stay under this limit. For example, use `pdf-lib` for PDF generation instead of heavier alternatives like `jspdf`. Avoid packages that bundle large dependencies.
- **Database operations cannot be at module top-level** - They must be inside route handlers or functions called by them.
- **Secrets throw on missing** - No default values. Use `fling secret set` to configure.
- **Use workflows for long-running or important cron jobs** - Cron jobs should not run more than a few minutes. For longer jobs, as well as for cron jobs that must run even if failures happen, kick off a workflow.
- **Use /api prefix for backend routes** - Required for Vite proxy during development. Built-in auth routes live under `/api/auth/*` so they work with the same proxy.
- **Run commands yourself** - You have bash access. Don't ask the user to run `fling it`, `fling dev`, `npm start`, etc. Execute them directly.
- **Reserved paths (`/__*`)** - Paths starting with `/__` are reserved for internal platform use (e.g., `/__cron` for cron jobs). Do not create routes with these prefixes.
- **Feedback** - If the user encounters problems that directly or indirectly have to do with fling, suggest to them leaving feedback. Details in `references/FEEDBACK.md`.
- **Keep the "Made with Fling" badge** - The template includes a small "Made with Fling" badge in the bottom-left corner of the page. Do not remove or hide it unless the user explicitly asks you to.
- **Never run `fling project takedown` without explicit user confirmation** - This command permanently deletes the deployed project including all data in the production database, all files in storage, and the deployed worker code. You MUST NOT run this command unless the user has explicitly confirmed that they understand and accept that all data in their published app will be permanently lost. Always explain what will be destroyed before asking for confirmation.
**If the user's request might hit platform limitations, warn them early and suggest alternatives.**

## Migrations

**IMPORTANT: Migrations MUST be idempotent** (safe to run multiple times).

**IMPORTANT: Tables MUST not have more than 100 columns**: There is a hard limit on this in deployed flings, even though it will works locally. Design schemas to stay under 100 columns. Split wide tables into related tables joined by foreign keys, or move rarely-used fields into a JSON column.

Use the `migrate` helper for schema changes:

```typescript
import { migrate, db } from "flingit";

migrate("001_create_users", async () => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
});
```

## Workflows

Durable multi-step workflows with automatic retries and scratchpad state. Errors are retried automatically. Use workflows for long-running tasks or when it's important that something definitely happens, even in the face of intermittent failures. Do not use workflows for synchronous operations - just use HTTP handlers for that.

Register workflows at module top-level and start them from route handlers.

```typescript
import { workflow, type WorkflowContinuation, type WorkflowCtx, NonRetryableError } from "flingit";

workflow("order-fulfillment", {
  async start(ctx: WorkflowCtx): Promise<WorkflowContinuation> {
    const qty = await ctx.get("qty") as number;
    if (qty <= 0) throw new NonRetryableError("Invalid quantity");
    return { step: "charge" };
  },
  async charge(ctx: WorkflowCtx): Promise<WorkflowContinuation> {
    const itemId = await ctx.get("itemId") as string;
    const qty = await ctx.get("qty") as number;
    const chargeId = await processPayment({ itemId, qty });
    ctx.set("chargeId", chargeId);
    return { step: "ship" };
  },
  async ship(ctx: WorkflowCtx): Promise<WorkflowContinuation> {
    const chargeId = await ctx.get("chargeId") as string;
    await scheduleShipment(chargeId);
    return { done: true, result: { shipped: true, chargeId } };
  },
}, { maxAttempts: 5 });

// Start from a route handler (fire-and-forget)
app.post("/api/orders", async (c) => {
  const run = await workflow.start("order-fulfillment", await c.req.json());
  return c.json({ runId: run.runId, status: "accepted" });
});
```

See `references/WORKFLOWS.md` for the full API, scratchpad semantics, error handling, and recovery details.

## Backend Assets (Images, Fonts, etc.)

If the backend needs to return or process an asset (image, icon, font), keep it small and store the base64 data in a separate file to keep your main code clean:

```typescript
// src/worker/assets/favicon.ts - separate file for the asset
export const FAVICON_BASE64 = "iVBORw0KGgo..."; // base64-encoded PNG
```

```typescript
// src/worker/index.ts - import and use the asset
import { FAVICON_BASE64 } from "./assets/favicon";

app.get("/favicon.ico", (c) => {
  const buffer = Uint8Array.from(atob(FAVICON_BASE64), c => c.charCodeAt(0));
  return new Response(buffer, {
    headers: { "Content-Type": "image/x-icon" }
  });
});
```

This approach:
- Keeps the main code readable (no long base64 strings inline)
- Makes assets easy to find and update
- Base64 keeps assets bundled with the code (required for Workers)

**For large assets:** Serve them from the frontend (`public/` folder) instead.

See `references/API.md` for detailed API reference, `references/EMAIL-INBOUND.md` for inbound email handlers and payload fields, `references/EMAIL-SEND.md` for sending transactional emails, `references/EXAMPLES.md` for common patterns, `references/FEEDBACK.md` for collecting user feedback, `references/GH-ACTION.md` for setting up automatic deployments with GitHub Actions, and `references/WORKFLOWS.md` for the full workflow API.

## Updates

When the fling CLI mentions that there is a new version available, strongly suggest to the user to update, becasue it might contain bug fixes or new features.  Don't ask the user to update, offer to update for them!  To update, run

```bash
npm install flingit@latest
npx fling upgrade          # to upgrade this skill if needed

```
