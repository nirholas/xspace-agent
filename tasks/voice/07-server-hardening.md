# Voice Task 07 — Server hardening: helmet, strict CORS, body limits, HSTS

## Context

`server.js` currently:

- Has `cors: { origin: "*", methods: ["GET", "POST"] }` on the Socket.IO
  server — open to any origin.
- Has `app.use(express.json())` with no size limit (default 100 kb, but
  explicit is safer).
- Has no security headers (no helmet, no CSP, no HSTS).
- Has no body-size limit on the `/tts/:id/stream` POST (the EL endpoint's
  `text` cap is per-field, not per-request).

The deployment runs behind Railway in production. We need standard hardening
without breaking the existing UI.

**Run after Voice Task 06 (cost guardrails) — both touch `server.js`.**

## Requirements

### 1. Helmet

Add `helmet` and configure it:

```js
const helmet = require("helmet")
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src":  ["'self'"],
      "script-src":   ["'self'", "'unsafe-inline'"],  // inline scripts in our HTML
      "style-src":    ["'self'", "'unsafe-inline'"],
      "img-src":      ["'self'", "data:", "https:"],
      "connect-src":  ["'self'", "https://api.openai.com", "wss://api.openai.com", "https://api.elevenlabs.io"],
      "media-src":    ["'self'", "blob:"],
      "frame-ancestors": ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,   // breaks WebRTC otherwise
}))
```

If any operator page breaks (CSP violations in DevTools console), prefer
adding the missing source to the policy over loosening it broadly. Document
each addition with a one-line comment.

### 2. Strict CORS

Replace `origin: "*"` with an allow-list driven by `CORS_ORIGINS`:

```js
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:3000").split(",").map(s => s.trim()).filter(Boolean)

const io = new Server(server, {
  cors: { origin: CORS_ORIGINS, methods: ["GET", "POST"], credentials: true },
  // ...
})

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin (no Origin header) and explicit allow-listed origins.
    if (!origin) return cb(null, true)
    if (CORS_ORIGINS.includes(origin)) return cb(null, true)
    return cb(new Error("CORS blocked: " + origin))
  },
  credentials: true,
}))
```

The `cors` package is already used elsewhere in the monorepo — pull it in
as a top-level dep if it isn't one already. (Don't add a redundant copy if
Express CORS handling is done by Socket.IO's own middleware for everything;
in that case the `app.use(cors(…))` is still needed for the HTTP routes.)

### 3. Body-size limits

Two places:

- `app.use(express.json({ limit: "32kb" }))` — replaces the existing
  `express.json()` line. Even our largest legitimate POST is `/tts/:id/stream`
  with ~1500 chars of text plus voice id ≈ ~1.7 kb.
- Add explicit `limit: "8kb"` on any `express.urlencoded(...)` if present.

### 4. HSTS

Helmet enables HSTS by default with `maxAge=180days`. Bump to:

```js
hsts: { maxAge: 60 * 60 * 24 * 365, includeSubDomains: true, preload: false }
```

Only enable HSTS when the request arrived over HTTPS (Helmet handles this
automatically based on `req.secure`, which works behind Railway's proxy if
we set `app.set("trust proxy", true)` — do this at the top).

### 5. `trust proxy`

Add `app.set("trust proxy", 1)` near the top so:

- `req.ip` returns the real client IP (matters for our token-bucket rate
  limit — currently a single proxy IP would share a bucket across all users).
- `req.secure` reflects the actual scheme.

### 6. Don't break

- The inline login page injected by `loginPageHtml` uses a `<style>` block —
  `'unsafe-inline'` in `style-src` keeps it working. Don't remove that
  directive.
- `window.AGENT_AUTH_KEY` is injected via an inline `<script>` —
  `'unsafe-inline'` in `script-src` keeps it working. (Long term: move to a
  nonce. Out of scope.)
- WebRTC media playback uses `blob:` URLs — `media-src: blob:` keeps the EL
  audio playing.

## Files to Modify

- `server.js` — top of the file, after the existing `express` setup.
- `package.json` — add `helmet` and `cors` as deps (verify via `pnpm i`).
- `.env.example` — already documents `CORS_ORIGINS`; verify the example value
  is sane and update its comment to clarify it now strictly enforces.

## Files NOT to Touch

- All operator HTML (CSP changes should not require HTML edits if the policy
  is right).
- `public/js/**`
- `providers/**`
- `packages/**`

## Acceptance Criteria

- [ ] `pnpm run dev` boots without errors.
- [ ] Loading `/server-agent1?tts=elevenlabs&key=<correct>` in a browser works
      end-to-end: connect, talk, hear EL voice. No CSP violations in DevTools.
- [ ] A `curl -H "Origin: https://evil.com" http://localhost:3000/voices?key=…`
      is blocked.
- [ ] Sending a 50 kb JSON body to `/tts/0/stream` returns 413.
- [ ] `curl -I http://localhost:3000/` shows `Content-Security-Policy`,
      `X-Content-Type-Options`, `Strict-Transport-Security` (when on HTTPS),
      `Referrer-Policy`.
- [ ] Behind Railway, the rate-limit per-IP works correctly (you can verify
      locally by setting `app.set("trust proxy", true)` and sending an
      `X-Forwarded-For` header).

## Don'ts

- Don't disable `crossOriginOpenerPolicy` or `crossOriginResourcePolicy` — only
  `crossOriginEmbedderPolicy`, which is the one that breaks WebRTC.
- Don't add nonce-based CSP yet. Inline scripts work with `'unsafe-inline'`;
  nonces are a follow-up.
- Don't enable HSTS preload unless we're ready to commit (it's hard to undo).
- Don't introduce `express-rate-limit`. Our token-bucket already exists for
  the cost-sensitive endpoint; a global rate limit is a separate concern.
