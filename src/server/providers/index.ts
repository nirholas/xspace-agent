import type { Provider } from "../types"

export const AI_PROVIDER = (process.env.AI_PROVIDER || "openai").toLowerCase()

export function createProvider(): Provider {
  switch (AI_PROVIDER) {
    case "claude":
      return require("./claude") as Provider
    case "groq":
      return require("./groq") as Provider
    case "openai-chat":
      return require("./openai-chat") as Provider
    case "openai":
    default:
      return require("./openai-realtime") as Provider
  }
}
