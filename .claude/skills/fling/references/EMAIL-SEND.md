# Email Sending

Send transactional emails from your Fling project. No setup required — email sending is auto-available on all deployed projects.

## Quick Reference

```typescript
import { email } from "flingit/plugin/email-send";

// Simple text email
await email.send({
  to: "user@example.com",
  subject: "Welcome!",
  text: "Thanks for signing up.",
});

// HTML email with multiple recipients
await email.send({
  to: ["alice@example.com", "bob@example.com"],
  cc: ["manager@example.com"],
  bcc: ["audit@example.com"],
  replyTo: "support@myapp.com",
  subject: "Weekly report",
  html: "<h1>Report</h1><p>All good.</p>",
});
```

## API Reference

### `email.send(options)`

Send a transactional email.

**Parameters:**

```typescript
interface SendEmailOptions {
  /** Recipient email address(es). Required, at least one. */
  to: string | string[];
  /** Email subject line. Required. */
  subject: string;
  /** Plain text body. At least one of text or html required. */
  text?: string;
  /** HTML body. At least one of text or html required. */
  html?: string;
  /** CC recipient(s). */
  cc?: string | string[];
  /** BCC recipient(s). */
  bcc?: string | string[];
  /** Reply-to address. */
  replyTo?: string;
}
```

**Returns:**

```typescript
interface SendEmailResult {
  /** Whether the email was sent successfully. */
  success: boolean;
  /** Message ID from the email provider. */
  messageId?: string;
}
```

## From Address

All emails are sent from `<project-slug>@flingit.run`. This matches the address used for inbound email (`onEmail`).

To set a custom reply address, use the `replyTo` field:

```typescript
await email.send({
  to: "user@example.com",
  replyTo: "support@mycompany.com",
  subject: "Hello",
  text: "Reply to this email to reach our support team.",
});
```

## Error Handling

`email.send()` throws on failure. Common error scenarios:

```typescript
try {
  await email.send({
    to: "user@example.com",
    subject: "Hello",
    text: "Hi there",
  });
} catch (err) {
  if (err.message.includes("PLUGIN_RATE_LIMIT_EXCEEDED")) {
    // Rate limit hit — wait and retry
    console.log("Rate limited, will retry later");
  } else {
    console.error("Failed to send email:", err.message);
  }
}
```

## Local Development

In `fling dev`, `email.send()` logs the email details to the console instead of actually sending. This lets you develop and test email flows without sending real emails.

```
[email] Local dev — would send email:
  To: user@example.com
  Subject: Welcome!
  Body: Thanks for signing up.
```

## Important Constraints

- **Rate limit**: 3 email sends per 60 seconds per project (counts API calls, not recipients)
- **Recipients**: Max 50 total across to + cc + bcc combined per send
- **No attachments**: V1 supports text and HTML bodies only
- **No templates**: Build HTML in your code or use a templating library
- **Deployed only**: Real email sending only works in deployed workers (`fling push`). Local dev logs to console.
- **Subject length**: Max 998 characters (RFC 5322)
- **Body size**: Max 1MB each for text and HTML
