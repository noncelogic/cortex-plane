/**
 * Extraction prompt template for LLM-based memory extraction
 * from session transcripts.
 */

export interface Message {
  role: string
  content: string
  timestamp: string
}

/**
 * Build the extraction system prompt with structured output instructions.
 */
export function buildExtractionSystemPrompt(): string {
  return `You are a memory extraction system. Your job is to analyze conversation transcripts and extract atomic facts — discrete, self-contained pieces of information worth remembering.

## Output Format

Respond with ONLY a JSON object matching this exact structure:

\`\`\`json
{
  "facts": [
    {
      "content": "A clear, concise statement of the fact (10-2000 chars)",
      "type": "fact | preference | event | system_rule | lesson | relationship",
      "confidence": 0.0-1.0,
      "importance": 1-5,
      "tags": ["tag1", "tag2"],
      "people": ["person1"],
      "projects": ["project1"],
      "source": {
        "sessionId": "<provided>",
        "turnIndex": <index of the message>,
        "timestamp": "<ISO timestamp>"
      },
      "supersedes": []
    }
  ]
}
\`\`\`

## Fact Types

- **fact**: Objective information ("The API uses REST with JSON payloads")
- **preference**: User/agent preferences ("User prefers TypeScript over JavaScript")
- **event**: Time-bound occurrences ("Deployed v2.1 to production on Jan 5")
- **system_rule**: Invariant rules ("Never commit directly to main branch")
- **lesson**: Learned insights ("Retry with exponential backoff prevents cascading failures")
- **relationship**: Connections between entities ("Alice manages the infrastructure team")

## Extraction Guidelines

1. **Atomic**: Each fact should express exactly one piece of information
2. **Self-contained**: Facts should be understandable without the original conversation
3. **Confidence**: Rate how certain you are (0.0 = speculation, 1.0 = explicitly stated)
4. **Importance**: Rate how useful this is long-term (1 = trivial, 5 = critical)
5. **Tags**: Add relevant topic tags (max 10)
6. **People**: Extract mentioned people's names (max 10)
7. **Projects**: Extract mentioned project/product names (max 10)
8. **Dedup awareness**: Don't extract the same fact twice from rephrased statements
9. **Skip noise**: Ignore greetings, filler, and conversation mechanics

## Examples

Given a conversation about deploying a service:

\`\`\`json
{
  "facts": [
    {
      "content": "The payment-service requires PostgreSQL 15+ and Redis 7+ as runtime dependencies",
      "type": "fact",
      "confidence": 0.95,
      "importance": 4,
      "tags": ["infrastructure", "dependencies", "payment-service"],
      "people": [],
      "projects": ["payment-service"],
      "source": { "sessionId": "sess-001", "turnIndex": 3, "timestamp": "2025-01-15T10:30:00Z" },
      "supersedes": []
    },
    {
      "content": "Team prefers blue-green deployments over rolling updates for stateful services",
      "type": "preference",
      "confidence": 0.8,
      "importance": 3,
      "tags": ["deployment", "infrastructure"],
      "people": [],
      "projects": [],
      "source": { "sessionId": "sess-001", "turnIndex": 7, "timestamp": "2025-01-15T10:35:00Z" },
      "supersedes": []
    },
    {
      "content": "Alice is the on-call lead for the payment-service this quarter",
      "type": "relationship",
      "confidence": 0.9,
      "importance": 3,
      "tags": ["on-call", "payment-service"],
      "people": ["Alice"],
      "projects": ["payment-service"],
      "source": { "sessionId": "sess-001", "turnIndex": 12, "timestamp": "2025-01-15T10:42:00Z" },
      "supersedes": []
    }
  ]
}
\`\`\`

Return ONLY the JSON object. No markdown fences, no explanation.`
}

/**
 * Build the user message containing the session transcript.
 */
export function buildExtractionUserPrompt(sessionId: string, messages: Message[]): string {
  const transcript = messages
    .map((m, i) => `[${i}] [${m.timestamp}] ${m.role}: ${m.content}`)
    .join("\n\n")

  return `Extract atomic facts from this session transcript.

Session ID: ${sessionId}

--- TRANSCRIPT START ---
${transcript}
--- TRANSCRIPT END ---

Extract all meaningful facts, preferences, events, rules, lessons, and relationships. Use the session ID "${sessionId}" in each fact's source.sessionId field.`
}
