# Cloudflare Tunnel — Deployment Playbook

Expose the xspace-agent dashboard over HTTPS at a stable hostname without
opening inbound firewall ports or managing TLS certificates.
Cloudflare Tunnel (`cloudflared`) creates an outbound-only connection from the
VM to Cloudflare's edge. The dashboard becomes reachable from any browser —
including a phone during a live show — via `https://dashboard.YOURDOMAIN.com`.

---

## Prerequisites

- A Cloudflare account with your domain added and DNS managed by Cloudflare.
- The GCP VM is running and `server.js` (or `packages/server`) is reachable on
  `localhost:3000`.
- `ADMIN_API_KEY` is set in `.env` (see `.env.example`). Never expose the
  dashboard without it.

---

## Part 1 — Install and configure cloudflared on the VM

```bash
# 1. Install the deb package (amd64)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
  https://pkg.cloudflare.com/cloudflared focal main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

# 2. Log in (opens a browser URL — approve in Cloudflare dashboard)
cloudflared tunnel login

# 3. Create a named tunnel (note the UUID printed — you'll need it)
cloudflared tunnel create xspace-dashboard

# 4. Point a DNS hostname at the tunnel
cloudflared tunnel route dns xspace-dashboard dashboard.YOURDOMAIN.com
```

## Part 2 — Write the config file

```bash
sudo mkdir -p /etc/cloudflared
```

Create `/etc/cloudflared/config.yml`:

```yaml
tunnel: xspace-dashboard
credentials-file: /home/<YOUR_USER>/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: dashboard.YOURDOMAIN.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Replace `<YOUR_USER>` and `<TUNNEL_UUID>` with your values.
The credentials file was created during `cloudflared tunnel create`.

## Part 3 — Bind the server to localhost only

With the tunnel in place you no longer need the server to listen on
`0.0.0.0`. Set in `.env`:

```
HOST=127.0.0.1
```

Cloudflared connects from localhost, so `127.0.0.1` is sufficient and
removes port 3000 from the VM's network surface. The server logs a warning
if `HOST=0.0.0.0` is detected at startup.

## Part 4 — Run as a systemd service

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

Check status:

```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -f
```

## Part 5 — Update CORS_ORIGINS

Add the tunnel hostname to the allow-list so the browser's CORS pre-flight
succeeds (required for Part 2 / Vercel split; harmless otherwise):

```
CORS_ORIGINS=https://dashboard.YOURDOMAIN.com
```

Restart the server after changing `.env`.

---

## Verification checklist

| Test | Expected |
|------|----------|
| From a phone: `https://dashboard.YOURDOMAIN.com/dashboard` | Login modal appears |
| Enter `ADMIN_API_KEY` | Dashboard unlocks; socket connects |
| `sudo systemctl restart swarm-server.service` | Dashboard reconnects automatically |
| Kill cloudflared briefly | Dashboard shows "disconnected"; reconnects when service resumes |
| `curl -s https://dashboard.YOURDOMAIN.com/auth/info` | `{"authRequired":true}` |
| Audit log entry | Shows Cloudflare edge IP (from `CF-Connecting-IP`), not the operator's laptop IP |

The `auditEntry()` function in `server.js` already prefers `CF-Connecting-IP`
over `x-forwarded-for` for this reason.

---

## Part 6 — Vercel static split (optional)

Serve the dashboard HTML/CSS/JS from Vercel while keeping the WebSocket server
on the VM. Benefits: dashboard edits deploy independently; the static page
survives a VM reboot (it shows "disconnected" until the VM comes back).

See [`dashboard-vercel/`](../dashboard-vercel/) — it contains a ready-to-deploy
static copy with `vercel.json` and `inject-api.js`.

### Deploy steps

```bash
# 1. Install Vercel CLI if needed
npm i -g vercel

# 2. Set the tunnel hostname as an env var
# In Vercel project settings → Environment Variables:
#   DASHBOARD_API = https://dashboard.YOURDOMAIN.com

# 3. Deploy
cd dashboard-vercel
vercel deploy --prod
```

After deploy, visit the Vercel URL. DevTools → Network should show requests
going to `dashboard.YOURDOMAIN.com`, not to Vercel.

Add the Vercel URL to `CORS_ORIGINS` so cross-origin requests are accepted:

```
CORS_ORIGINS=https://dashboard.YOURDOMAIN.com,https://your-vercel-app.vercel.app
```

---

## Gotchas

- **Mixed content**: the Vercel page is HTTPS. The tunnel hostname must also be
  HTTPS (Cloudflare provides this automatically). Non-tunneled `ws://` origins
  are blocked by browsers on HTTPS pages.
- **CORS**: Express routes default to no CORS headers. The `CORS_ORIGINS` env
  var must include the Vercel origin if Part 2 ships.
- **CF-Connecting-IP**: This header is set by Cloudflare with the real client IP.
  The server reads it in `auditEntry()`. Do not trust it from non-Cloudflare
  proxies.
- **Tunnel credentials**: The `.json` credentials file grants full tunnel
  control. Keep it out of version control.
- **Alternative**: Caddy + Let's Encrypt is a viable TLS alternative if you
  prefer not to use Cloudflare for DNS. Not covered here.
