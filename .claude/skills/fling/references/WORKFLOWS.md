# Workflows

Durable multi-step workflows with automatic retries and scratchpad state. Workflows survive server restarts — progress is persisted to the database after every step. Errors are automatically retried with exponential backoff up to `maxAttempts` (default 5), unless thrown as `NonRetryableError`.

## Quick Start

```typescript
import { app, workflow, type WorkflowContinuation, type WorkflowCtx, NonRetryableError } from "flingit";

// 1. Register workflow at module top-level
workflow("onboarding", {
  async start(ctx: WorkflowCtx): Promise<WorkflowContinuation> {
    const email = await ctx.get("email") as string;
    const name = await ctx.get("name") as string;
    const id = await db.prepare("INSERT INTO users (email, name) VALUES (?, ?) RETURNING id")
      .bind(email, name).first<{ id: number }>();
    ctx.set("userId", id!.id);
    return { step: "sendWelcome" };
  },

  async sendWelcome(ctx: WorkflowCtx): Promise<WorkflowContinuation> {
    const userId = await ctx.get("userId") as number;
    await sendWelcomeEmail(userId);
    return { step: "provision" };
  },

  async provision(ctx: WorkflowCtx): Promise<WorkflowContinuation> {
    const userId = await ctx.get("userId") as number;
    const workspace = await createWorkspace(userId);
    return { done: true, result: { userId, workspaceId: workspace.id } };
  },
});

// 2. Start from a route handler (fire-and-forget)
app.post("/api/signup", async (c) => {
  const body = await c.req.json();
  const run = await workflow.start("onboarding", body);
  return c.json({ runId: run.runId, status: "accepted" });
});
```

## Defining Workflows

Register workflows at module top-level (like `cron` and `migrate`). Each workflow has a unique name and a set of named step handlers.

```typescript
import { workflow, type WorkflowContinuation, type WorkflowCtx } from "flingit";

workflow("my-workflow", {
  async start(ctx: WorkflowCtx): Promise<WorkflowContinuation> {
    // ... do work ...
    return { step: "stepTwo" };  // advance to next step
  },

  async stepTwo(ctx: WorkflowCtx): Promise<WorkflowContinuation> {
    // ... do work ...
    return { done: true, result: { success: true } };  // complete the workflow
  },
});
```

The first step must be named `start` — the engine always begins there. Each step must return a `WorkflowContinuation`:

```typescript
// Advance to another step
return { step: "next-step-name" };

// Complete the workflow with a result
return { done: true, result: { orderId: 123 } };
```

## WorkflowCtx

Every step handler receives a context object:

```typescript
interface WorkflowCtx {
  workflowId: string;   // User-provided logical workflow identity
  runId: string;        // System-generated unique run ID
  step: string;         // Current step name
  get(key: string): Promise<unknown>;  // Read from scratchpad
  set(key: string, value: unknown): void;  // Buffer a write to scratchpad
}
```

- `workflowId` is either the `id` you provided in `start()` options or an auto-generated UUID.
- `runId` is a system-generated UUID unique to this execution.

## Scratchpad

Use `ctx.set()` and `ctx.get()` to pass data between steps:

```typescript
async charge(ctx: WorkflowCtx): Promise<WorkflowContinuation> {
  const orderId = await ctx.get("orderId") as string;
  const chargeId = await processPayment(orderId);
  ctx.set("chargeId", chargeId);  // buffer a write
  return { step: "ship" };
}

async ship(ctx: WorkflowCtx): Promise<WorkflowContinuation> {
  const chargeId = await ctx.get("chargeId") as string;  // read previous value
  await scheduleShipment(chargeId);
  return { done: true, result: { shipped: true } };
}
```

**Persistence semantics:**
- Writes are buffered during step execution and persisted atomically when the step succeeds.
- If a step throws, all writes from that step are discarded.
- Values must be JSON-serializable.
- `ctx.get()` returns `undefined` for missing keys.

## Starting Workflows

```typescript
// Basic start — auto-generates a workflow ID
// The second argument provides initial scratchpad data (key-value pairs readable via ctx.get())
const run = await workflow.start("my-workflow", { key: "value" });

// With deduplication — same ID returns existing active run instead of creating a new one
const run = await workflow.start("my-workflow", { key: "value" }, { id: "order-42" });
if (!run.created) {
  console.log("Reusing existing run:", run.runId);
}
```

