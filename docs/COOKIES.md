# X Account Cookies — Getting, Storing, Refreshing

## What cookies are needed

X (Twitter) uses two cookies to authenticate a logged-in session:

| Cookie | Description | Expires |
|---|---|---|
| `auth_token` | Session authentication token | ~1 year, but invalidated on logout/password change |
| `ct0` | CSRF token | Rotates periodically (every few weeks) |

**Both must be current.** If `ct0` is stale, clicks register but nothing happens — the account looks "logged in" but actions silently fail.

## How to get fresh cookies

### Method 1 — Chrome DevTools (easiest)

1. Open Chrome on your Mac/PC (not the VM)
2. Log into x.com as the account you need (@swarminged or @eplus)
3. Open DevTools: `F12` or `Cmd+Option+I`
4. Go to **Application** tab → **Storage** → **Cookies** → `https://x.com`
5. Find `auth_token` — copy the entire **Value** column
6. Find `ct0` — copy the entire **Value** column

### Method 2 — Browser console

```javascript
// Paste in browser console while on x.com
document.cookie.split('; ')
  .filter(c => c.startsWith('auth_token') || c.startsWith('ct0'))
  .forEach(c => console.log(c))
```

Note: `ct0` is not HttpOnly so it shows in JS. `auth_token` is HttpOnly and won't appear in JS — use DevTools method instead.

### Method 3 — Export from Chrome storage

Go to Application → Cookies → Export (if using a cookie extension), or use EditThisCookie extension.

## Where cookies are stored on the VM

| Account | File |
|---|---|
| @swarminged | `/home/agent/automation/.env` |
| @eplus | `/home/agent/automation/.env-eplus` |
| (both, for x-spaces-v2 server) | `/home/agent/x-spaces-v2/.env` |

### Format

```bash
# /home/agent/automation/.env  (swarminged)
X_AUTH_TOKEN=0baf6ba34cf546b05e950c145fba15c32d0d7160
X_CT0=44504615949e9b10b4084df7f0538a7579d1e1c5...

# /home/agent/automation/.env-eplus  (eplus)
X_AUTH_TOKEN_EPLUS=<auth_token value>
X_CT0_EPLUS=<ct0 value>
```

## How to update cookies on the VM

```bash
export PATH="$PATH:/home/codespace/google-cloud-sdk/bin"

# Swarminged
NEW_AUTH="paste_auth_token_here"
NEW_CT0="paste_ct0_here"
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  sudo python3 -c \"
import re
for f in ['/home/agent/automation/.env', '/home/agent/x-spaces-v2/.env']:
    try:
        s = open(f).read()
        s = re.sub(r'^X_AUTH_TOKEN=.*', 'X_AUTH_TOKEN=$NEW_AUTH', s, flags=re.M)
        s = re.sub(r'^X_CT0=.*', 'X_CT0=$NEW_CT0', s, flags=re.M)
        open(f,'w').write(s)
        print('updated', f)
    except: pass
\"
"

# Eplus
NEW_AUTH_EPLUS="paste_auth_token_here"
NEW_CT0_EPLUS="paste_ct0_here"
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  sudo python3 -c \"
import re
for f in ['/home/agent/automation/.env-eplus', '/home/agent/x-spaces-v2/.env']:
    try:
        s = open(f).read()
        s = re.sub(r'^X_AUTH_TOKEN_EPLUS=.*', 'X_AUTH_TOKEN_EPLUS=$NEW_AUTH_EPLUS', s, flags=re.M)
        s = re.sub(r'^X_CT0_EPLUS=.*', 'X_CT0_EPLUS=$NEW_CT0_EPLUS', s, flags=re.M)
        open(f,'w').write(s)
        print('updated', f)
    except: pass
\"
"
```

## How to verify cookies are working

```bash
# Test swarminged
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
sudo node -e \"
const p = require('/home/agent/x-spaces-v2/node_modules/puppeteer-core');
const fs = require('fs');
(async()=>{
  const env = fs.readFileSync('/home/agent/automation/.env','utf8');
  const auth = env.match(/X_AUTH_TOKEN=(.+)/)[1].trim();
  const ct0 = env.match(/X_CT0=(.+)/)[1].trim();
  const b = await p.connect({browserURL:'http://127.0.0.1:9223',defaultViewport:null});
  const pg = (await b.pages())[0];
  await pg.setCookie(
    {name:'auth_token',value:auth,domain:'.x.com',path:'/',httpOnly:true,secure:true},
    {name:'ct0',value:ct0,domain:'.x.com',path:'/',httpOnly:false,secure:true}
  );
  await pg.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:15000}).catch(()=>{});
  await new Promise(r=>setTimeout(r,3000));
  const loggedIn = await pg.evaluate(()=>!!document.querySelector('[data-testid=\\\"SideNav_AccountSwitcher_Button\\\"]'));
  console.log('swarminged logged in:', loggedIn);
  process.exit(0);
})();
\"
"
```

## Cookie rotation schedule

- `auth_token`: Stable unless you log out or change password. Usually lasts months.
- `ct0`: Rotates every few weeks. **This is the one that breaks things most often.**

**If agents suddenly stop joining Spaces**, the first thing to check is always the `ct0` value.

## Security notes

- Never commit cookies to git — they're treated as auth tokens equivalent to passwords
- The `.env` files are in `.gitignore`
- The VM's `.env` files are chmod 600 (agent-readable only)
- Don't paste cookies in Slack, Discord, or any chat — treat them like passwords
