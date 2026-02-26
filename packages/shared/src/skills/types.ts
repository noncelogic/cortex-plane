/**
 * Skill system types.
 *
 * Skills are modular capability definitions stored as SKILL.md files.
 * Each skill has lightweight metadata (for indexing) and full content
 * (loaded on demand for progressive disclosure).
 */

// ---------------------------------------------------------------------------
// Skill Constraints
// ---------------------------------------------------------------------------

/**
 * Per-skill policy boundaries.
 * These narrow (never widen) the agent-level constraints.
 */
export interface SkillConstraints {
  /** Tools the skill is allowed to use. Empty = inherit from agent. */
  allowedTools: string[]
  /** Tools explicitly denied for this skill. Takes precedence over allowed. */
  deniedTools: string[]
  /** Whether the skill may make network requests. */
  networkAccess: boolean
  /** Whether the skill may execute shell commands. */
  shellAccess: boolean
}

// ---------------------------------------------------------------------------
// Skill Metadata (lightweight index entry)
// ---------------------------------------------------------------------------

/**
 * Lightweight metadata extracted from SKILL.md frontmatter.
 * Used for the skill index — never includes full content.
 */
export interface SkillMetadata {
  /** Unique skill name (directory name, e.g. "code-review"). */
  name: string
  /** Human-readable title. */
  title: string
  /** Categorization tags for skill discovery. */
  tags: string[]
  /** One-line summary for progressive disclosure. */
  summary: string
  /** Per-skill policy constraints. */
  constraints: SkillConstraints
  /** SHA-256 hash of the full SKILL.md content for cache validation. */
  contentHash: string
  /** File modification time (ms since epoch) for change detection. */
  mtimeMs: number
  /** Absolute path to the SKILL.md file. */
  filePath: string
}

// ---------------------------------------------------------------------------
// Skill Definition (full loaded skill)
// ---------------------------------------------------------------------------

/**
 * Full skill definition — metadata plus the complete instruction body.
 * Loaded on demand only for skills selected for a task.
 */
export interface SkillDefinition {
  /** Skill metadata (same as in the index). */
  metadata: SkillMetadata
  /** Full instruction body (SKILL.md content minus frontmatter). */
  content: string
}

// ---------------------------------------------------------------------------
// Resolved Skills (for injection into execution context)
// ---------------------------------------------------------------------------

/**
 * Skills resolved for a specific task execution.
 * Contains summaries of all available skills and full content
 * of selected skills.
 */
export interface ResolvedSkills {
  /** All available skill summaries (for context). */
  summaries: Array<{ name: string; title: string; summary: string; tags: string[] }>
  /** Full content of selected skills. */
  selected: SkillDefinition[]
  /** Merged constraints from all selected skills. */
  mergedConstraints: SkillConstraints
  /** Estimated token count of the injected skill content. */
  estimatedTokens: number
}
