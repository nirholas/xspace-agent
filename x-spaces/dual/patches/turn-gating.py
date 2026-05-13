#!/usr/bin/env python3
"""Gate the textComplete -> textToAgent forwarder so the receiving agent only
gets the prompt when it (and the sending agent) are both idle, preventing the
two agents from talking over each other."""

p = "/home/agent/ai-agents-x-space/index.js"
s = open(p).read()

OLD = '''    // Two-agent loop: forward this turn to the OTHER agent as a textToAgent
    // event so they can respond. Only when the other agent is connected.
    const otherAgentId = agentId === 0 ? 1 : 0
    const other = state.agents[otherAgentId]
    if (other && other.connected && other.socketId) {
      setTimeout(() => {
        io.to(other.socketId).emit("textToAgent", {
          text,
          from: state.agents[agentId]?.name || "the other agent"
        })
      }, 1500)
    }'''

NEW = '''    // Two-agent loop: forward this turn to the OTHER agent only when both
    // agents are idle (prevents overlapping speech). Polls up to 15s, then
    // drops the prompt if the floor never clears.
    const otherAgentId = agentId === 0 ? 1 : 0
    const other = state.agents[otherAgentId]
    if (other && other.connected && other.socketId) {
      const sender = state.agents[agentId]
      const sendWhenIdle = (attempt = 0) => {
        const senderIdle = !sender || sender.status === "idle"
        const otherIdle = other.status === "idle"
        if (senderIdle && otherIdle) {
          io.to(other.socketId).emit("textToAgent", {
            text,
            from: sender?.name || "the other agent"
          })
        } else if (attempt < 10) {
          setTimeout(() => sendWhenIdle(attempt + 1), 1500)
        }
        // else: floor never cleared in 15s, drop this turn
      }
      // small initial delay so the agent's "Stopped speaking" status update lands first
      setTimeout(() => sendWhenIdle(), 2000)
    }'''

if OLD in s:
    s = s.replace(OLD, NEW)
    open(p, "w").write(s)
    print("[ok] server: forwarder now waits until both agents are idle")
elif "sendWhenIdle" in s:
    print("[skip] already patched")
else:
    print("[WARN] anchor not found")
