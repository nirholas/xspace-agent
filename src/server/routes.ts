import { Router } from "express"
import path from "path"
import type { Provider, ServerConfig, SpaceState } from "./types"
import { AI_PROVIDER } from "./providers"
import { TTS_PROVIDER } from "./providers/tts"
import { routeLogger } from "./logger"

export function createRoutes(
  config: ServerConfig,
  state: SpaceState,
  provider: Provider,
  prompts: Record<number, string>,
  voices: Record<number, string>,
): Router {
  const router = Router()
  const publicDir = path.join(process.cwd(), "public")

  router.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")))
  router.get("/bob", (_req, res) => res.sendFile(path.join(publicDir, "bob.html")))
  router.get("/alice", (_req, res) => res.sendFile(path.join(publicDir, "alice.html")))
  router.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")))
  router.get("/builder", (_req, res) => res.sendFile(path.join(publicDir, "builder.html")))
  router.get("/landing", (_req, res) => res.sendFile(path.join(publicDir, "landing.html")))
  router.get("/hub", (_req, res) => res.sendFile(path.join(publicDir, "hub.html")))

  // Server package pages
  router.get("/server-admin", (_req, res) => res.sendFile(path.join(publicDir, "server-admin.html")))
  router.get("/server-dashboard", (_req, res) => res.sendFile(path.join(publicDir, "server-dashboard.html")))
  router.get("/server-builder", (_req, res) => res.sendFile(path.join(publicDir, "server-builder.html")))
  router.get("/server-agent1", (_req, res) => res.sendFile(path.join(publicDir, "server-agent1.html")))
  router.get("/server-agent2", (_req, res) => res.sendFile(path.join(publicDir, "server-agent2.html")))

  // Voice chat pages
  router.get("/voice-chat", (_req, res) => res.sendFile(path.join(publicDir, "voice-chat.html")))
  router.get("/voice-chat-landing", (_req, res) => res.sendFile(path.join(publicDir, "voice-chat-landing.html")))
  router.get("/voice-chat-session", (_req, res) => res.sendFile(path.join(publicDir, "voice-chat-session.html")))

  // Contentium pages
  router.get("/contentium", (_req, res) => res.sendFile(path.join(publicDir, "contentium.html")))
  router.get("/contentium-v2", (_req, res) => res.sendFile(path.join(publicDir, "contentium-v2.html")))

  // Legacy & widget demos
  router.get("/legacy-admin", (_req, res) => res.sendFile(path.join(publicDir, "legacy-admin.html")))
  router.get("/widget-demo", (_req, res) => res.sendFile(path.join(publicDir, "widget-demo.html")))
  router.get("/react-widget-demo", (_req, res) => res.sendFile(path.join(publicDir, "react-widget-demo.html")))
  router.get("/vue-widget-demo", (_req, res) => res.sendFile(path.join(publicDir, "vue-widget-demo.html")))

  router.get("/config", (_req, res) =>
    res.json({
      inputChat: config.inputChat,
      liveChat: config.liveChat,
      xLink: config.xLink,
      githubLink: config.githubLink,
      avatarUrl1: config.avatarUrl1,
      avatarUrl2: config.avatarUrl2,
      aiProvider: AI_PROVIDER,
      providerType: provider.type,
      ttsMode: TTS_PROVIDER,
    }),
  )

  router.get("/state", (_req, res) =>
    res.json({
      agents: state.agents,
      currentTurn: state.currentTurn,
      messages: state.messages.slice(-50),
    }),
  )

  router.get("/session/:agentId", async (req, res) => {
    const agentId = parseInt(req.params.agentId)
    if (agentId !== 0 && agentId !== 1) return res.status(400).json({ error: "Invalid agent ID" })
    if (provider.type !== "webrtc") return res.json({ type: "socket", provider: AI_PROVIDER })
    try {
      const data = await provider.createSession!(agentId, prompts, voices)
      res.json(data)
    } catch (error: unknown) {
      const err = error as { response?: { data?: unknown }; message?: string }
      routeLogger.error({ err: err.response?.data || err.message }, "session creation error")
      res.status(500).json({ error: "Failed to create session" })
    }
  })

  return router
}
