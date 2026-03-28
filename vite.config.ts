import { defineConfig } from "vite"
import path from "path"

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/client",
    rollupOptions: {
      input: {
        agent: path.resolve(__dirname, "src/client/bootstrap.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
})
