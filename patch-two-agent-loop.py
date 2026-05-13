#!/usr/bin/env python3
"""Wire the two-agent banter loop:
  - server: forward textComplete from agent A to agent B as textToAgent
  - agent2.html: add greeting trigger on dc.onopen (same shape as agent1)
"""
import re

# 1. Server: forward textComplete -> other agent's textToAgent
p = "/home/agent/ai-agents-x-space/index.js"
s = open(p).read()

OLD_TC_END = """  socket.on("textComplete", ({ agentId, text, messageId }) => {
    const msg = {
      id: messageId,
      agentId,
      name: state.agents[agentId]?.name,
      text,
      timestamp: Date.now()
    }
    state.messages.push(msg)
    if (state.messages.length > 100) {
      state.messages = state.messages.slice(-100)
    }
    io.emit("textComplete", msg)
  })"""

NEW_TC_END = """  socket.on("textComplete", ({ agentId, text, messageId }) => {
    const msg = {
      id: messageId,
      agentId,
      name: state.agents[agentId]?.name,
      text,
      timestamp: Date.now()
    }
    state.messages.push(msg)
    if (state.messages.length > 100) {
      state.messages = state.messages.slice(-100)
    }
    io.emit("textComplete", msg)

    // Two-agent loop: forward this turn to the OTHER agent as a textToAgent
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
    }
  })"""

if OLD_TC_END in s:
    s = s.replace(OLD_TC_END, NEW_TC_END)
    open(p, "w").write(s)
    print("[ok] server: two-agent forwarding wired")
elif "Two-agent loop:" in s:
    print("[skip] server already patched")
else:
    print("[WARN] textComplete handler not found in expected shape")

# 2. agent2.html: greeting trigger
p2 = "/home/agent/ai-agents-x-space/public/agent2.html"
s2 = open(p2).read()
old = 'dc.onopen = () => log("Data channel open", "success")'
new = (
    'dc.onopen = () => {\n'
    '          log("Data channel open", "success")\n'
    '          setTimeout(() => {\n'
    '            try {\n'
    '              dc.send(JSON.stringify({\n'
    '                type: "response.create",\n'
    '                response: { instructions: "You just joined the Space. Briefly chime in \\u2014 dry, witty, maybe ribbing Swarm a little. Keep it to one short sentence." }\n'
    '              }))\n'
    '              log("Sent greet trigger", "success")\n'
    '            } catch (e) { log("greet trigger failed: " + e.message, "error") }\n'
    '          }, 2500)\n'
    '        }'
)
if old in s2:
    s2 = s2.replace(old, new)
    open(p2, "w").write(s2)
    print("[ok] agent2.html: greeting trigger added")
elif "Sent greet trigger" in s2:
    print("[skip] agent2.html already patched")
else:
    print("[WARN] agent2.html greeting anchor not found")
