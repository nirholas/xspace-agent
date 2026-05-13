#!/usr/bin/env python3
"""Claim-token coordination:
  - When an agent's statusChange becomes 'speaking', the server tells all OTHER
    agents to cancel any in-flight response on their data channel.
  - Agent pages listen for 'cancelResponse' and send response.cancel to OpenAI.

This lets us re-enable VAD auto-response (agents reply to humans) while
preventing the two-agent stomp."""

p = "/home/agent/ai-agents-x-space/index.js"
s = open(p).read()

# 1. Server: forward statusChange("speaking") → cancelResponse to OTHER agents.
OLD = '''  socket.on("statusChange", ({ agentId, status }) => {
    if (state.agents[agentId]) {
      state.agents[agentId].status = status
      io.emit("agentStatus", { agentId, status, name: state.agents[agentId].name })
      broadcastState()
    }
  })'''

NEW = '''  socket.on("statusChange", ({ agentId, status }) => {
    if (state.agents[agentId]) {
      state.agents[agentId].status = status
      io.emit("agentStatus", { agentId, status, name: state.agents[agentId].name })
      broadcastState()
      // Claim-token: if this agent just started speaking, tell every other
      // connected agent to cancel any in-flight response.
      if (status === "speaking") {
        Object.values(state.agents).forEach((other) => {
          if (other.id !== agentId && other.connected && other.socketId) {
            io.to(other.socketId).emit("cancelResponse", { reason: `agent ${agentId} took the floor` })
          }
        })
      }
    }
  })'''

if OLD in s:
    s = s.replace(OLD, NEW)
    open(p, "w").write(s)
    print("[ok] server: claim-token logic wired")
elif "Claim-token:" in s:
    print("[skip] server already patched")
else:
    print("[WARN] statusChange handler shape unrecognized")

# 2. Agent pages: listen for cancelResponse, fire response.cancel
for path in [
    "/home/agent/ai-agents-x-space/public/agent1.html",
    "/home/agent/ai-agents-x-space/public/agent2.html",
]:
    p2 = path
    s2 = open(p2).read()
    OLD2 = '''    socket.on("textComplete", (msg) => {'''
    NEW2 = '''    socket.on("cancelResponse", ({ reason }) => {
      if (!dc || dc.readyState !== "open") return
      try {
        dc.send(JSON.stringify({ type: "response.cancel" }))
        log("cancelResponse: " + (reason || ""))
      } catch (e) {}
    })

    socket.on("textComplete", (msg) => {'''
    if OLD2 in s2 and 'socket.on("cancelResponse"' not in s2:
        s2 = s2.replace(OLD2, NEW2)
        open(p2, "w").write(s2)
        print(f"[ok] {path}: cancelResponse listener added")
    elif 'socket.on("cancelResponse"' in s2:
        print(f"[skip] {path} already patched")
    else:
        print(f"[WARN] {path}: anchor not found")
