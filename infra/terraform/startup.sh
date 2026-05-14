#!/usr/bin/env bash
###############################################################################
# startup.sh — VM bootstrap for swarm-agent (xspace-agent)
#
# Runs on EVERY boot (GCP startup-script metadata).
# Must be fully idempotent — every step re-checks before acting.
#
# Install order:
#   1. System packages (Node 20, Chrome, PulseAudio, Xvfb, ffmpeg, git)
#   2. Create OS user "agent"
#   3. Clone/pull repo
#   4. pnpm install
#   5. PulseAudio virtual sinks config
#   6. Systemd units (xvfb, pulseaudio-system, swarm-server)
#   7. Cloud Monitoring ops agent
#   8. Cloudflared tunnel (if token env var is set)
###############################################################################

set -euo pipefail

LOG_TAG="startup-xspace"
log() { logger -t "$LOG_TAG" "$*"; echo "[$(date -Iseconds)] $LOG_TAG: $*"; }

REPO_URL="https://github.com/nirholas/xspace-agent.git"
APP_DIR="/home/agent/ai-agents-x-space"
APP_USER="agent"

###############################################################################
# 1. System package installation
###############################################################################

log "Updating apt..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

log "Installing base packages..."
apt-get install -y -qq \
  curl \
  wget \
  git \
  gnupg \
  ca-certificates \
  lsb-release \
  software-properties-common \
  ffmpeg \
  pulseaudio \
  pulseaudio-utils \
  xvfb \
  x11-utils \
  alsa-utils \
  dbus \
  dbus-x11 \
  jq \
  unzip

# Node.js 20 LTS via NodeSource
if ! command -v node &>/dev/null || [[ "$(node --version)" != v20* ]]; then
  log "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
  log "Node version: $(node --version)"
else
  log "Node.js 20 already installed: $(node --version)"
fi

# pnpm via corepack (ships with Node 16.9+)
if ! command -v pnpm &>/dev/null; then
  log "Enabling pnpm via corepack..."
  corepack enable
  corepack prepare pnpm@latest --activate
  log "pnpm version: $(pnpm --version)"
else
  log "pnpm already installed: $(pnpm --version)"
fi

# google-chrome-stable
if ! command -v google-chrome-stable &>/dev/null && ! command -v google-chrome &>/dev/null; then
  log "Installing Google Chrome stable..."
  wget -q -O /tmp/chrome.deb \
    "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
  apt-get install -y -qq /tmp/chrome.deb || apt-get -f install -y -qq
  rm -f /tmp/chrome.deb
  log "Chrome version: $(google-chrome-stable --version 2>/dev/null || google-chrome --version)"
else
  log "Chrome already installed"
fi

###############################################################################
# 2. Create OS user
###############################################################################

if ! id "$APP_USER" &>/dev/null; then
  log "Creating user $APP_USER..."
  useradd --create-home --shell /bin/bash --comment "xspace-agent runner" "$APP_USER"
  # Lock password login — SSH key only (managed via VM metadata)
  passwd -l "$APP_USER"
else
  log "User $APP_USER already exists"
fi

# Ensure the user is in the audio group for PulseAudio
usermod -aG audio "$APP_USER" || true

###############################################################################
# 3. Clone or pull the repository
###############################################################################

if [[ -d "$APP_DIR/.git" ]]; then
  log "Repo already cloned — pulling latest..."
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only 2>&1 | logger -t "$LOG_TAG" || true
else
  log "Cloning repo to $APP_DIR..."
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
fi

###############################################################################
# 4. pnpm install
###############################################################################

log "Running pnpm install..."
sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && pnpm install --frozen-lockfile 2>&1" \
  | logger -t "$LOG_TAG" || {
    log "pnpm install failed — falling back to non-frozen install..."
    sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && pnpm install 2>&1" | logger -t "$LOG_TAG"
  }

###############################################################################
# 5. PulseAudio system-wide configuration
###############################################################################

log "Configuring PulseAudio virtual sinks..."

# System-wide PulseAudio config directory
PA_CONF_DIR="/etc/pulse"
mkdir -p "$PA_CONF_DIR"

# System daemon config — allows the system service to run as root/pulse user
# and accept connections from the "agent" user.
cat > "$PA_CONF_DIR/system.pa" << 'PULSE_EOF'
#!/usr/bin/pulseaudio -nF
#
# system.pa — PulseAudio system-wide config for xspace-agent
# Loaded by pulseaudio-system.service

# Load core modules
.fail
load-module module-native-protocol-unix auth-anonymous=1 socket=/var/run/pulse/native

# Device discovery (needed even in headless mode)
load-module module-udev-detect
load-module module-detect

