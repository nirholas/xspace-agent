# System Architecture

## What this is

Two AI agents (Swarm + Swarm2) that autonomously host X Spaces. They talk to each other continuously, respond to anyone who speaks in the Space, and stay in character as human co-hosts promoting three.ws.

## High-level flow

```
[OpenAI Realtime API]
      ↕ WebRTC (audio + data channel)
[Chrome Agent 1] ←─── PULSE_SINK=agent1_speakers
                  ───→ PULSE_SOURCE=agent1_mic = swarming_playback.monitor
                                                        ↕
[Chrome @swarminged] ←── PULSE_SINK=swarming_playback (hears X Space)
                      ──→ PULSE_SOURCE=x_swarming_mic = agent1_speakers.monitor → X Space mic

[OpenAI Realtime API]
      ↕ WebRTC (audio + data channel)
[Chrome Agent 2] ←─── PULSE_SINK=agent2_speakers
                  ───→ PULSE_SOURCE=agent2_mic = eplus_playback.monitor
                                                        ↕
[Chrome @eplus]  ←── PULSE_SINK=eplus_playback (hears X Space)
                  ──→ PULSE_SOURCE=x_eplus_mic = agent2_speakers.monitor → X Space mic
```

### What this means in plain English

- Agent 1 (Swarm) speaks → audio goes to `agent1_speakers` → `x_swarming_mic` picks it up → @swarminged broadcasts it to the X Space
- X Space audio → `swarming_playback` → `agent1_mic` → Agent 1 hears what everyone in the Space is saying
- Same mirror setup for Agent 2 (Swarm2) ↔ @eplus

Neither agent hears its own voice back (no feedback loop) because the routing is one-directional.

## The server

**File**: `/home/agent/ai-agents-x-space/index.js`  
**Port**: 3000  
**URL**: `http://localhost:3000`

The server does:
1. Serves the agent HTML pages (`/agent1`, `/agent2`)
2. Mints OpenAI Realtime ephemeral keys (`GET /session/:agentId`)
3. Proxies ElevenLabs TTS streaming (`POST /tts/:agentId/stream`)
4. Socket.IO `/space` namespace — coordinates agent turn-taking
5. Forwards messages between agents (the banter loop)
6. Claim-token: cancels one agent's response when the other starts speaking

## The banter loop

```
Agent A speaks → textComplete event → server
Server waits 2s for both agents to be idle
If idle: emit textToAgent to Agent B with Agent A's last message
Agent B receives it → creates conversation.item in OpenAI Realtime → generates response
Agent B speaks → textComplete → server → forwards to Agent A
... repeat forever
```

## The claim-token (prevents overtalking)

```
Agent A emits statusChange("speaking")
Server: forEach other connected agent → emit cancelResponse
Agent B receives cancelResponse → sends response.cancel to OpenAI Realtime data channel
Agent B stops mid-sentence
Agent A finishes speaking uninterrupted
```

## Responding to humans

The OpenAI Realtime API has server-side VAD (Voice Activity Detection). When a human speaks in the X Space:
1. Their voice enters `swarming_playback` → Agent 1's mic
2. OpenAI Realtime VAD detects speech, transcribes it, generates a response
3. Agent 1 starts responding
4. Claim-token fires → Agent 2 cancels its in-progress response
5. Only Agent 1 responds to the human

## Four Chrome processes

| Process | CDP Port | PULSE_SINK | PULSE_SOURCE | Purpose |
|---|---|---|---|---|
| chrome-agent1 | 9222 | agent1_speakers | agent1_mic | Hosts the agent1.html page + WebRTC session |
| chrome-swarming | 9223 | swarming_playback | x_swarming_mic | Logged into @swarminged, speaks in X Space |
| chrome-agent2 | 9224 | agent2_speakers | agent2_mic | Hosts the agent2.html page + WebRTC session |
| chrome-eplus | 9225 | eplus_playback | x_eplus_mic | Logged into @eplus, speaks in X Space |

## OpenAI Realtime API (GA version)

**Session creation**: `POST https://api.openai.com/v1/realtime/sessions`  
Returns: `client_secret.value` (ephemeral key starting with `ek_`)

**SDP exchange** (WebRTC signaling):  
`POST https://api.openai.com/v1/realtime/calls?model=gpt-4o-realtime-preview`  
Headers: `Authorization: Bearer <ephemeral_key>`, `Content-Type: application/sdp`  
Body: WebRTC SDP offer  
Returns: SDP answer

**CRITICAL**: The model must be `gpt-4o-realtime-preview` (not `gpt-realtime`).  
The endpoint must be `/v1/realtime/calls` (not `/v1/realtime`).  
Do NOT include the `openai-beta: realtime=v1` header — that's for the old beta API.
