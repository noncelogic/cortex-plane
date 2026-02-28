# Cortex Plane — Vision

> A chat-first control plane for autonomous agents.
> OpenClaw's runtime model, with the observability and management layer it deserves.

---

## What Is This?

Cortex Plane is an orchestration platform for autonomous AI agents. You talk to agents through chat (Telegram, Slack, Discord). They break down goals, execute tasks, ask for approval when needed, and report back. The dashboard shows you everything that's happening — jobs running, approvals pending, browser sessions, memory state — without you having to ask.

**Think of it as:** OpenClaw's agent runtime + a proper cockpit.

## Design Philosophy

### Chat First, Dashboard Second

The primary interface is conversation. You tell an agent what you want. It figures out how. The dashboard is the instrument panel — you glance at it to see altitude, heading, fuel. You don't fly the plane from the instrument panel.

### Orchestration, Not Execution

The control plane dispatches work; it does not run LLM inference. Coding models (Claude Code, Codex, GPT) are ephemeral execution backends. The control plane is the persistent brain — it tracks state, enforces approval gates, manages memory, and routes messages.

### Observe Everything

Every agent action is observable. Jobs have state machines. Browser sessions have screenshots and traces. Memory extraction runs on conversations. Approval gates create audit trails. The dashboard surfaces all of it in real-time via SSE.

### OpenClaw Is the Model

OpenClaw proves the pattern: chat-driven agents that spawn sub-agents, schedule tasks, use tools, and maintain memory across sessions. Cortex Plane takes that pattern and adds:

- **Multi-agent management** — N agents, each with their own channels, credentials, and memory
- **Structured job tracking** — not just "sub-agent running" but durable state machines with retry, approval gates, and audit trails
- **Visual observability** — see what every agent is doing without asking
- **Credential isolation** — per-user, per-agent encrypted credential storage
- **Cloud-native deployment** — k3s, per-agent containers, auto-recovery

### No Black Boxes

Every decision is traceable. Every approval has an audit trail. Every job has logs. If something went wrong, you can find out why without guessing.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    Chat Channels                      │
│           Telegram · Discord · Slack · Web            │
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
│  │ Approval │  │ Memory   │  │ Browser           │  │
│  │ Gates    │  │ Extract  │  │ Orchestration     │  │
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
│         Claude Code · HTTP LLM · Echo (test)          │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                    Dashboard                          │
│    Agents · Jobs · Approvals · Memory · Browser       │
│              Settings · Pulse · Login                 │
└─────────────────────────────────────────────────────┘
```

## The Agentic Loop

1. **User sends message** via Telegram/Slack/Discord
2. **Message Router** resolves user identity, finds bound agent
3. **Agent session** receives message, sends to execution backend (LLM)
4. **LLM reasons** about the goal, breaks it into tasks
5. **Jobs are created** in Graphile Worker with durable state
6. **Approval gates** fire for high-risk operations → user approves via chat or dashboard
7. **Browser sessions** launch when agents need web interaction
8. **Memory extraction** runs on conversation history
9. **Results stream** back to chat + dashboard via SSE
10. **Repeat** — the agent can schedule follow-ups, spawn sub-tasks, or wait for the next message

## What Success Looks Like

A user creates an agent, connects it to their Telegram, gives it Claude API credentials, and says "monitor my GitHub PRs and summarize them daily." The agent:

- Breaks this into a recurring task
- Schedules daily checks
- Fetches PR data via browser or API
- Generates summaries
- Sends them via Telegram
- Logs everything in the dashboard

The user opens the dashboard and sees: agent status, job history, memory of past summaries, approval trail if any actions needed sign-off.

## Open Source

This project is designed to be open-sourced. Contributors should be able to:

1. Read the VISION (this document) to understand _why_
2. Read the spec (`docs/spec.md`) to understand _what_
3. Read the spikes (`docs/spikes/`) to understand _how we decided_
4. Look at the code and see the spec reflected in the architecture

---

_This document describes intent. For technical details, see `docs/spec.md`. For implementation status, see `docs/STATUS.md`._