# Loopback/null sinks for Chrome audio routing
# Each Chrome instance gets a dedicated sink so audio streams don't cross-contaminate.

# Agent 1 (Swarm) — main agent sink
load-module module-null-sink \
  sink_name=agent1_speakers \
  sink_properties=device.description=Agent1_Speakers
load-module module-virtual-source \
  source_name=agent1_mic \
  master=agent1_speakers.monitor \
  source_properties=device.description=Agent1_Microphone

# Agent 2 (EPlus) — secondary agent sink
load-module module-null-sink \
  sink_name=agent2_speakers \
  sink_properties=device.description=Agent2_Speakers
load-module module-virtual-source \
  source_name=agent2_mic \
  master=agent2_speakers.monitor \
  source_properties=device.description=Agent2_Microphone

# Shared swarming playback sink
load-module module-null-sink \
  sink_name=swarming_playback \
  sink_properties=device.description=Swarming_Playback
load-module module-virtual-source \
  source_name=swarming_mic \
  master=swarming_playback.monitor \
  source_properties=device.description=Swarming_Microphone

# EPlus playback sink
load-module module-null-sink \
  sink_name=eplus_playback \
  sink_properties=device.description=EPlus_Playback
load-module module-virtual-source \
  source_name=eplus_mic \
  master=eplus_playback.monitor \
  source_properties=device.description=EPlus_Microphone

# Set agent1_speakers as the default sink (Chrome will use it unless explicitly routed)
set-default-sink agent1_speakers
set-default-source agent1_mic

.nofail
PULSE_EOF

# Per-user PulseAudio default.pa (fallback when running as the agent user directly)
AGENT_PULSE_DIR="/home/$APP_USER/.config/pulse"
mkdir -p "$AGENT_PULSE_DIR"
chown "$APP_USER:$APP_USER" "$AGENT_PULSE_DIR"

cat > "$AGENT_PULSE_DIR/default.pa" << 'USER_PULSE_EOF'
#!/usr/bin/pulseaudio -nF
# Per-user PulseAudio config for xspace-agent.
# Mirrors system.pa for manual/interactive use.

.fail
load-module module-native-protocol-unix

load-module module-null-sink \
  sink_name=agent1_speakers \
  sink_properties=device.description=Agent1_Speakers
load-module module-virtual-source \
  source_name=agent1_mic \
  master=agent1_speakers.monitor \
  source_properties=device.description=Agent1_Microphone

load-module module-null-sink \
  sink_name=agent2_speakers \
  sink_properties=device.description=Agent2_Speakers
load-module module-virtual-source \
  source_name=agent2_mic \
  master=agent2_speakers.monitor \
  source_properties=device.description=Agent2_Microphone

load-module module-null-sink \
  sink_name=swarming_playback \
  sink_properties=device.description=Swarming_Playback
load-module module-virtual-source \
  source_name=swarming_mic \
  master=swarming_playback.monitor \
  source_properties=device.description=Swarming_Microphone

load-module module-null-sink \
  sink_name=eplus_playback \
  sink_properties=device.description=EPlus_Playback
load-module module-virtual-source \
  source_name=eplus_mic \
  master=eplus_playback.monitor \
  source_properties=device.description=EPlus_Microphone

set-default-sink agent1_speakers
set-default-source agent1_mic

.nofail
USER_PULSE_EOF

chown "$APP_USER:$APP_USER" "$AGENT_PULSE_DIR/default.pa"

# Runtime socket directory for system PulseAudio
mkdir -p /var/run/pulse
chown pulse:pulse /var/run/pulse 2>/dev/null || chown root:root /var/run/pulse

###############################################################################
# 6. Systemd unit files
###############################################################################

log "Installing systemd units..."

# --- Xvfb service ---
cat > /etc/systemd/system/xvfb.service << 'XVFB_EOF'
[Unit]
Description=X Virtual Frame Buffer (display :99)
Documentation=man:Xvfb(1)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x800x24 -ac +extension RANDR +extension GLX +render -noreset
ExecStartPost=/bin/sleep 1
Restart=always
RestartSec=3

Environment=DISPLAY=:99
# Xvfb doesn't need a real user — run as nobody for isolation
User=nobody
Group=nogroup

StandardOutput=journal
StandardError=journal
SyslogIdentifier=xvfb

[Install]
WantedBy=multi-user.target
XVFB_EOF

# --- PulseAudio system service ---
cat > /etc/systemd/system/pulseaudio-system.service << 'PA_EOF'
[Unit]
Description=PulseAudio system daemon (virtual sinks for Chrome audio routing)
Documentation=man:pulseaudio(1)
After=dbus.service

[Service]
Type=notify
ExecStart=/usr/bin/pulseaudio \
  --system \
  --realtime=false \
  --exit-idle-time=-1 \
  --log-target=journal \
  --log-level=warn
