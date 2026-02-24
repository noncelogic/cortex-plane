import { readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const MIGRATIONS_DIR = join(__dirname, "../../migrations")

const name = process.argv[2]
if (!name) {
  console.error("Usage: db:migrate:create <migration_name>")
  process.exit(1)
}

const files = await readdir(MIGRATIONS_DIR).catch(() => [])
let maxVersion = 0
for (const file of files) {
  const match = /^(\d+)_/.exec(file)
  if (match) {
    const version = parseInt(match[1]!, 10)
    if (version > maxVersion) maxVersion = version
  }
}

const nextVersion = String(maxVersion + 1).padStart(3, "0")
const slug = name.replace(/\s+/g, "_").toLowerCase()
const upFile = join(MIGRATIONS_DIR, `${nextVersion}_${slug}.up.sql`)
const downFile = join(MIGRATIONS_DIR, `${nextVersion}_${slug}.down.sql`)

await writeFile(upFile, `-- ${nextVersion}: ${name}\n\n`)
await writeFile(downFile, `-- Rollback ${nextVersion}: ${name}\n\n`)

console.log(`Created: ${nextVersion}_${slug}.up.sql`)
console.log(`Created: ${nextVersion}_${slug}.down.sql`)
