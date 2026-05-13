# x-spaces/dual/patches

Python scripts that hot-patch the running server and agent HTML pages without a restart. Each is idempotent — it checks for its own anchor before writing and prints `[skip]` if already applied.

Run from the repo root:
```bash
python3 x-spaces/dual/patches/<script>.py
```

---

| Script | What it patches |
|--------|----------------|
| `two-agent-loop.py` | Adds the `textComplete → textToAgent` forwarding block to `index.js` so each agent's finished turn is relayed to the other as a new prompt; also adds a greeting `response.create` trigger to `agent2.html`'s `dc.onopen` handler |
| `agent2-respond.py` | Replaces the no-op `textToAgent` handler in `agent2.html` with a handler that injects the message into the Realtime session and calls `response.create`, making agent2 actually reply |
| `transcript-events.py` | Updates both `agent1.html` and `agent2.html` to accept the GA Realtime API's renamed transcript events (`response.output_audio_transcript.delta/done`) in addition to the old names |
| `turn-gating.py` | Replaces the simple 1.5s `setTimeout` forwarder in `index.js` with a `sendWhenIdle` poll that only delivers the prompt to the receiving agent once both agents' `status` is `"idle"`, preventing overlapping speech |

---

The files being patched live at runtime paths on the VM:
- Server: `/home/agent/ai-agents-x-space/index.js`
- Agent pages: `/home/agent/ai-agents-x-space/public/agent1.html`, `agent2.html`

Apply patches in this order for a fresh install:
1. `two-agent-loop.py`
2. `agent2-respond.py`
3. `transcript-events.py`
4. `turn-gating.py`
