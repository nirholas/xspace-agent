# Task: Cloudflare Tunnel + Optional Vercel Static Split

## Context
Right now the dashboard is reachable only via SSH port-forward from the
GCP VM (`gcloud compute ssh swarm-agent --zone=us-central1-a -- -L 3000:localhost:3000`).
That works for one operator on one laptop. It does not work for:
- A second operator on a phone during a live show.
- A read-only audience link.
- Resilience against the VM's external IP changing.

We also discussed splitting: keep the WebSocket server on the VM, but
serve the static dashboard from Vercel for the deploy benefits. The
auth gate that just shipped makes this safe to expose.

## Goal
Two deliverables:
1. **Cloudflare Tunnel** so the dashboard is reachable from any browser
   over HTTPS at a stable hostname, with no inbound firewall changes
   on the VM and no TLS cert management.
2. **(Optional) Vercel split** — a separate repo or branch that serves
   `public/dashboard.*` and points its API base at the tunneled VM URL.

After #1 the system is fine for most teams. #2 is only worth it if the
operator wants the dashboard to outlive the VM, or to deploy dashboard
edits independently of the server.

## Why now
Production hardening. The auth + audit work makes "expose to the
internet" safe. Without TLS, the dashboard can't be opened from any
device other than the SSH-forwarder.

## Part 1: Cloudflare Tunnel

### On the VM
- Install `cloudflared` (deb package, or the official install script).
- Authenticate: `cloudflared tunnel login` (opens a browser link to
  approve once).
- Create a named tunnel: `cloudflared tunnel create xspace-dashboard`.
- DNS: point a hostname at the tunnel via `cloudflared tunnel route dns
  xspace-dashboard dashboard.yourdomain.com`.
- Config file at `/etc/cloudflared/config.yml`:
  ```yaml
  tunnel: xspace-dashboard
  credentials-file: /etc/cloudflared/<tunnel-uuid>.json
  ingress:
    - hostname: dashboard.yourdomain.com
      service: http://127.0.0.1:3000
    - service: http_status:404
  ```
- Install as a service: `sudo cloudflared service install`.
- Start: `sudo systemctl start cloudflared && sudo systemctl enable cloudflared`.

### On the server
- The server already prefers `HOST=127.0.0.1` when `ADMIN_API_KEY`
  isn't set, and `0.0.0.0` when it is. With the tunnel, you can flip to
  `HOST=127.0.0.1` even when auth is on — Cloudflared connects from
  localhost. Document this in `.env.example`.
- Confirm `cors: { origin: "*" }` is set in the Socket.IO server config
  (it is).
- Add a one-line check at startup: if `HOST=0.0.0.0` and no firewall
  rule restricts inbound 3000, log a `⚠` warning. Cloudflare Tunnel
  setups should bind to localhost only.

### Verification
- From a separate device (phone, friend's laptop): visit
  `https://dashboard.yourdomain.com/dashboard`. Login modal appears.
- Enter key → unlocked → live socket connection.
- `sudo systemctl restart swarm-server.service` — dashboard reconnects
  automatically (Socket.IO retries).
- Kill cloudflared briefly — dashboard shows "disconnected", reconnects
  when service comes back. No crashes.

## Part 2: Vercel split (optional)

### Setup
- New top-level dir `dashboard-vercel/` (or a separate repo —
  recommended). Copy: `public/dashboard.html`, `public/dashboard.css`,
  `public/dashboard.js`, plus a `vercel.json`.
- In `dashboard.html`, replace `<script src="/socket.io/socket.io.js">`
  with the CDN: `https://cdn.socket.io/4.7.5/socket.io.min.js` (pin the
  version).
- In `dashboard.js`, replace bare-path fetches and the `io("/space",...)`
  call with a configurable base URL:
  ```js
  const API_BASE = window.DASHBOARD_API
    || document.querySelector('meta[name="api-base"]')?.content
    || ""  // same-origin fallback
  const socket = io(API_BASE + "/space", { auth: { key: KEY }, ... })
  // fetch -> fetch(API_BASE + "/state", ...)
  ```
- Add `<meta name="api-base" content="">` to `dashboard.html` so the
  Vercel project can inject it via a small build step or environment.
  Simpler: Vercel env var `NEXT_PUBLIC_DASHBOARD_API` baked into the
  static page via a `vercel.json` build command that runs `sed`.
- `vercel.json`:
  ```json
  {
    "buildCommand": "node inject-api.js",
    "outputDirectory": "dist"
  }
  ```
- `inject-api.js`: copies `dashboard.html` to `dist/`, substitutes the
  meta tag's `content` with `process.env.DASHBOARD_API`.

### Deploy
- `vercel deploy --prod` from `dashboard-vercel/`.
- Set Vercel env var `DASHBOARD_API=https://dashboard.yourdomain.com`.
- Visit the Vercel URL — login modal → unlocked → connects to the VM
  via the tunnel hostname.

### Verification
- Vercel URL works from a fresh incognito window.
- DevTools network tab shows requests going to
  `dashboard.yourdomain.com`, not to Vercel.
- The Vercel page survives a VM reboot (it's static); the dashboard
  shows "disconnected" until VM comes back.

## Files to modify / create
- `.env.example` — note `HOST=127.0.0.1` is preferred when behind a
  tunnel
- `server.js` — startup warning when `HOST=0.0.0.0` with no firewall
  guard
- `docs/deploy-cloudflare-tunnel.md` (new) — copy of the playbook above
- `dashboard-vercel/` (new, optional) — the static fork + `vercel.json`
  + `inject-api.js`

## How to verify
See "Verification" sections above. Plus:
- A new device visiting the dashboard logs `audit: <op> from <CF edge IP>`,
  not the operator's laptop IP. Cloudflared forwards the original IP via
  `CF-Connecting-IP`. Update `auditEntry()` to prefer that header.

## Out of scope
- Setting up the GCP VM itself. Assumes the VM exists and is running.
- Custom-domain TLS without Cloudflare. (Caddy + Let's Encrypt is an
  alternative — not in this task.)
- Vercel Edge Functions or Serverless. Static only.

## Gotchas
- **Mixed content**: the Vercel page is HTTPS. The tunnel hostname must
  also be HTTPS (Cloudflare gives this automatically). If you set up
  a non-tunneled origin instead, browsers will block `ws://` upgrades.
- The `/auth/check` POST from Vercel is cross-origin. The current
  Socket.IO CORS config is `*`, which allows it. The Express routes
  inherit from a default that doesn't set CORS — add `app.use(cors(...))`
  with the Vercel origin if Part 2 ships.
- Cloudflared adds `CF-Connecting-IP`. The current `auditEntry()` reads
  `x-forwarded-for` already, but cloudflared can chain through multiple
  headers. Prefer `CF-Connecting-IP` first, then `x-forwarded-for`,
  then `socket.handshake.address`.
- Don't put the tunnel's hostname in this repo's docs as an example
  value — operators will copy-paste it. Use `dashboard.YOURDOMAIN.com`.
