// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§70]

// DEPRECATED: Use packages/core (xspace-agent) instead.
// This file is kept for backward compatibility with server.js.
// Will be removed in v1.0.

const axios = require("axios")

const API_KEY = process.env.OPENAI_API_KEY
// GA model released May 2025. Override via OPENAI_REALTIME_MODEL env var.
const DEFAULT_REALTIME_MODEL = "gpt-realtime"
const MODEL = process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL

module.exports = {
  type: "webrtc",

  async createSession(agentId, prompts, voices) {
    const response = await axios.post(
      "https://api.openai.com/v1/realtime/sessions",
      {
        model: MODEL,
        modalities: ["audio", "text"],
        voice: voices[agentId],
        instructions: prompts[agentId]
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    )
    // Include model so the browser client can use it in the SDP URL without hardcoding.
    return { ...response.data, model: MODEL }
  },

  async checkHealth() {
    try {
      await axios.post(
        "https://api.openai.com/v1/realtime/sessions",
        { model: MODEL, modalities: ["text"] },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      )
      console.log(`[Realtime] model = ${MODEL}  ✓`)
    } catch (err) {
      const status = err.response?.status
      const detail = err.response?.data?.error?.message || err.message
      console.error(
        `[Realtime] model = ${MODEL}  ✗ (${status || "network error"}: ${detail})\n` +
        `  → Set OPENAI_REALTIME_MODEL in .env to override.`
      )
    }
  }
}


