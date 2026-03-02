# Cortex Plane — Vision

> A chat-first control plane for autonomous agents.
> OpenClaw's runtime model, with the observability and management layer it deserves.

---

## What Is This?

Cortex Plane is an orchestration platform for autonomous AI agents. You talk to agents through chat (Telegram, Discord, or the REST API). Messages route to the right agent via channel bindings, the agent calls an LLM with conversation history and tools, and streams the response back. The dashboard shows you everything — jobs running, approvals pending, browser sessions, memory state — without you having to ask.

**Think of it as:** OpenClaw's agent runtime + a proper cockpit.

## What Works Today

The core runtime loop is operational:

1. **Chat adapters** (Telegram, Discord) start at boot and listen for messages
2. **Agent-channel binding** routes each chat to the correct agent
3. **Session buffer** tracks multi-turn conversation history per agent/user/channel
4. **Execution backends** (Anthropic Claude, OpenAI-compatible, Claude CLI) run the agentic loop
5. **Tool framework** gives agents built-in tools (web search, HTTP requests, memory) plus per-agent webhook tools
6. **Streaming output** flows back to chat and dashboard via SSE in real-time
7. **REST chat endpoint** (`POST /agents/:agentId/chat`) provides the same flow for programmatic clients

You can create an agent, bind it to a Telegram chat, send a message, and get an LLM-powered response with tool use — end to end.

## Design Philosophy

### Chat First, Dashboard Second

The primary interface is conversation. You tell an agent what you want. It figures out how. The dashboard is the instrument panel — you glance at it to see altitude, heading, fuel. You don't fly the plane from the instrument panel.

### Orchestration, Not Execution

The control plane dispatches work; it does not run LLM inference. LLM providers (Anthropic, OpenAI) are execution backends accessed via API. The control plane is the persistent brain — it tracks state, enforces approval gates, manages memory, routes messages, and manages tools.

### Observe Everything

Every agent action is observable. Jobs have state machines with retry and error classification. Browser sessions have screenshots and traces. Memory extraction runs on conversation output. Approval gates create audit trails. The dashboard surfaces all of it in real-time via SSE.

### OpenClaw Is the Model

OpenClaw proves the pattern: chat-driven agents that use tools, maintain memory across sessions, and execute multi-step tasks. Cortex Plane takes that pattern and adds:

- **Multi-agent management** — N agents, each with their own channels, credentials, tools, and memory
- **Structured job tracking** — durable state machines with retry, error classification, and approval gates
- **Visual observability** — see what every agent is doing without asking
- **Credential isolation** — per-user, per-agent encrypted credential storage
- **Cloud-native deployment** — k3s, Docker Compose, CI/CD with GHCR

### No Black Boxes

Every decision is traceable. Every approval has an audit trail. Every job has logs. If something went wrong, you can find out why without guessing.

## Architecture

```text
┌─────────────────────────────────────────────────────┐
│                    Chat Channels                      │
│              Telegram · Discord · REST API             │
└──────────────────────┬──────────────────────────────┘
                       │ inbound messages
                       ▼
┌─────────────────────────────────────────────────────┐
│                   Control Plane                       │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Message   │  │ Agent    │  │ Job Orchestrator  │  │
│  │ Router    │──│ Sessions │──│ (Graphile Worker) │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Approval │  │ Memory   │  │ Tool              │  │
│  │ Gates    │  │ System   │  │ Registry          │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Credential│  │ Channel  │  │ SSE Streaming     │  │
│  │ Vault    │  │ Supervisor│  │ (real-time)       │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │ dispatch jobs
                       ▼
┌─────────────────────────────────────────────────────┐
│               Execution Backends                      │
│      HttpLlm (Anthropic/OpenAI) · Claude CLI · Echo   │
│              ┌──────────────────┐                      │
│              │  Agentic Loop    │                      │
│              │  LLM → tools →   │                      │
│              │  LLM → response  │                      │
│              └──────────────────┘                      │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                    Dashboard                          │
│    Agents · Jobs · Approvals · Memory · Browser       │
│              Settings · Pulse · Login                 │
└─────────────────────────────────────────────────────┘
```

## The Runtime Loop

This is how a message flows through the system today:

1. **User sends message** via Telegram, Discord, or `POST /agents/:agentId/chat`
2. **MessageRouter** resolves user identity (channel user → unified `user_account`)
3. **AgentChannelService** finds the bound agent (direct binding or default agent)
4. **Session** is found or created, scoped to `(agent, user, channel)`
5. **Message stored** in `session_message` table
6. **Conversation history** loaded (last 50 messages)
7. **Job created** (`CHAT_RESPONSE` type) and enqueued via Graphile Worker
8. **`agent_execute` task** runs: resolves backend, builds execution task with tools
9. **Agentic loop** executes: LLM call → tool use → LLM call → ... → final response
10. **Output streams** to SSE (dashboard) and JSONL buffer (memory extraction)
11. **Response relayed** back to the originating chat channel
12. **Memory extraction** scheduled on conversation output

## What's Not Built Yet

- **Sub-agent spawning** — agents can't create child agents
- **Agent-initiated jobs** — agents can't spawn sub-jobs mid-execution
- **Agent → browser** — no tool to launch Playwright sessions
- **Scheduling** — no cron or recurring task support
- **Content generation** — no agent → content pipeline integration
- **Skills framework** — no reusable skill packages
- **Slack/WhatsApp adapters** — only Telegram and Discord

For current implementation status, see [`STATUS.md`](./STATUS.md).

## Open Source

This project is designed to be open-sourced. Contributors should be able to:

1. Read this document to understand _why_
2. Read the spec (`docs/spec.md`) to understand _what_
3. Read the spikes (`docs/spikes/`) to understand _how we decided_
4. Look at the code and see the spec reflected in the architecture

---

_For technical details, see `docs/spec.md`. For implementation status, see `docs/STATUS.md`._
