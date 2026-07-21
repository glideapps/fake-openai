# Auth Skill

Add Google sign-in to your Fling app. Users authenticate with their Google account, and you get their email, name, and profile picture.

## Quick Reference

```typescript
import { app, auth } from "flingit";

// Enable auth (all Google accounts can sign in)
auth.allow();

// Or restrict to specific email domains
auth.allow({ domains: ["company.com", "partner.org"] });

// Require auth on specific routes (returns 401 if not signed in)
app.use("/api/*", auth.require());

// Get the current user (returns null if not signed in)
app.get("/api/me", async (c) => {
  const user = await auth.user(c);
  // user: { email: string, name: string, picture?: string } | null
  return c.json(user);
});
```

## Built-in Routes

When you use any `auth` function, these routes are automatically added:

| Route | Purpose |
|-------|---------|
| `GET /api/auth/signin/google` | Redirects to Google sign-in when deployed; shows a dummy login form in `fling dev` |
| `POST /api/auth/signin/google` | Local dev only: accepts the dummy login form or cancel action |
| `GET /api/auth/callback` | Deployed only: handles the OAuth callback (sets session cookie) |
| `GET /api/auth/signout` | Clears the session cookie, redirects to app home |

## API

### `auth.allow(options?)`

Enable authentication. Call this at the top level of your worker code.

```typescript
// Allow all Google accounts
auth.allow();

// Restrict to specific email domains
auth.allow({ domains: ["company.com"] });

// Custom session duration (default: 30 days)
auth.allow({ sessionMaxAge: 3600 }); // 1 hour
```

### `auth.require()`

Returns Hono middleware that rejects unauthenticated requests with `401`.

```typescript
// Protect all /api routes
app.use("/api/*", auth.require());

// Protect a specific route
app.use("/admin/*", auth.require());
```

### `auth.user(c)`

Get the current user from a request context. Returns `null` if not signed in.

```typescript
app.get("/api/profile", async (c) => {
  const user = await auth.user(c);
  if (!user) {
    return c.json({ error: "Not signed in" }, 401);
  }
  return c.json({
    email: user.email,   // "user@example.com"
    name: user.name,     // "Jane Doe"
    picture: user.picture // "https://..." (may be undefined)
  });
});
```

## Common Patterns

### Public app with optional sign-in

```typescript
import { app, auth } from "flingit";

auth.allow();

app.get("/api/data", async (c) => {
  const user = await auth.user(c);
  if (user) {
    return c.json({ data: "personalized for " + user.name });
  }
  return c.json({ data: "public data" });
});
```

### Internal tool restricted to your company

```typescript
import { app, auth } from "flingit";

auth.allow({ domains: ["mycompany.com"] });
app.use("/api/*", auth.require());

app.get("/api/dashboard", async (c) => {
  const user = await auth.user(c);
  return c.json({ welcome: user!.name });
});
```

### Frontend sign-in link

```typescript
<a href="/api/auth/signin/google">Sign in with Google</a>
```

Or redirect programmatically:

```typescript
// Redirect to sign in, then come back to current page
window.location.href = `/api/auth/signin/google?redirect=${encodeURIComponent(window.location.pathname)}`;
```

### Sign out

```typescript
<a href="/api/auth/signout">Sign out</a>
```

## Local Development

In `fling dev`, `/api/auth/signin/google` shows a local-only dummy login screen instead of contacting Google. Enter an email and optional name, then click **Login** to create a local dev session. Click **Cancel** to return to the requested page with `auth_error=cancelled` and no session.

Local dummy login respects `auth.allow({ domains })`, so you can test allowed-domain behavior before deploying. It is only for development; deployed apps use the platform login worker and real Google OAuth.

## Notes

- Auth is **opt-in** — your app has zero auth overhead unless you call `auth.allow()`, `auth.require()`, or `auth.user()`
- Sessions last 30 days by default (configurable via `sessionMaxAge`)
- The deployed session cookie is `HttpOnly`, `Secure`, and `SameSite=Lax`; local dev omits `Secure` so browsers send the cookie over `http://localhost`
- No setup commands needed — auth works immediately after `fling push`
- Local `fling dev` can exercise authenticated app flows with the dummy login screen; real Google sign-in requires a deployed app because the platform login worker signs callback tokens with the deployed worker secret
- In private workers.dev deployments, auth redirects preserve the `/<project-slug>` path prefix automatically
