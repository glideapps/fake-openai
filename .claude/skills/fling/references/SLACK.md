# Slack Skill

Build Slack chatops bots with Fling. Respond to @mentions, send messages, and react to events — all from your Fling project.

## Setup

Slack requires a one-time setup before use:

```bash
npx fling plugin install slack    # Connect Slack workspace (opens browser)
npx fling it                      # Deploy code
```

Run these commands yourself — you have bash access.

## Quick Reference

```typescript
import { app } from "flingit";
import { slack } from "flingit/plugin/slack";

// 1. Handle @mentions of your bot
slack.onMention(async (event) => {
  // Parse the mention text (remove the bot mention prefix)
  const text = event.text.replace(/<@[A-Z0-9]+>\s*/, "").trim();

  if (text.startsWith("deploy")) {
    const branch = text.split(" ")[1] ?? "main";
    await slack.sendMessage({
      channelId: event.channel,
      threadTs: event.ts,
      text: `Deploying ${branch}...`,
    });
  } else {
    await slack.sendMessage({
      channelId: event.channel,
      threadTs: event.ts,
      text: "Hello! How can I help?",
    });
  }
});

// 2. Send messages proactively (e.g., from webhooks or cron)
app.post("/api/notify", async (c) => {
  const { channelId, text } = await c.req.json();

  await slack.sendMessage({
    channelId,
    text
  });

  return c.json({ sent: true });
});
```

## API Reference

All methods are imported from `"flingit/plugin/slack"`:

```typescript
import { slack } from "flingit/plugin/slack";
```

### slack.onMention(handler)

Register a handler for @mentions of your bot. Triggered when someone mentions your Fling app in a channel.

```typescript
slack.onMention(async (event) => {
  // event.channel = which channel
  // event.user = who mentioned the bot
  // event.text = full mention text (includes <@BOT_ID>)
  // event.ts = message timestamp
  // event.thread_ts = thread timestamp (if in thread)

  await slack.sendMessage({
    channelId: event.channel,
    threadTs: event.ts,  // Reply in thread
    text: "Got it!",
  });
});
```

The platform verifies Slack's HMAC-SHA256 signature before forwarding to your code — you don't need to handle that.

### slack.onEvent(handler)

Register a fallback handler for raw Slack events that aren't handled by `onMention`. Use this for advanced cases.

```typescript
slack.onEvent(async (event) => {
  console.log("Raw event:", event.type);
});
```

### slack.sendMessage(options)

Send a message to any channel. Use this for notifications, alerts, or proactive messages.

```typescript
const msg = await slack.sendMessage({
  channelId: "C123456789",
  text: "Deployment complete!",
  blocks: [{
    type: "section",
    text: { type: "mrkdwn", text: "*Deploy Report*\nv2.1.0 is now live" }
  }]
});
// Returns: { channelId, ts, text }
```

To reply in a thread:

```typescript
await slack.sendMessage({
  channelId: "C123456789",
  text: "Thread reply here",
  threadTs: "1234567890.123456"  // Parent message timestamp
});
```

### slack.editMessage(channelId, ts, options)

Edit a previously sent message.

```typescript
const msg = await slack.sendMessage({
  channelId: channel,
  text: "Deploying..."
});

// Later, update it
await slack.editMessage(channel, msg.ts, {
  text: "Deploy complete!"
});
```

### slack.addReaction(channelId, ts, emoji)

Add an emoji reaction to a message.

```typescript
await slack.addReaction(channelId, ts, "white_check_mark");
await slack.addReaction(channelId, ts, "rocket");
```

Note: Use emoji names without colons (e.g., `"thumbsup"` not `":thumbsup:"`).

## Block Kit

Slack uses Block Kit for rich message formatting. Common block types:

```typescript
// Section block with markdown
{
  type: "section",
  text: { type: "mrkdwn", text: "*Bold* and _italic_" }
}

// Section with fields
{
  type: "section",
  fields: [
    { type: "mrkdwn", text: "*Status:*\nActive" },
    { type: "mrkdwn", text: "*Region:*\nus-east-1" }
  ]
}

// Divider
{ type: "divider" }

// Context (small text)
{
  type: "context",
  elements: [
    { type: "mrkdwn", text: "Deployed by <@U123> at 3:42 PM" }
  ]
}
```

For more block types, see the Slack Block Kit documentation.

## CLI Commands

```bash
# Setup
npx fling plugin install slack         # Connect Slack (OAuth), auto-claims workspace

# Status
npx fling plugin permissions slack     # Show connection status + workspaces

# Deployment
npx fling it

# Teardown
npx fling plugin remove slack          # Disconnect, release all workspaces
```

## How It Works

1. **`fling plugin install slack`** opens a browser for Slack OAuth. You authorize the Fling app for your workspace, and it's automatically claimed for your project.
2. **`slack.onMention(handler)`** registers a handler that receives `app_mention` events when someone @mentions your bot in a channel.
3. The platform verifies Slack's HMAC-SHA256 signature, looks up the owning project, and forwards the event to your worker.
4. Your handler receives the event and uses `slack.sendMessage()` to respond (typically replying in-thread).

## Important Constraints

1. **Slack features only work in deployed workers** — They throw errors locally. Use `fling push` to deploy, then test in Slack.

2. **Mention-based interaction** — Users interact with your bot by @mentioning it in a channel. Parse the mention text to understand intent.

3. **One project per workspace** — A Slack workspace can only be claimed by one Fling project at a time.

4. **Plugin must be installed first** — Run `fling plugin install slack` before using any Slack features. Check with `fling plugin permissions slack`.

5. **Rate limit: 3 per 60 seconds per project** — `sendMessage`, `editMessage`, `addReaction`, and thread replies all count as "things". When exceeded, methods throw an error containing `PLUGIN_RATE_LIMIT_EXCEEDED`.

```typescript
try {
  await slack.sendMessage({ channelId, text: "Update" });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("PLUGIN_RATE_LIMIT_EXCEEDED")) {
    // Back off and retry in the next window.
    return;
  }
  throw error;
}
```
