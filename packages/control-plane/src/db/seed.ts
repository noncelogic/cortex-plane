/**
 * Seed Script — Insert demo agents for live demo.
 *
 * Usage: pnpm db:seed
 *
 * Idempotent: uses ON CONFLICT (slug) DO NOTHING to avoid duplicates.
 */

import pg from "pg"

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://cortex:cortex_dev@localhost:5432/cortex_plane"

interface SeedAgent {
  name: string
  slug: string
  role: string
  description: string
  model_config: Record<string, unknown>
  skill_config: Record<string, unknown>
}

const DEMO_AGENTS: SeedAgent[] = [
  {
    name: "Atlas",
    slug: "atlas",
    role: "general-purpose assistant",
    description:
      "General-purpose assistant capable of research, writing, analysis, and multi-step reasoning. The default agent for broad tasks.",
    model_config: {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 8192,
      provider: "anthropic",
    },
    skill_config: {
      allowed_tools: ["web_search", "file_read", "file_write"],
    },
  },
  {
    name: "Forge",
    slug: "forge",
    role: "code generation specialist",
    description:
      "Code generation and editing specialist. Optimized for creating, modifying, and refactoring codebases across multiple languages.",
    model_config: {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 8192,
      provider: "anthropic",
    },
    skill_config: {
      allowed_tools: ["file_read", "file_write", "shell_command", "code_search"],
    },
  },
  {
    name: "Sentinel",
    slug: "sentinel",
    role: "security reviewer",
    description:
      "Security-focused code reviewer. Scans for vulnerabilities, misconfigurations, and OWASP Top 10 issues. Read-only by default.",
    model_config: {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 8192,
      provider: "anthropic",
    },
    skill_config: {
      allowed_tools: ["file_read", "code_search"],
      denied_tools: ["file_write", "shell_command"],
    },
  },
]

async function seed(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const client = await pool.connect()

  try {
    let inserted = 0

    for (const agent of DEMO_AGENTS) {
      const result = await client.query(
        `INSERT INTO agent (name, slug, role, description, model_config, skill_config)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [
          agent.name,
          agent.slug,
          agent.role,
          agent.description,
          JSON.stringify(agent.model_config),
          JSON.stringify(agent.skill_config),
        ],
      )
      if (result.rowCount && result.rowCount > 0) {
        console.log(`  ✓ Created agent: ${agent.name} (${agent.slug})`)
        inserted++
      } else {
        console.log(`  – Skipped agent: ${agent.name} (${agent.slug}) — already exists`)
      }
    }

    console.log(`\nSeed complete: ${String(inserted)} agent(s) inserted.`)
  } finally {
    client.release()
    await pool.end()
  }
}

await seed()