`workflow.start(name, data?, options?)` begins executing steps immediately in the background and returns a `WorkflowRun`. The `data` argument is an optional object of key-value pairs that become the initial scratchpad — each key is readable via `ctx.get()` in step handlers:

```typescript
interface WorkflowRun {
  runId: string;           // System-generated unique run ID
  workflowId: string;      // User-provided or auto-generated workflow ID
  name: string;            // Workflow definition name
  status: WorkflowStatus;  // "running" | "completed" | "failed"
  created: boolean;        // true if new run, false if reusing (dedup)
  createdAt: number;       // Epoch ms
  result(): Promise<unknown>;  // Wait for completion and return result
}
```

## Getting Results

Call `result()` on a `WorkflowRun` to wait for completion:

```typescript
const run = await workflow.start("order-fulfillment", { itemId: "abc", qty: 2 });
const outcome = await run.result();
// outcome = { status: "shipped", chargeId: "ch_123" }
```

`result()` throws if the workflow fails.

**Fire-and-forget:** If you don't need the result, just don't call `result()`. The workflow still runs to completion in the background.

```typescript
app.post("/api/enqueue", async (c) => {
  const body = await c.req.json();
  const run = await workflow.start("background-job", body);
  // Don't await result — workflow runs in background
  return c.json({ runId: run.runId, status: "accepted" });
});
```

## Querying

```typescript
// Get a specific run by run ID (returns WorkflowRun or null)
const run = await workflow.get(runId);
if (run) {
  console.log(run.status);  // "running" | "completed" | "failed"
  const result = await run.result();  // wait if still running
}

// List workflow runs with optional filters
const runs = await workflow.list({ name: "order-fulfillment", status: "running", limit: 10 });
for (const r of runs) {
  console.log(`${r.name} [${r.status}] runId=${r.runId}`);
}
```

**Filter options for `workflow.list()`:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Filter by workflow definition name |
| `status` | `"running" \| "completed" \| "failed"` | Filter by status |
| `limit` | `number` | Max results (default: 100) |

## Error Handling

Use `NonRetryableError` for errors that should immediately fail the workflow without retrying. Regular throws are retried automatically with exponential backoff up to `maxAttempts`.

```typescript
import { NonRetryableError } from "flingit";

async function validate(ctx: WorkflowCtx): Promise<WorkflowContinuation> {
  const qty = await ctx.get("qty") as number;

  // Non-retryable: bad input will never become valid
  if (qty <= 0) {
    throw new NonRetryableError("Invalid quantity");
  }

  // Regular throw: retried automatically (transient failure)
  const res = await fetch("https://api.example.com/check");
  if (!res.ok) {
    throw new Error("API temporarily unavailable");
  }

  return { step: "next" };
}
```

`NonRetryableError` constructor: `new NonRetryableError(message)`

- `message` — Error message string

## Options

Pass options as the third argument to `workflow()`:

```typescript
workflow("my-workflow", steps, {
  maxAttempts: 10,           // Max attempts per step (default: 5)
  initialBackoffMS: 2000,    // Delay after first failure (default: 1000)
  backoffMultiplier: 3,      // Exponential multiplier (default: 2)
  maxBackoffMS: 120000,      // Backoff cap (default: 60000)
  stepTimeoutMS: 600000,     // Per-step timeout in ms (default: 300000)
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `maxAttempts` | 5 | Maximum attempts per step before the workflow fails |
| `initialBackoffMS` | 1000 | Delay in ms after the first failure before retrying |
| `backoffMultiplier` | 2 | Multiplier applied to the backoff delay after each subsequent failure |
| `maxBackoffMS` | 60000 | Maximum backoff delay in ms (cap) |
| `stepTimeoutMS` | 300000 | Per-step timeout in milliseconds (5 minutes) |

**Exponential backoff:** Attempt 1 has no delay. After the first failure, the retry delay is `initialBackoffMS`. Each subsequent failure multiplies the delay by `backoffMultiplier`, up to `maxBackoffMS`. Formula: attempt N delay = min(initialBackoffMS * backoffMultiplier^(N-2), maxBackoffMS).

When a step exceeds `maxAttempts`, the entire workflow is marked as failed. When a step exceeds `stepTimeoutMS`, it is treated as a timed-out step and picked up by recovery.

The retry/backoff configuration is sealed into the `workflow_created` event at creation time, so changing options on the definition does not affect already-running workflows.

## Recovery

A recovery cron runs automatically every minute. It handles:

- **Timed-out steps** — Steps that exceeded `stepTimeoutMS` are retried.
- **Stuck workflows** — Workflows that stopped progressing (e.g., due to a server restart mid-step) are resumed from their last successful step.

No configuration needed — recovery is registered automatically when you define your first workflow.

## Best Practices

### Make steps idempotent

Steps are retried on failure or timeout. A step that has already partially completed will be re-executed from the beginning. Design steps so that running them twice produces the same result:

```typescript
// BAD: double-charges on retry
async charge(ctx) {
  const amount = await ctx.get("amount");
  await chargeCard(amount);
  return { step: "ship" };
}

