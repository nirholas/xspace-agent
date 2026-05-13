#!/usr/bin/env node
// Build script for the Vercel static dashboard.
// Copies dashboard-vercel/ files to dist/, substituting the <meta name="api-base">
// content with the DASHBOARD_API environment variable.
//
// Usage (called automatically by Vercel via vercel.json buildCommand):
//   DASHBOARD_API=https://dashboard.YOURDOMAIN.com node inject-api.js
//
// Local dry-run:
//   DASHBOARD_API=https://dashboard.YOURDOMAIN.com node inject-api.js

const fs   = require("fs")
const path = require("path")

const DIST = path.join(__dirname, "dist")
const SRC  = __dirname

const API = (process.env.DASHBOARD_API || "").replace(/\/$/, "")
if (!API) {
  console.warn("⚠  DASHBOARD_API is not set — meta[api-base] will be empty (same-origin fallback).")
}

fs.mkdirSync(DIST, { recursive: true })
fs.mkdirSync(path.join(DIST, "js"), { recursive: true })

// Files to copy verbatim (source → dest relative to their dirs)
const copies = [
  ["dashboard.css",          "dashboard.css"],
  ["dashboard.js",           "dashboard.js"],
  ["js/dashboard-cost-panel.js", "js/dashboard-cost-panel.js"],
]

for (const [src, dest] of copies) {
  const srcPath  = path.join(SRC, src)
  const destPath = path.join(DIST, dest)
  if (!fs.existsSync(srcPath)) {
    console.error(`✗ missing source file: ${srcPath}`)
    process.exit(1)
  }
  fs.copyFileSync(srcPath, destPath)
  console.log(`  copied ${src}`)
}

// Inject API_BASE into dashboard.html
const htmlSrc  = path.join(SRC, "dashboard.html")
const htmlDest = path.join(DIST, "dashboard.html")
let html = fs.readFileSync(htmlSrc, "utf8")
html = html.replace(
  /<meta name="api-base" content="[^"]*"\s*\/?>/,
  `<meta name="api-base" content="${API}" />`
)
fs.writeFileSync(htmlDest, html, "utf8")
console.log(`  dashboard.html → dist/ (api-base="${API}")`)

console.log("Build complete.")
