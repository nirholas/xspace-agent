#!/usr/bin/env node
// Operator registry CLI
// Usage: pnpm operator <add|remove|list|rotate> [name] [--role admin|viewer]

import fs from "fs"
import crypto from "crypto"
import path from "path"
import readline from "readline"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REGISTRY_PATH = path.join(__dirname, "..", "operators.json")

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"))
  } catch (e) {
    if (e.code === "ENOENT") return { operators: [] }
    throw new Error("Failed to read operators.json: " + e.message)
  }
}

function writeRegistry(data) {
  const tmp = REGISTRY_PATH + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8")
  fs.renameSync(tmp, REGISTRY_PATH)
}

function hashKey(key) {
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = crypto.scryptSync(key, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

function generateKey() {
  return crypto.randomBytes(32).toString("hex")
}

function prompt(question, { silent } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    if (silent) {
      process.stdout.write(question)
      process.stdin.setRawMode?.(true)
      let buf = ""
      process.stdin.setEncoding("utf8")
      const onData = (ch) => {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode?.(false)
          process.stdin.removeListener("data", onData)
          rl.close()
          process.stdout.write("\n")
          resolve(buf)
        } else if (ch === "") {
          process.exit()
        } else {
          buf += ch
        }
      }
      process.stdin.on("data", onData)
    } else {
      rl.question(question, (answer) => { rl.close(); resolve(answer) })
    }
  })
}

const args = process.argv.slice(2)
const cmd = args[0]
const name = args[1] && !args[1].startsWith("--") ? args[1] : null
const roleIdx = args.indexOf("--role")
const roleArg = roleIdx >= 0 ? args[roleIdx + 1] : null

const USAGE = `
Operator registry CLI

Commands:
  pnpm operator add <name> [--role admin|viewer]   Add operator (prompts for key or generates one)
  pnpm operator remove <name>                       Remove operator
  pnpm operator list                                List all operators
  pnpm operator rotate <name>                       Generate a fresh key for an operator
`.trim()

async function cmdAdd() {
  if (!name) { console.error("Error: name required"); process.exit(1) }
  const role = roleArg || "admin"
  if (role !== "admin" && role !== "viewer") {
    console.error("Error: --role must be admin or viewer"); process.exit(1)
  }
  const reg = readRegistry()
  if (reg.operators.find(o => o.name === name)) {
    console.error(`Error: operator "${name}" already exists — use 'rotate' to change their key`)
    process.exit(1)
  }
  let key
  const raw = await prompt("Key (leave blank to generate): ")
  if (raw.trim()) {
    key = raw.trim()
    console.log(`\nOperator "${name}" (${role}) added with provided key.`)
  } else {
    key = generateKey()
    console.log(`\nGenerated key (shown once — copy it now):\n\n  ${key}\n`)
    console.log(`Operator "${name}" (${role}) added.`)
  }
  reg.operators.push({
    name,
    keyHash: hashKey(key),
    role,
    createdAt: new Date().toISOString(),
    lastSeenAt: null
  })
  writeRegistry(reg)
}

function cmdRemove() {
  if (!name) { console.error("Error: name required"); process.exit(1) }
  const reg = readRegistry()
  const before = reg.operators.length
  reg.operators = reg.operators.filter(o => o.name !== name)
  if (reg.operators.length === before) {
    console.error(`Error: operator "${name}" not found`)
    process.exit(1)
  }
  writeRegistry(reg)
  console.log(`Operator "${name}" removed.`)
}

function cmdList() {
  const reg = readRegistry()
  if (!reg.operators.length) {
    console.log("(no operators — operators.json is empty or missing)")
    return
  }
  const rows = reg.operators.map(o => ({
    name: o.name,
    role: o.role,
    created: o.createdAt ? new Date(o.createdAt).toLocaleDateString() : "—",
    "last seen": o.lastSeenAt ? new Date(o.lastSeenAt).toLocaleString() : "never"
  }))
  console.table(rows)
}

async function cmdRotate() {
  if (!name) { console.error("Error: name required"); process.exit(1) }
  const reg = readRegistry()
  const op = reg.operators.find(o => o.name === name)
  if (!op) { console.error(`Error: operator "${name}" not found`); process.exit(1) }
  const key = generateKey()
  op.keyHash = hashKey(key)
  writeRegistry(reg)
  console.log(`Key rotated for "${name}" (shown once — copy it now):\n\n  ${key}\n`)
}

;(async () => {
  switch (cmd) {
    case "add":    await cmdAdd(); break
    case "remove": cmdRemove(); break
    case "list":   cmdList(); break
    case "rotate": await cmdRotate(); break
    default:
      console.log(USAGE)
      process.exit(cmd ? 1 : 0)
  }
})().catch(e => { console.error("Error:", e.message); process.exit(1) })