ExecStop=/usr/bin/pulseaudio --kill

# Run as the pulse system user (created by the pulseaudio package)
# Do NOT run as root — PulseAudio will refuse with --system
User=pulse
Group=pulse
SupplementaryGroups=audio

Restart=on-failure
RestartSec=5

# Give it time to load all null-sink modules
TimeoutStartSec=30

StandardOutput=journal
StandardError=journal
SyslogIdentifier=pulseaudio-system

# Allow the agent user to connect to the system socket
Environment=PULSE_SYSTEM=1

[Install]
WantedBy=multi-user.target
PA_EOF

# --- swarm-server service (copy from repo if it exists, else use fallback) ---
REPO_UNIT="$APP_DIR/infra/systemd/swarm-server.service"
if [[ -f "$REPO_UNIT" ]]; then
  log "Copying swarm-server.service from repo..."
  cp "$REPO_UNIT" /etc/systemd/system/swarm-server.service
else
  log "Repo unit not found — installing fallback swarm-server.service..."
  cat > /etc/systemd/system/swarm-server.service << 'SVC_EOF'
[Unit]
Description=xspace-agent swarm server
After=network-online.target pulseaudio-system.service xvfb.service
Wants=network-online.target pulseaudio-system.service xvfb.service

[Service]
Type=simple
User=agent
Group=agent
WorkingDirectory=/home/agent/ai-agents-x-space

EnvironmentFile=-/home/agent/.env
Environment=NODE_ENV=production
Environment=DISPLAY=:99
Environment=PULSE_SERVER=unix:/var/run/pulse/native

ExecStart=/usr/bin/node server.js
ExecReload=/bin/kill -HUP $MAINPID

Restart=always
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

KillSignal=SIGTERM
TimeoutStopSec=30
KillMode=mixed

LimitNOFILE=65536

StandardOutput=journal
StandardError=journal
SyslogIdentifier=swarm-server

[Install]
WantedBy=multi-user.target
SVC_EOF
fi

# Reload systemd and enable all units
log "Reloading systemd daemon..."
systemctl daemon-reload

for unit in xvfb.service pulseaudio-system.service swarm-server.service; do
  log "Enabling and starting $unit..."
  systemctl enable "$unit"
  # Restart rather than start so restarts are idempotent
  systemctl restart "$unit" || log "WARNING: failed to start $unit — check: journalctl -u $unit"
done

###############################################################################
# 7. Google Cloud Ops Agent (for memory metrics in Cloud Monitoring)
###############################################################################

if ! command -v google-cloud-ops-agent &>/dev/null && ! systemctl is-active --quiet google-cloud-ops-agent; then
  log "Installing Google Cloud Ops Agent..."
  curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash add-google-cloud-ops-agent-repo.sh --also-install 2>&1 | logger -t "$LOG_TAG" || true
  rm -f add-google-cloud-ops-agent-repo.sh
else
  log "Ops Agent already installed"
fi

###############################################################################
# 8. Cloudflared tunnel (optional)
###############################################################################

# If CLOUDFLARE_TUNNEL_TOKEN is set in the VM's instance metadata or environment,
# install and configure cloudflared for a zero-trust tunnel (no open inbound ports).
TUNNEL_TOKEN=""
if command -v curl &>/dev/null; then
  # Try GCE metadata server
  TUNNEL_TOKEN=$(curl -sf \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/CLOUDFLARE_TUNNEL_TOKEN" \
    -H "Metadata-Flavor: Google" 2>/dev/null || true)
fi

if [[ -n "$TUNNEL_TOKEN" ]]; then
  log "Cloudflare tunnel token found — installing cloudflared..."

  if ! command -v cloudflared &>/dev/null; then
    wget -q -O /tmp/cloudflared.deb \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb"
    apt-get install -y -qq /tmp/cloudflared.deb
    rm -f /tmp/cloudflared.deb
  fi

  cloudflared service install "$TUNNEL_TOKEN" 2>&1 | logger -t "$LOG_TAG" || true
  systemctl enable cloudflared
  systemctl restart cloudflared || log "WARNING: cloudflared failed to start"
  log "Cloudflared tunnel installed and started"
else
  log "No CLOUDFLARE_TUNNEL_TOKEN in metadata — skipping cloudflared"
fi

###############################################################################
# Done
###############################################################################

log "Startup script complete. Service status:"
systemctl is-active xvfb.service pulseaudio-system.service swarm-server.service \
  | paste - - - \
  | awk '{printf "  xvfb: %s  pulseaudio: %s  swarm-server: %s\n", $1, $2, $3}' \
  | logger -t "$LOG_TAG" || true

log "All done."
