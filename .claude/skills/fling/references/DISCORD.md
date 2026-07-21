# Discord Skill

Build Discord chatops bots with Fling. Handle slash commands, send messages, and process interaction payloads — all from your Fling project.

## Setup

Discord requires a one-time setup before use:

```bash
npx fling plugin install discord    # Connect Discord account + add bot to a server (opens browser)
npx fling it                        # Deploy code
```

Run these commands yourself — you have bash access.

## Quick Reference

```typescript
import { app } from "flingit";
import { discord } from "flingit/plugin/discord";

// 1. Handle slash commands using onCommand(name, description, handler)
//    Commands are auto-registered with Discord on `fling push`
discord.onCommand("ping", "Check if the bot is alive", async (interaction) => {
  await discord.reply(interaction, {
    content: "Pong!",
    ephemeral: true  // Only visible to the user who ran the command
  });
});

discord.onCommand("deploy", "Deploy a branch", [
  { name: "branch", type: "string", description: "Branch to deploy", required: false },
], async (interaction, options) => {
  const branch = options.getString("branch") ?? "main";
  await discord.reply(interaction, {
    content: `Deploying ${branch}...`
  });

  // Do work after the initial reply...
  const result = await runDeploy(branch);

  // Send an additional followup message
  await discord.followup(interaction, {
    content: `Deployed ${branch}: ${result}`
  });
});

// 2. Send messages proactively (e.g., from webhooks or cron)
app.post("/api/notify", async (c) => {
  const { channelId, text } = await c.req.json();

  await discord.sendMessage({
    channelId,
    content: text
  });

  return c.json({ sent: true });
});
```

## API Reference

All methods are imported from `"flingit/plugin/discord"`:

```typescript
import { discord } from "flingit/plugin/discord";
```

### discord.onCommand(name, description, handler)
### discord.onCommand(name, description, options, handler)

Register a handler for a specific slash command. Commands are **automatically registered** with Discord when you run `fling push` — no need to use the Discord Developer Portal.

```typescript
// Simple command (no parameters)
discord.onCommand("ping", "Check if the bot is alive", async (interaction, options) => {
  await discord.reply(interaction, "Pong!");
});

// Command with parameters — Discord shows autocomplete & validation
discord.onCommand("deploy", "Deploy a branch", [
  { name: "branch", type: "string", description: "Branch to deploy" },
  { name: "force", type: "boolean", description: "Force deploy", required: false },
], async (interaction, options) => {
  const branch = options.getString("branch") ?? "main";
  const force = options.getBoolean("force") ?? false;
  await discord.reply(interaction, `Deploying ${branch}${force ? " (force)" : ""}...`);
});
```

**Supported option types:**

| Type | Discord type | Value |
|------|-------------|-------|
| `"string"` | STRING (3) | `options.getString("name")` |
| `"integer"` | INTEGER (4) | `options.getNumber("name")` |
| `"boolean"` | BOOLEAN (5) | `options.getBoolean("name")` |
| `"number"` | NUMBER (10) | `options.getNumber("name")` |

**Option properties:**
- `name` — Parameter name (required)
- `type` — One of `"string"`, `"integer"`, `"boolean"`, `"number"` (required)
- `description` — Shown in Discord's UI (required)
- `required` — Defaults to `true`. Set `false` for optional parameters.
- `choices` — Enum-style choices: `[{ name: "Production", value: "prod" }, { name: "Staging", value: "staging" }]`

**Choices example:**

```typescript
discord.onCommand("env", "Switch environment", [
  {
    name: "target",
    type: "string",
    description: "Target environment",
    choices: [
      { name: "Production", value: "prod" },
      { name: "Staging", value: "staging" },
      { name: "Development", value: "dev" },
    ],
  },
], async (interaction, options) => {
  const target = options.getString("target")!;
  await discord.reply(interaction, `Switching to ${target}`);
});
```

The platform verifies Discord's cryptographic signature before forwarding to your code — you don't need to handle that.

### discord.onEvent(handler)

Register a fallback handler for interactions that don't match any `onCommand`. Use for advanced cases.

```typescript
discord.onEvent(async (interaction) => {
  // Called for any interaction not handled by onCommand
});
```

### discord.reply(interaction, options)

Reply to a slash command. This edits the initial "thinking..." message that Discord shows while your handler runs. There is no strict time constraint — the platform automatically defers the response for you.

```typescript
discord.reply(interaction, {
  content: "Hello!",              // Text content (max 2000 chars)
  ephemeral: true,                // Only visible to command user (optional)
  embeds: [{                      // Rich embeds (optional, max 10)
    title: "Status",
    description: "All systems operational",
    color: 0x00ff00
  }]
});
```

### discord.followup(interaction, options)

Send additional messages after the initial reply.

```typescript
discord.reply(interaction, { content: "Working on it..." });

// ... do async work ...

const msg = await discord.followup(interaction, {
  content: "Done! Here are the results.",
  embeds: [{ title: "Results", description: resultText }]
});
// Returns: { id, channelId, content }
```

### discord.sendMessage(options)

