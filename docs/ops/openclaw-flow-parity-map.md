# OpenClaw Flow Parity Map

Purpose: accelerate feature delivery by making flow-level parity gaps explicit, measurable, and reviewable in normal PRs.

## Usage

Use this map when a PR touches chat/runtime orchestration flows. The Project Orchestrator is the default owner for platform-direction and OpenClaw-transition convergence decisions. Mark whether the change:

- achieves parity,
- reduces a gap, or
- is an intentional Cortex Plane divergence.

## Parity surfaces (v1)

| Surface              | OpenClaw-like expectation                                           | Cortex Plane current baseline                                    | Target state                                              |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| Session continuity   | Multi-turn state persists and resumes across interruptions          | Session exists but continuity gaps remain in edge recovery paths | Durable resume semantics for every dispatch/retry path    |
| Agent loop execution | Tool-using loop runs predictably with clear control-plane ownership | Loop exists with mixed backend assumptions                       | Unified orchestration contract across backends            |
| Operator visibility  | Real-time per-session and per-agent runtime visibility              | Dashboard visibility exists; flow-level attribution is partial   | End-to-end flow attribution with actionable diagnostics   |
| Steering control     | Fast single-round steering before execution drift compounds         | Steering can expand across rounds in complex tickets             | One-round steering default, then stabilization escalation |

## Convergence status labels

Use one label in PR evidence for flow-touching work:

- `parity` — matches expected behavior for the touched surface.
- `gap-reduction` — materially narrows a known parity gap.
- `intentional-divergence` — differs from OpenClaw pattern by design; must include rationale + linked issue.

## Evidence expectations

Flow-touching PRs should include:

1. Surface(s) touched from the table above.
2. Chosen convergence status label.
3. Verification proof (tests, fixture evidence, runtime trace, or dashboard proof).
4. Linked issue when status is `intentional-divergence`.
