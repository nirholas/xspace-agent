# PulseAudio Virtual Cable Routing

How two AI agents speak in an X Space using only software — no physical audio hardware needed.

## The problem

- Agent 1 runs in Chrome, generating audio via OpenAI Realtime WebRTC
- We need that audio to come out of @swarminged's microphone on X
- X reads microphone audio from Chrome's input device
- We need to route Chrome-A's output → Chrome-B's input

## The solution: PulseAudio null sinks + remap sources

A **null sink** is a virtual speaker — audio goes in, disappears into the void, BUT a `.monitor` source is automatically created that captures everything sent to that sink.

A **remap source** creates a new virtual microphone backed by another source (like a monitor).

```
Agent Chrome          null sink              @swarminged Chrome
(PULSE_SINK=          "agent1_speakers"      (PULSE_SOURCE=
 agent1_speakers)  ──→  .monitor  ──→         x_swarming_mic)
                      remap-source
                      "x_swarming_mic"
```

Everything Agent Chrome plays goes into `agent1_speakers`. The `.monitor` source captures it all. `x_swarming_mic` is mapped to that monitor. @swarminged Chrome records from `x_swarming_mic` — so it "hears" everything Agent Chrome says and broadcasts it as its microphone input to X.

The reverse path (Space audio → Agent Chrome):
```
@swarminged Chrome     null sink             Agent Chrome
(PULSE_SINK=           "swarming_playback"   (PULSE_SOURCE=
 swarming_playback) ──→  .monitor  ──→        agent1_mic)
                       remap-source
                       "agent1_mic"
```

@swarminged Chrome plays the X Space audio (other speakers) into `swarming_playback`. Agent Chrome listens via `agent1_mic` which is backed by `swarming_playback.monitor`. So Agent Chrome hears everything in the X Space.

## Full routing table

```
Sink / Source Name       Direction    Connected to           Purpose
─────────────────────────────────────────────────────────────────────
agent1_speakers          SINK         Agent1 Chrome output   Agent1 voice
agent1_speakers.monitor  SOURCE       → x_swarming_mic       captured by swarming
x_swarming_mic           SOURCE       @swarminged Chrome mic Swarm's voice → X Space
─────────────────────────────────────────────────────────────────────
swarming_playback        SINK         @swarminged Chrome out X Space audio
swarming_playback.monitor SOURCE      → agent1_mic           Agent1 hears Space
agent1_mic               SOURCE       Agent1 Chrome input    Agent1 listens to Space
─────────────────────────────────────────────────────────────────────
agent2_speakers          SINK         Agent2 Chrome output   Agent2 voice
agent2_speakers.monitor  SOURCE       → x_eplus_mic          captured by eplus
x_eplus_mic              SOURCE       @eplus Chrome mic      Swarm2's voice → X Space
─────────────────────────────────────────────────────────────────────
eplus_playback           SINK         @eplus Chrome output   X Space audio
eplus_playback.monitor   SOURCE       → agent2_mic           Agent2 hears Space
agent2_mic               SOURCE       Agent2 Chrome input    Agent2 listens to Space
```

## Why there's no audio feedback loop

Each agent's output goes to a DIFFERENT sink than what its X Chrome plays to:

- Agent 1 outputs to `agent1_speakers`
- @swarminged plays to `swarming_playback` (the Space's audio)
- Agent 1's mic is `agent1_mic` = `swarming_playback.monitor` (not `agent1_speakers.monitor`)

So Agent 1 hears the X Space but NOT its own voice. No echo.

The only feedback risk: if Agent 1 speaks → goes into X Space → @swarminged plays it → Agent 1 hears it from `swarming_playback`. But OpenAI's server-side VAD handles this — it knows when the model itself is generating audio and suppresses the loopback.

## Config file

`/home/agent/.config/pulse/default.pa`:

```
load-module module-null-sink sink_name=agent1_speakers
load-module module-null-sink sink_name=agent2_speakers
load-module module-null-sink sink_name=swarming_playback
load-module module-null-sink sink_name=eplus_playback
load-module module-remap-source source_name=x_swarming_mic master=agent1_speakers.monitor
load-module module-remap-source source_name=x_eplus_mic master=agent2_speakers.monitor
load-module module-remap-source source_name=agent1_mic master=swarming_playback.monitor
load-module module-remap-source source_name=agent2_mic master=eplus_playback.monitor
```

## How Chrome uses the virtual devices

Each Chrome process is launched with environment variables that override its audio devices:

```bash
PULSE_SINK=agent1_speakers PULSE_SOURCE=agent1_mic google-chrome ...
```

PulseAudio respects these env vars to route that process's audio to/from the specified devices. This is per-process isolation — each Chrome instance has its own virtual speaker and microphone.

## Verifying audio is flowing

```bash
# See which Chrome processes are connected to which sinks
pactl list short sink-inputs

# See which Chrome processes are connected to which sources
pactl list short source-outputs

# Check all 4 sinks exist
pactl list short sinks | grep -E "agent1|agent2|swarming|eplus"

# Check all 4 virtual mics exist
pactl list short sources | grep -E "x_swarming|x_eplus|agent1_mic|agent2_mic"
```

Expected output when everything is running:
- 4 null sinks
- 4 remap sources (the virtual mics)
- Chrome sink-inputs showing `swarming_playback` and `eplus_playback`
- Chrome source-outputs showing `agent1_mic` and `agent2_mic`

## Common issues

**"No audio from agent" / X Space is silent**
- Check: `pactl list short sink-inputs` — is Agent Chrome writing to `agent1_speakers`?
- Check: is `x_swarming_mic` actually mapped to `agent1_speakers.monitor`?
- Check: is @swarminged Chrome reading from `x_swarming_mic`?
- Try: restart PulseAudio (`pulseaudio --kill; pulseaudio --start --exit-idle-time=-1`)

**"Agent can't hear humans"**
- Check: `pactl list short source-outputs` — is Agent Chrome reading from `agent1_mic`?
- `agent1_mic` must be a remap-source backed by `swarming_playback.monitor`
- Check @swarminged Chrome's PULSE_SINK is `swarming_playback`
