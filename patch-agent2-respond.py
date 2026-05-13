#!/usr/bin/env python3
"""Make agent2's textToAgent handler actually generate a response.
Original repo design only had Swarm respond; for two-agent banter we need both."""

p = "/home/agent/ai-agents-x-space/public/agent2.html"
s = open(p).read()

OLD = '''    socket.on("textToAgent", ({ text, from }) => {
      log("User message: " + text + " (Sam will respond)")
    })'''

NEW = '''    socket.on("textToAgent", ({ text, from }) => {
      if (!dc || dc.readyState !== "open") return

      log("Received text from " + from + ": " + text)

      const event = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `[CHAT - ${from}]: ${text}` }]
        }
      }
      dc.send(JSON.stringify(event))

      setTimeout(() => {
        dc.send(JSON.stringify({ type: "response.create" }))
      }, 100)
    })'''

if OLD in s:
    s = s.replace(OLD, NEW)
    open(p, "w").write(s)
    print("[ok] agent2.html: textToAgent now generates a response")
elif 'log("Received text from " + from' in s:
    print("[skip] already patched")
else:
    print("[WARN] anchor not found — agent2.html may have changed")
