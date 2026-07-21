# Inbound Email (`onEmail`)

Fling supports inbound email handlers in user workers.

**Note:** Email receiving is not enabled by default. Run `fling whoami` to check whether it is available for your account.

If an email is sent to:

`<project-slug>@flingit.run`

the platform parses the message and dispatches it to your worker's internal email endpoint, which invokes your registered `onEmail` handler.

Only one `onEmail` handler can be registered. The handler must complete within 30 seconds or the delivery will be treated as a failure and retried.

## Basic Usage

```typescript
import { onEmail } from "flingit";

onEmail(async (email) => {
  console.log("From:", email.from.address);
  console.log("Subject:", email.subject);

  // Example: only process emails with text content
  if (!email.text) return;

  // Your processing logic here
});
```

## Local Testing

Use `fling email trigger` to simulate an inbound email to your local dev server:

    npx fling email trigger --from alice@test.com --subject "Hello" --text "Hi there"

All flags are optional with sensible defaults. Available flags:
- `--from` — sender address (default: test@example.com)
- `--to` — recipient address (default: project@flingit.run)
- `--subject` — email subject (default: Test email)
- `--text` — plain text body
- `--html` — HTML body (suppresses default text when used alone)
- `--port` — dev server port (default: 3210)

Requires `fling dev` to be running.

## `InboundEmail` Fields

`onEmail` receives this payload shape:

```typescript
type InboundEmail = {
  from: { name: string; address: string };
  to: string;
  cc: Array<{ name: string; address: string }>;
  replyTo: Array<{ name: string; address: string }>;
  subject: string;
  text: string | null;
  html: string | null;
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  headers: Record<string, string>;
  attachments: Array<{
    filename: string | null;
    mimeType: string;
    size: number;
    content: string; // base64
  }>;
};
```

Field notes:

- `from`: Sender display name + email address.
- `to`: Full envelope recipient (for example, `my-project@flingit.run`).
- `cc`: Parsed CC recipients.
- `replyTo`: Parsed Reply-To addresses.
- `subject`: Email subject (empty string if missing).
- `text`: Plain text body when available.
- `html`: HTML body when available.
- `date`: ISO 8601 date string when available.
- `messageId`: Parsed Message-ID header.
- `inReplyTo`: Parsed In-Reply-To header.
- `references`: Parsed References header.
- `headers`: Selected useful headers as a lowercase-key map.
- `attachments`: Attachments with base64 content and metadata.

## Which Headers Are Included?

`headers` includes selected keys (when present), not every raw header:

- `message-id`
- `in-reply-to`
- `references`
- `reply-to`
- `list-unsubscribe`
- `list-id`
- `x-mailer`
- `content-type`

## Example: Store Incoming Emails

```typescript
import { db, migrate, onEmail } from "flingit";

migrate("001_create_received_emails", async () => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS received_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT,
      received_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
});

onEmail(async (email) => {
  await db.prepare(
    "INSERT INTO received_emails (from_address, subject, body_text) VALUES (?, ?, ?)"
  )
    .bind(email.from.address, email.subject, email.text ?? "")
    .run();
});
```