Send a message to any channel in a claimed server. Use this for notifications, alerts, or proactive messages.

```typescript
const msg = await discord.sendMessage({
  channelId: "123456789012345678",
  content: "Deployment complete!",
  embeds: [{
    title: "Deploy Report",
    description: "v2.1.0 is now live",
    color: 0x00ff00,
    fields: [
      { name: "Duration", value: "42s", inline: true },
      { name: "Status", value: "Success", inline: true }
    ],
    timestamp: new Date().toISOString()
  }]
});
// Returns: { id, channelId, content }
```

The channel must be in a server claimed by your project.

### discord.editMessage(channelId, messageId, options)

Edit a previously sent message.

```typescript
const msg = await discord.sendMessage({
  channelId: channel,
  content: "Deploying..."
});

// Later, update it
await discord.editMessage(channel, msg.id, {
  content: "Deploy complete!",
  embeds: [{ title: "Done", color: 0x00ff00 }]
});
```

### discord.addReaction(channelId, messageId, emoji)

Add an emoji reaction to a message.

```typescript
await discord.addReaction(channelId, messageId, "✅");
await discord.addReaction(channelId, messageId, "🚀");
```

## Embeds

Rich embeds support these fields:

```typescript
const embed: DiscordEmbed = {
  title: "Title text",
  description: "Body text (supports markdown)",
  color: 0xff5733,              // Hex color as number
  url: "https://example.com",   // Makes title a link
  timestamp: new Date().toISOString(),
  footer: { text: "Footer text", icon_url: "https://..." },
  author: { name: "Author", url: "https://...", icon_url: "https://..." },
  fields: [                     // Up to 25 fields
    { name: "Field 1", value: "Value 1", inline: true },
    { name: "Field 2", value: "Value 2", inline: true }
  ]
};
```

Content max: 2000 characters. Embeds max: 10 per message.

## Reading Command Options

The `options` helper provides typed accessors for command options. Declare options in the `onCommand` call so Discord shows parameter hints and validation:

```typescript
discord.onCommand("deploy", "Deploy a branch", [
  { name: "branch", type: "string", description: "Branch to deploy" },
  { name: "force", type: "boolean", description: "Force deploy", required: false },
  { name: "count", type: "integer", description: "Number of instances", required: false },
], async (interaction, options) => {
  const branch = options.getString("branch") ?? "main";
  const force = options.getBoolean("force") ?? false;
  const count = options.getNumber("count") ?? 1;

  await discord.reply(interaction, {
    content: `Deploying ${branch}${force ? " (force)" : ""} (×${count})...`
  });
});
```

## Interaction Context

Access who ran the command and where:

```typescript
discord.onCommand("info", "Show context info", async (interaction) => {
  // Who ran it
  const user = interaction.member?.user;  // In servers
  // user.id, user.username

  // Where
  const guildId = interaction.guild_id;     // Server ID
  const channelId = interaction.channel_id; // Channel ID

  // Permissions
  const roles = interaction.member?.roles;        // Role IDs
  const perms = interaction.member?.permissions;  // Permission bitfield
});
```

## CLI Commands

```bash
# Setup
npx fling plugin install discord      # Connect Discord (OAuth), auto-claims server

# Status
npx fling plugin permissions discord  # Show connection status + servers

# Deployment
npx fling it

# Teardown
npx fling plugin remove discord       # Disconnect, release all servers
```

## How It Works

1. **`fling plugin install discord`** opens a browser for Discord OAuth. You authorize Fling, select a server to add the bot to, and that server is automatically claimed for your project.
2. **`discord.onCommand(name, description, handler)`** registers a named command handler with a description.
3. **`fling push`** bundles your code, deploys it, then automatically registers your slash commands with Discord's API for each claimed server. Commands appear instantly in Discord's slash command picker.
4. When a user runs a slash command, Discord sends it to the platform, which routes it to your worker.
5. Your handler receives the interaction and calls `discord.reply()` to respond.
6. To add the bot to additional servers, re-run `fling plugin install discord` (remove and reinstall to re-OAuth), then `fling push` again to register commands in the new server.

## Important Constraints

1. **Discord features only work in deployed workers** — They throw errors locally. Use `fling push` to deploy, then test in Discord.

2. **Channels must be in claimed servers** — `sendMessage()`, `editMessage()`, and `addReaction()` only work in channels belonging to servers claimed by your project.

3. **One project per server** — A Discord server can only be claimed by one Fling project at a time.

4. **Plugin must be installed first** — Run `fling plugin install discord` before using any Discord features. Check with `fling plugin permissions discord`.

5. **Rate limit: 3 per 60 seconds per project** — `reply`, `followup`, `sendMessage`, `editMessage`, and `addReaction` all count as "things". When exceeded, methods throw an error containing `PLUGIN_RATE_LIMIT_EXCEEDED`.

```typescript
try {
  await discord.sendMessage({ channelId, content: "Update" });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("PLUGIN_RATE_LIMIT_EXCEEDED")) {
    // Back off and retry in the next window.
    return;
  }
  throw error;
}
```
