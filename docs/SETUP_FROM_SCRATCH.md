# Setup From Scratch — New VM

Everything you need to get two agents speaking in an X Space on a fresh GCP VM.

## 1. Create the VM

```bash
gcloud compute instances create swarm-agent \
  --project=aerial-vehicle-466722-p5 \
  --zone=us-central1-a \
  --machine-type=e2-standard-2 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=50GB \
  --tags=http-server,https-server
```

## 2. SSH in

```bash
export PATH="$PATH:/home/codespace/google-cloud-sdk/bin"
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a
```

## 3. Install system dependencies

```bash
sudo apt-get update
sudo apt-get install -y \
  nodejs npm \
  pulseaudio pulseaudio-utils \
  xvfb \
  google-chrome-stable \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
  libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libnss3 libpango-1.0-0 libgtk-3-0 libdrm2 libasound2 \
  git curl python3

# On Ubuntu 24.04 use t64 suffixed packages:
# libatk1.0-0t64 libcups2t64 libgtk-3-0t64 libasound2t64 etc.
```

## 4. Create agent user

```bash
sudo useradd -m -s /bin/bash agent
sudo usermod -aG audio,video agent
```

## 5. Clone the repo

```bash
sudo -u agent bash -c '
  cd /home/agent
  git clone https://github.com/nirholas/xspace-agent.git ai-agents-x-space
  cd ai-agents-x-space
  npm install
'
```

## 6. Configure PulseAudio virtual cables

Create `/home/agent/.config/pulse/default.pa`:

```
# Null sinks (virtual speakers)
load-module module-null-sink sink_name=agent1_speakers sink_properties=device.description="Agent1-Speakers"
load-module module-null-sink sink_name=agent2_speakers sink_properties=device.description="Agent2-Speakers"
load-module module-null-sink sink_name=swarming_playback sink_properties=device.description="Swarming-Playback"
load-module module-null-sink sink_name=eplus_playback sink_properties=device.description="Eplus-Playback"

# Virtual mics (remapped from monitor sources)
load-module module-remap-source source_name=x_swarming_mic master=agent1_speakers.monitor source_properties=device.description="X-Swarming-Mic"
load-module module-remap-source source_name=x_eplus_mic master=agent2_speakers.monitor source_properties=device.description="X-Eplus-Mic"
load-module module-remap-source source_name=agent1_mic master=swarming_playback.monitor source_properties=device.description="Agent1-Mic"
load-module module-remap-source source_name=agent2_mic master=eplus_playback.monitor source_properties=device.description="Agent2-Mic"
```

## 7. Write the .env file

```bash
sudo -u agent tee /home/agent/ai-agents-x-space/.env << EOF
OPENAI_API_KEY=sk-proj-...
OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_0=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_VOICE_1=29vD33N1CtxCmqQRPOHJ
PORT=3000
HOST=127.0.0.1
EOF
```

## 8. Write X account cookies

```bash
# @swarminged cookies
sudo -u agent tee /home/agent/automation/.env << EOF
X_AUTH_TOKEN=<auth_token from x.com cookies>
X_CT0=<ct0 from x.com cookies>
EOF

# @eplus cookies
sudo -u agent tee /home/agent/automation/.env-eplus << EOF
X_AUTH_TOKEN_EPLUS=<auth_token from x.com cookies>
X_CT0_EPLUS=<ct0 from x.com cookies>
EOF
```

To get cookies: log into x.com in Chrome → DevTools → Application → Cookies → x.com → copy `auth_token` and `ct0`.

## 9. Install systemd service

```bash
sudo tee /etc/systemd/system/swarm-server.service << EOF
[Unit]
Description=AI Agents X Space Server
After=network.target

[Service]
Type=simple
User=agent
WorkingDirectory=/home/agent/ai-agents-x-space
EnvironmentFile=/home/agent/ai-agents-x-space/.env
ExecStart=/usr/bin/node /home/agent/ai-agents-x-space/index.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/home/agent/ai-agents-x-space/server.log
StandardError=append:/home/agent/ai-agents-x-space/server.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable swarm-server.service
sudo systemctl start swarm-server.service
```

## 10. Verify everything

```bash
# Server running?
curl http://localhost:3000/ -o /dev/null -w 'HTTP %{http_code}'

# Session endpoint working?
curl http://localhost:3000/session/0 | python3 -m json.tool | head -10

# PulseAudio sinks up?
pactl list short sinks | grep agent1_speakers

# Chrome installed?
google-chrome --version
```

## 11. Ready to host — see RUNBOOK.md
