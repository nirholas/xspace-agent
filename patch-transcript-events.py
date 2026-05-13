#!/usr/bin/env python3
"""GA Realtime API renamed transcript events:
   response.audio_transcript.delta -> response.output_audio_transcript.delta
   response.audio_transcript.done  -> response.output_audio_transcript.done
Patch both agent pages to accept either name (preserves back-compat)."""
import re

for path in [
    "/home/agent/ai-agents-x-space/public/agent1.html",
    "/home/agent/ai-agents-x-space/public/agent2.html",
]:
    s = open(path).read()
    before = s
    s = s.replace(
        'msg.type === "response.audio_transcript.delta"',
        '(msg.type === "response.audio_transcript.delta" || msg.type === "response.output_audio_transcript.delta")',
    )
    s = s.replace(
        'msg.type === "response.audio_transcript.done"',
        '(msg.type === "response.audio_transcript.done" || msg.type === "response.output_audio_transcript.done")',
    )
    if s != before:
        open(path, "w").write(s)
        print(f"[ok] patched {path}")
    else:
        print(f"[skip] {path} (no matching event names found)")
