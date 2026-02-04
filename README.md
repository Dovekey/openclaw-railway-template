# OpenClaw Railway Template (1‑click deploy)

This repo packages **OpenClaw** for Railway with a small **/setup** web wizard so users can deploy and onboard **without running any commands**.

## What you get

- **OpenClaw Gateway + Control UI** (served at `/` and `/openclaw`)
- A friendly **Setup Wizard** at `/setup` (protected by a password)
- Persistent state via **Railway Volume** (so config/credentials/memory survive redeploys)
- One-click **Export backup** (so users can migrate off Railway later)
- **Import backup** from `/setup` (advanced recovery)
- **Security-hardened Dockerfile** (non-root user, Alpine base, pinned version)
- **Pairing-based DM policy** for secure channel access control

## How it works (high level)

- The container runs a wrapper web server.
- The wrapper protects `/setup` with `SETUP_PASSWORD`.
- During setup, the wrapper runs `openclaw onboard --non-interactive ...` inside the container, writes state to the volume, and then starts the gateway.
- After setup, **`/` is OpenClaw**. The wrapper reverse-proxies all traffic (including WebSockets) to the local gateway process.

## Railway deploy instructions (what you'll publish as a Template)

In Railway Template Composer:

1) Create a new template from this GitHub repo.
2) **CRITICAL: Add a Volume mounted at `/data`** (see below)
3) Set the following variables:

Required:
- `SETUP_PASSWORD` — user-provided password to access `/setup`

Recommended:
- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/.openclaw/workspace`

Optional:
- `OPENCLAW_GATEWAY_TOKEN` — if not set, the wrapper generates one (not ideal). In a template, set it using a generated secret.

Notes:
- This template pins OpenClaw to a known-good version by default via Docker build arg `OPENCLAW_GIT_REF`.

4) Enable **Public Networking** (HTTP). Railway will assign a domain.
5) Deploy.

### IMPORTANT: Railway Volume Setup

**Without a volume, all data is lost when the container restarts!**

To add a volume in Railway:
1. Go to your service in the Railway dashboard
2. Click **Settings** → **Volumes**
3. Click **Add Volume**
4. Set **Mount Path** to `/data`
5. Click **Save** and redeploy

To verify your volume is working:
- Visit `https://<your-app>.up.railway.app/health/storage`
- Check that `persistent: true` and `storageType: "railway-volume"`

If you see `persistent: false` or `storageType: "temporary"`, your volume is not properly configured.

Then:
- Visit `https://<your-app>.up.railway.app/setup`
- Complete setup
- Visit `https://<your-app>.up.railway.app/` and `/openclaw`

## Pairing workflow (important!)

This deployment uses **pairing-based DM policy** for security. When users message your bot:

1. **User receives a pairing code** - The bot responds with "Pairing required" and a code like `3EY4PUYS`
2. **Admin approves the code** - Go to `/setup` and use the pairing buttons:
   - Click **"List pending"** to see all waiting pairing requests
   - Click **"Approve pairing"** to approve a single user (enter channel + code)
   - Click **"Approve all"** to batch-approve all pending requests
3. **User can now chat** - After approval, the user can interact normally

### Fixing "disconnected (1008): pairing required" error

This error means a user tried to connect but hasn't been approved yet. To fix:

1. Go to `https://<your-app>.up.railway.app/setup`
2. Enter your `SETUP_PASSWORD`
3. Click **"List pending"** to see the user's pairing code
4. Click **"Approve pairing"** or **"Approve all"**
5. Ask the user to try again

### Disabling pairing (not recommended)

If you want open access (anyone can message), edit the config:
1. Go to `/setup` → Config editor
2. Change `"dmPolicy": "pairing"` to `"dmPolicy": "open"` for each channel
3. Click **Save** (this restarts the gateway)

## Getting chat tokens (so you don’t have to scramble)

### Telegram bot token
1) Open Telegram and message **@BotFather**
2) Run `/newbot` and follow the prompts
3) BotFather will give you a token that looks like: `123456789:AA...`
4) Paste that token into `/setup`