// GOOD: check before charging
async charge(ctx) {
  const orderId = await ctx.get("orderId");
  const amount = await ctx.get("amount");
  const existing = await db.prepare("SELECT id FROM charges WHERE order_id = ?")
    .bind(orderId).first();
  if (!existing) {
    await chargeCard(amount);
    await db.prepare("INSERT INTO charges (order_id) VALUES (?)").bind(orderId).run();
  }
  return { step: "ship" };
}
```

### Keep scratchpad data small

Every `ctx.set()` call is persisted in the event log. Keep total scratchpad data per workflow under **1 MB**. For large blobs, write to storage instead and store only the key in the scratchpad:

```typescript
// BAD: storing a large blob in the scratchpad
ctx.set("reportData", hugeJsonObject); // Could be megabytes

// GOOD: store in R2, keep only the reference
await storage.put(`reports/${ctx.runId}.json`, JSON.stringify(hugeJsonObject));
ctx.set("reportKey", `reports/${ctx.runId}.json`);
```

### Keep steps bounded

Each step should do a bounded amount of work. If you need to process a large dataset, make each step handle a batch and continue in the next step:

```typescript
workflow("process-rows", {
  async start(ctx) {
    ctx.set("cursor", 0);
    ctx.set("processed", 0);
    return { step: "batch" };
  },
  async batch(ctx) {
    const cursor = await ctx.get("cursor") as number;
    const processed = await ctx.get("processed") as number;
    const BATCH_SIZE = 100;

    const { results } = await db.prepare(
      "SELECT * FROM items WHERE id > ? ORDER BY id LIMIT ?"
    ).bind(cursor, BATCH_SIZE).all();

    for (const row of results) {
      await processItem(row);
    }

    const newCursor = results.length > 0 ? results[results.length - 1].id : cursor;
    ctx.set("cursor", newCursor);
    ctx.set("processed", processed + results.length);

    if (results.length < BATCH_SIZE) {
      return { done: true, result: { total: processed + results.length } };
    }
    return { step: "batch" }; // continue with next batch
  },
});
```

## Key Constraints

- **Register at top level** — `workflow()` must be called at module top level, not inside functions or route handlers.
- **Unique names** — Each workflow definition must have a unique name.
- **First step must be named `start`** — The flingflow engine always begins execution with the step named `start`.
- **Scratchpad is JSON-only** — Values passed to `ctx.set()` must be JSON-serializable.
- **Scratchpad is not for storing large blobs** — Use storage for large blobs. A workflow run should not write more than about 1MB of data to the scratchpad over the course of its run.
- **Steps should not retry failures** — The workflow system has retries built in, so steps can just throw when errors occur, and they will be retried automatically.
- **Workflow steps should do a finite amount of work** — Steps should not do much more than a minute's worth of work each.
- **No more than hundreds of steps** — A workflow execution can run hundreds, but not thousands of steps. If you need more than that, leave feedback, see `references/FEEDBACK.md`.
- **`_workflow_events` is reserved** — The workflow engine automatically creates and manages this table. Do not create or modify it.

## CLI Commands

Manage workflows from the command line:

```bash
# List recent workflow runs
fling workflow list                # Local (reads SQLite)
fling workflow list --prod         # Deployed (reads D1)
fling workflow list --limit 50     # More runs

# Show step-by-step events for a run
fling workflow show <runId>        # Brief: event types, steps, times
fling workflow show <runId> -v     # Verbose: includes scratchpad writes and results
fling workflow show <runId> --prod # Deployed run

# Start a new workflow run
fling workflow start <name>                           # No initial data
fling workflow start <name> --input '{"key":"val"}'   # Initial scratchpad data (JSON)
fling workflow start <name> --input - < data.json     # Data from stdin
fling workflow start <name> --id my-dedup-key         # Custom ID for deduplication
fling workflow start <name> --prod                    # Start on deployed worker
```

Local commands require `fling dev` to be running (for `start`). Use `--port` if the dev server runs on a non-default port.