### Discord bot token
1) Go to the Discord Developer Portal: https://discord.com/developers/applications
2) **New Application** → pick a name
3) Open the **Bot** tab → **Add Bot**
4) Copy the **Bot Token** and paste it into `/setup`
5) Invite the bot to your server (OAuth2 URL Generator → scopes: `bot`, `applications.commands`; then choose permissions)

## Troubleshooting: Data not persisting

If your configuration or chat history is lost after restarts:

### Check storage status
Visit `https://<your-app>.up.railway.app/health/storage` to see:
- Whether storage is persistent
- What storage type is being used
- Volume mount status and permissions

### Common issues

**1. No Railway volume mounted**
- Symptom: `storageType: "temporary"` or `storageType: "home-directory"`
- Fix: Add a volume mounted at `/data` in Railway Settings → Volumes

**2. Volume permission issues**
- Symptom: Container logs show "Cannot write to /data/.openclaw"
- Fix: Delete the volume and create a new one (Railway volumes sometimes have stale permissions)

**3. Wrong environment variables**
- Symptom: Data saves to wrong location
- Fix: Ensure `OPENCLAW_STATE_DIR=/data/.openclaw` and `OPENCLAW_WORKSPACE_DIR=/data/.openclaw/workspace`

### Checking container logs
In Railway, check deployment logs for lines like:
```
[entrypoint] ✓ Using persistent data directory: /data/.openclaw
```

If you see this warning, your data will NOT persist:
```
[entrypoint] ⚠⚠⚠ USING /tmp AS LAST RESORT ⚠⚠⚠
```

## SSH into your Railway container

Railway provides direct SSH access to your running container for debugging, inspecting files, or running OpenClaw CLI commands manually.

### Method 1: Railway CLI (recommended)

1. **Install the Railway CLI** (if you haven't already):
   ```bash
   # macOS
   brew install railway

   # npm (any platform)
   npm install -g @railway/cli

   # Or download from https://railway.app/cli
   ```

2. **Login to Railway**:
   ```bash
   railway login
   ```

3. **Link your project** (run from any directory):
   ```bash
   railway link
   ```
   Select your project and environment when prompted.

4. **SSH into the container**:
   ```bash
   railway shell
   ```
   This opens an interactive shell session inside your running container.

### Method 2: Railway Dashboard

1. Go to your project in the [Railway Dashboard](https://railway.app/dashboard)
2. Click on your OpenClaw service
3. Go to the **Deployments** tab
4. Click on the active deployment
5. Click the **Shell** button in the top-right corner

This opens a web-based terminal directly in your browser.

### Useful commands once connected

```bash
# Check OpenClaw status
openclaw status

# View gateway logs
cat /data/.openclaw/logs/gateway.log

# List configured channels
openclaw channels list

# Check storage/state directory
ls -la /data/.openclaw/

# View running processes
ps aux

# Check environment variables
env | grep OPENCLAW

# Manually restart the gateway (use with caution)
pkill -f "openclaw gateway" && openclaw gateway start
```

### Troubleshooting SSH access

- **"No running deployment"**: Make sure your service has an active deployment. Check the Railway dashboard.
- **"Permission denied"**: Re-run `railway login` to refresh your session.
- **"Project not linked"**: Run `railway link` and select your project.
- **Shell exits immediately**: The container may be restarting. Check deployment logs in the Railway dashboard.

---

## Local smoke test

```bash
docker build -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/.openclaw/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# open http://localhost:8080/setup (password: test)
```

---

## Official template / endorsements

- Officially recommended by OpenClaw: <https://docs.openclaw.ai/railway>
- Railway announcement (official): [Railway tweet announcing 1‑click OpenClaw deploy](https://x.com/railway/status/2015534958925013438)

  ![Railway official tweet screenshot](assets/railway-official-tweet.jpg)

- Endorsement from Railway CEO: [Jake Cooper tweet endorsing the OpenClaw Railway template](https://x.com/justjake/status/2015536083514405182)

  ![Jake Cooper endorsement tweet screenshot](assets/railway-ceo-endorsement.jpg)

- Created and maintained by **Vignesh N (@vignesh07)**
- **1800+ deploys on Railway and counting** [Link to template on Railway](https://railway.com/deploy/clawdbot-railway-template)

![Railway template deploy count](assets/railway-deploys.jpg)
