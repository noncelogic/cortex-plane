# Security Threat Model — Cortex Plane

> **Version:** 1.0
> **Date:** 2026-02-24
> **Status:** Draft
> **Ticket:** [#22 — Security threat model](https://github.com/noncelogic/cortex-plane/issues/22)
> **Methodology:** STRIDE + Risk Matrix (Likelihood × Impact)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Trust Boundaries](#2-trust-boundaries)
3. [STRIDE Threat Analysis](#3-stride-threat-analysis)
   - 3.1 [Prompt Injection](#31-prompt-injection)
   - 3.2 [Agent Isolation](#32-agent-isolation)
   - 3.3 [Secret Management](#33-secret-management)
   - 3.4 [Network Policies](#34-network-policies)
   - 3.5 [Shared Volume Attacks](#35-shared-volume-attacks)
   - 3.6 [Auth Handoff Security](#36-auth-handoff-security)
   - 3.7 [Memory Poisoning](#37-memory-poisoning)
   - 3.8 [Supply Chain](#38-supply-chain)
4. [Risk Matrix](#4-risk-matrix)
5. [Mitigation Recommendations](#5-mitigation-recommendations)
6. [Penetration Testing Plan](#6-penetration-testing-plan)
7. [References](#7-references)

---

## 1. System Overview

Cortex Plane is a Kubernetes-native AI agent orchestration platform. The control plane manages agent lifecycle, task scheduling, approval workflows, and memory retrieval. Agents run as isolated pods with browser automation sidecars.

**Key components:**

| Component          | Role                                                            | Trust Level                                           |
| ------------------ | --------------------------------------------------------------- | ----------------------------------------------------- |
| Control Plane      | Orchestrates agent lifecycle, routes tasks, serves approval API | High — manages secrets, DB access, K8s API            |
| Agent Pod          | Executes AI tasks (Claude Code) in isolated container           | Low — untrusted workload, may execute arbitrary code  |
| Playwright Sidecar | Browser automation for agents                                   | Low — processes untrusted web content                 |
| Qdrant             | Vector memory store                                             | Medium — stores agent memories, reachable from agents |
| PostgreSQL         | Persistent state (jobs, approvals, agents)                      | High — stores all platform state                      |
| Channel Adapters   | Telegram, webhook ingress                                       | Low — processes untrusted external input              |

**Data flows:**

```
External Users → Channel Adapters → Control Plane → Agent Pods
                                         ↕               ↕
                                    PostgreSQL         Qdrant
```

---

## 2. Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│ Kubernetes Cluster                                          │
│                                                             │
│  ┌──────────────────────────────┐                           │
│  │ Control Plane Namespace       │                          │
│  │  ┌────────────┐ ┌──────────┐ │                          │
│  │  │ Control    │ │ Postgres │ │                          │
│  │  │ Plane Pod  │ │          │ │                          │
│  │  └─────┬──────┘ └──────────┘ │                          │
│  └────────┼─────────────────────┘                           │
│           │                                                 │
│  ─ ─ ─ ─ ┼ ─ ─ ─ ─  TRUST BOUNDARY 1  ─ ─ ─ ─ ─ ─ ─ ─   │
│           │                                                 │
│  ┌────────┼─────────────────────┐  ┌──────────────────┐    │
│  │ Agent  ↓ Namespace            │  │ Qdrant Namespace │    │
│  │  ┌────────────┬────────────┐ │  │  ┌────────────┐  │    │
│  │  │ Agent Core │ Playwright │ │  │  │  Qdrant    │  │    │
│  │  │ Container  │ Sidecar    │ │  │  │  Vector DB │  │    │
│  │  └────────────┴────────────┘ │  │  └────────────┘  │    │
│  └──────────────────────────────┘  └──────────────────┘    │
│                                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─  TRUST BOUNDARY 2  ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                          │
              External Network (Internet)
```

**TB1 — Control Plane ↔ Agent:** The control plane is trusted; agents are not. All data crossing this boundary must be validated. Agents may execute arbitrary code and attempt to escape their sandbox.

**TB2 — Cluster ↔ Internet:** All external traffic is untrusted. Agent egress is restricted to HTTPS-only with RFC1918 ranges blocked.

---

## 3. STRIDE Threat Analysis

### 3.1 Prompt Injection

#### 3.1.1 Browser Automation Injection

| STRIDE Category      | Tampering, Elevation of Privilege                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | A malicious website embeds hidden prompt-injection payloads (invisible text, CSS-hidden divs, image alt-text) that are scraped by Playwright and passed to the LLM as context.                                                                                                    |
| **Current Controls** | Playwright sidecar runs with `readOnlyRootFilesystem`, `drop: ALL` capabilities, and seccomp `RuntimeDefault` (`deploy/k8s/agent/base/pod-template.yaml:123-128`). Network egress restricted to port 443 with RFC1918 blocked (`deploy/k8s/agent/base/networkpolicy.yaml:43-53`). |
| **Gaps**             | No content sanitization between Playwright output and LLM input. The agent core and Playwright sidecar share the same pod network namespace — no intra-pod isolation. No allowlist for browseable domains.                                                                        |
| **Impact**           | High — attacker can influence agent behavior, exfiltrate data via crafted URLs, or trigger unauthorized tool calls.                                                                                                                                                               |

#### 3.1.2 Channel Input Injection

| STRIDE Category      | Tampering, Spoofing                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Attacker sends crafted messages via Telegram or webhook channels containing prompt injection payloads (e.g., "Ignore previous instructions and...").                                                                                                       |
| **Current Controls** | Channel messages flow through `ChannelRouter.route()` (`packages/shared/src/channels/router.ts:76-92`). Auto-provisioning creates users without rate limiting.                                                                                             |
| **Gaps**             | No input sanitization or content filtering on `InboundMessage`. The `metadata` field is typed as `Record<string, unknown>` with no schema validation (`packages/shared/src/channels/types.ts:23`). No rate limiting on user creation or message ingestion. |
| **Impact**           | High — attacker can hijack agent behavior, trigger unauthorized actions, or cause denial-of-service through mass user provisioning.                                                                                                                        |

#### 3.1.3 Memory Recall Injection

| STRIDE Category      | Tampering, Elevation of Privilege                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Attack Vector**    | An attacker poisons memory records (see §3.7) which are later recalled and injected into the LLM prompt. The recalled memory contains instruction-override payloads.                                                           |
| **Current Controls** | Memory is injected via `buildPrompt()` (`packages/control-plane/src/backends/claude-code.ts:200-225`), which concatenates system prompt, memories, and conversation history.                                                   |
| **Gaps**             | No sanitization of memory content before prompt assembly. Memories are concatenated as raw text with no structural separation (e.g., XML tags, role boundaries) that would let the model distinguish memory from instructions. |
| **Impact**           | Critical — persistent prompt injection that survives across sessions. Once memory is poisoned, every subsequent invocation is compromised until the memory is manually purged.                                                 |

---

### 3.2 Agent Isolation

#### 3.2.1 Container Escape

| STRIDE Category      | Elevation of Privilege                                                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Agent code attempts to escape the container runtime via kernel exploits, procfs manipulation, or capability abuse.                                                                                                                                                                                                                     |
| **Current Controls** | Strong baseline: `runAsNonRoot: true`, `runAsUser: 1000`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities: { drop: ["ALL"] }`, `seccompProfile: RuntimeDefault` (`packages/control-plane/src/k8s/agent-deployer.ts:39-43, 116-121`). `automountServiceAccountToken: false` (`agent-deployer.ts:114`). |
| **Gaps**             | No AppArmor or SELinux profiles applied beyond seccomp RuntimeDefault. No gVisor/Kata runtime for hard isolation. The pod spec in TypeScript omits `sizeLimit` on the `tmp` emptyDir volume (`agent-deployer.ts:73`), though the YAML template sets 100Mi (`pod-template.yaml:143`).                                                   |
| **Impact**           | Critical — full cluster compromise if escape succeeds.                                                                                                                                                                                                                                                                                 |

#### 3.2.2 RBAC Over-Privilege

| STRIDE Category      | Elevation of Privilege                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Agent exploits its Kubernetes RBAC permissions to read secrets from other agents or escalate within the cluster.                                                                                                                        |
| **Current Controls** | Per-agent ServiceAccount with `automountServiceAccountToken: false`. Role scoped to only `configmaps` (get, watch) and `secrets` (get) for the agent's own named resources (`agent-deployer.ts:161-184`).                               |
| **Gaps**             | `automountServiceAccountToken: false` prevents the default token mount, but if the token is otherwise obtained (e.g., via a volume mount misconfiguration), the RBAC permissions are narrow. This is well-designed; the gap is minimal. |
| **Impact**           | Medium — lateral movement within the namespace if RBAC is ever widened.                                                                                                                                                                 |

#### 3.2.3 Resource Exhaustion

| STRIDE Category      | Denial of Service                                                                                                                                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Agent pod consumes excessive CPU, memory, or disk to starve other workloads.                                                                                                                                                                                                                                   |
| **Current Controls** | Resource limits defined in pod-template.yaml. `dshm` volume has 256Mi sizeLimit, `tmp-playwright` has 500Mi.                                                                                                                                                                                                   |
| **Gaps**             | The TypeScript deployer does not set `sizeLimit` on the agent `tmp` emptyDir (`agent-deployer.ts:73`). The YAML template has this (`pod-template.yaml:143`), creating a discrepancy — deployments via the programmatic path lack this protection. The shared PVC (`pvc.yaml`) is 20Gi with no per-agent quota. |
| **Impact**           | Medium — can degrade performance for co-located workloads.                                                                                                                                                                                                                                                     |

---

### 3.3 Secret Management

#### 3.3.1 Environment Variable Leakage

| STRIDE Category      | Information Disclosure                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Control plane secrets (DATABASE_URL, API keys) leak to agent processes via `process.env` spreading.                                                                                                                                                            |
| **Current Controls** | None — `spawn()` in `claude-code.ts:134` passes `{ ...process.env, ...task.context.environment }`, inheriting ALL control plane environment variables.                                                                                                         |
| **Gaps**             | **Critical gap.** The control plane's `DATABASE_URL`, `ANTHROPIC_API_KEY`, `QDRANT_API_KEY`, and any other secrets in its environment are directly accessible to every spawned Claude Code process. This is the highest-priority finding in this threat model. |
| **Impact**           | Critical — full credential exposure. An agent (or prompt-injected agent) can read `process.env` and exfiltrate every secret the control plane possesses.                                                                                                       |

#### 3.3.2 Prompt Visible in procfs

| STRIDE Category      | Information Disclosure                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Attack Vector**    | The task prompt (potentially containing sensitive context) is passed as a CLI argument to `claude` and is visible in `/proc/*/cmdline` to any process with the same UID. |
| **Current Controls** | `readOnlyRootFilesystem` prevents writing to most paths. Processes run as UID 1000.                                                                                      |
| **Gaps**             | Any process running as UID 1000 in the same pod (including the Playwright sidecar) can read `/proc/*/cmdline` of the agent process (`claude-code.ts:132`).               |
| **Impact**           | Low — limited to intra-pod information disclosure.                                                                                                                       |

#### 3.3.3 Agent Config Env Passthrough

| STRIDE Category      | Information Disclosure                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Secrets are passed to agent pods via plain `config.env` entries without segregation into Kubernetes Secrets.                                                                                              |
| **Current Controls** | `config.env` entries are mapped as `V1EnvVar` objects (`agent-deployer.ts:25-28`). The env field is typed as `Record<string, string>` with no allowlist or secret segregation (`types.ts:15`).            |
| **Gaps**             | No distinction between configuration and secrets. All values are plaintext env vars rather than `secretKeyRef` references. No allowlist filtering — any key/value pair in `config.env` is passed through. |
| **Impact**           | Medium — secrets are visible in pod spec, etcd (if not encrypted at rest), and `kubectl describe pod`.                                                                                                    |

---

### 3.4 Network Policies

#### 3.4.1 Agent-to-Agent Communication

| STRIDE Category      | Spoofing, Information Disclosure                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | A compromised agent attempts to communicate with other agent pods to exfiltrate data or pivot laterally.                                                                                                         |
| **Current Controls** | NetworkPolicy restricts agent ingress to control-plane pods only. Egress is limited to DNS (kube-system), control-plane pods, Qdrant pods, and external HTTPS with RFC1918 blocked (`networkpolicy.yaml:10-53`). |
| **Gaps**             | NetworkPolicy enforcement depends on the CNI plugin — if Cilium/Calico is not installed, the policies are silently ignored. No verification mechanism to confirm policies are active.                            |
| **Impact**           | High if CNI is misconfigured — full lateral movement between agent pods. Low if CNI is properly configured.                                                                                                      |

#### 3.4.2 Qdrant Direct Access from Agents

| STRIDE Category      | Tampering, Information Disclosure                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Agent pods have direct network access to Qdrant and can read/write any collection, including memories belonging to other agents.                                                                               |
| **Current Controls** | Egress to Qdrant pods is allowed by network policy (`networkpolicy.yaml:38-42`). Qdrant runs without authentication or TLS (`qdrant/configmap.yaml:25`, `control-plane/configmap.yaml:16`).                    |
| **Gaps**             | **No authentication on Qdrant.** No TLS for data in transit. No collection-level access control — any agent can read or mutate any other agent's memories. This is a direct path for memory poisoning attacks. |
| **Impact**           | High — cross-agent data access, memory poisoning, information exfiltration.                                                                                                                                    |

#### 3.4.3 DNS Exfiltration

| STRIDE Category      | Information Disclosure                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Agent encodes sensitive data in DNS queries (e.g., `secret-data.attacker.com`) which are forwarded by the cluster DNS resolver to the internet.                                  |
| **Current Controls** | DNS egress is allowed to kube-system pods (`networkpolicy.yaml:22-32`).                                                                                                          |
| **Gaps**             | No DNS query filtering or logging. Standard CoreDNS will resolve any external domain, enabling DNS tunneling and data exfiltration that bypasses HTTPS-only egress restrictions. |
| **Impact**           | Medium — low-bandwidth data exfiltration channel that bypasses network policy intent.                                                                                            |

---

### 3.5 Shared Volume Attacks

#### 3.5.1 SubPath Directory Traversal

| STRIDE Category      | Tampering, Elevation of Privilege                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Agent name containing path traversal characters (e.g., `../other-agent`) is used as the `subPath` for the shared PVC, allowing access to another agent's workspace.                                                                                 |
| **Current Controls** | SubPath is set per-agent in `agent-deployer.ts:60`: `subPath: config.name`. Agent names come from the database via task dispatch.                                                                                                                   |
| **Gaps**             | No validation that `config.name` is path-safe. Characters like `..`, `/`, or null bytes could enable traversal. Kubernetes does validate subPath to some extent (rejecting `..`), but relying solely on K8s validation is defense-in-depth failure. |
| **Impact**           | High — cross-agent data access, code injection into another agent's workspace.                                                                                                                                                                      |

#### 3.5.2 Shared PVC Exhaustion

| STRIDE Category      | Denial of Service                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | A single agent fills the shared 20Gi PVC, denying workspace storage to all other agents.                                                                                              |
| **Current Controls** | PVC is `ReadWriteOnce` with `local-path` storage class (`pvc.yaml:11-16`). No per-agent quotas.                                                                                       |
| **Gaps**             | No per-subpath quota enforcement. `ReadWriteOnce` means all agents must be on the same node (or PVC access fails), limiting scalability. No monitoring or alerts for PVC utilization. |
| **Impact**           | Medium — denial of service to co-located agents.                                                                                                                                      |

#### 3.5.3 Symlink Escape

| STRIDE Category      | Elevation of Privilege                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Agent creates a symlink within its subPath that points outside the workspace directory, potentially accessing host filesystem paths.                                                                                    |
| **Current Controls** | `readOnlyRootFilesystem: true` prevents writing outside mounted volumes. SubPath mounts bind-mount only the specified subdirectory.                                                                                     |
| **Gaps**             | Symlink creation within the writable workspace is possible. Kubernetes VolumeSubPath does not follow symlinks by default (mitigated by `VolumeSubPath` feature), but this depends on kubelet version and configuration. |
| **Impact**           | Medium — potential host filesystem access if symlink protections are bypassed.                                                                                                                                          |

---

### 3.6 Auth Handoff Security

#### 3.6.1 Unauthenticated Approval Routes

| STRIDE Category      | Spoofing, Elevation of Privilege                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Attacker directly calls approval API endpoints to create, list, decide, or stream approval requests without authentication.                                                                                                                                                                     |
| **Current Controls** | Schema validation (UUID format checks) on request bodies (`routes/approval.ts:85, 92, 96`). Token-based approval uses SHA-256 hashed tokens with 256-bit entropy (`approval/token.ts:18, 31-37`). Atomic single-use enforcement via `WHERE status = 'PENDING'` (`approval/service.ts:176-188`). |
| **Gaps**             | **No authentication middleware on any approval route** (`routes/approval.ts:78, 149, 222, 276, 314, 342`). `GET /approvals` returns all approval requests to any caller. `GET /approvals/stream` (SSE) has no auth. The `decidedBy` field is self-reported (`routes/approval.ts:177`).          |
| **Impact**           | High — any network-reachable caller can list all pending approvals, view their details, and (if they know the request ID) make decisions. The token-based path is secure, but the ID-based path has no authentication.                                                                          |

#### 3.6.2 Token Exposure in Transit

| STRIDE Category      | Information Disclosure                                                                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Approval token is intercepted during transmission (HTTP response or Telegram message) and replayed to approve/deny requests.                                                                                                                    |
| **Current Controls** | Token is returned once in the `POST /jobs/:jobId/approval` response (`routes/approval.ts:136`). Hash-only storage (`approval/service.ts:80-81`). Single-use enforcement.                                                                        |
| **Gaps**             | Token transmitted in plaintext HTTP response (TLS depends on ingress configuration). Token sent via Telegram inline keyboard callbacks — Telegram's E2E encryption does not cover bot API traffic. No token expiration beyond the approval TTL. |
| **Impact**           | Medium — token replay is single-use, but interception before use enables unauthorized approval decisions.                                                                                                                                       |

#### 3.6.3 Session Hijacking via Cookie Injection

| STRIDE Category      | Spoofing, Elevation of Privilege                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | If browser authentication handoff involves injecting session cookies into the Playwright sidecar, those cookies could be exfiltrated by a compromised agent or malicious page JavaScript.                                         |
| **Current Controls** | The approval flow currently uses token-based auth, not cookie-based browser sessions. Playwright sidecar is network-isolated.                                                                                                     |
| **Gaps**             | No cookie injection mechanism exists yet, but it is referenced in the spec (§8.7). When implemented, cookies stored in the shared filesystem or passed via environment variables would be accessible to the agent core container. |
| **Impact**           | High (when implemented) — session hijacking of user accounts on third-party services.                                                                                                                                             |

---

### 3.7 Memory Poisoning

#### 3.7.1 Direct Qdrant Manipulation

| STRIDE Category      | Tampering                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | A compromised agent writes malicious memory records to Qdrant (its own or other agents' collections) containing prompt injection payloads that will be recalled in future sessions.                                                                              |
| **Current Controls** | Memory upsert (`packages/shared/src/memory/client.ts:65-82`) writes directly to Qdrant with `wait: true`. Memory sync (`packages/shared/src/memory/sync/sync.ts:56-98`) reads files from workspace and upserts without content filtering.                        |
| **Gaps**             | **No authentication on Qdrant** — any pod with network access can write to any collection. No content validation or sanitization on memory records before upsert. No integrity verification on recalled memories. No provenance tracking (who wrote the memory). |
| **Impact**           | Critical — persistent cross-session prompt injection. Poisoned memories are recalled into every future prompt, enabling persistent agent compromise.                                                                                                             |

#### 3.7.2 File-Based Memory Injection

| STRIDE Category      | Tampering                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Attacker writes crafted files to the agent workspace that are picked up by the memory sync watcher and imported into Qdrant.                                                                                                     |
| **Current Controls** | Chokidar watcher ignores certain patterns (`sync/watcher.ts:68-81`). 3-second origin detection window (`sync/watcher.ts:128-130`). Chunk size bounded to 32-4096 chars (`sync/chunker.ts:5-6`).                                  |
| **Gaps**             | No content validation on synced file contents. The ignore list covers tooling artifacts but not malicious content. The 3-second agent-origin window is a heuristic and can be bypassed by timing file writes outside the window. |
| **Impact**           | High — file-based injection persists in vector store.                                                                                                                                                                            |

#### 3.7.3 Memory Recall Manipulation

| STRIDE Category      | Information Disclosure, Tampering                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Agent crafts prompts designed to trigger recall of specific memory categories (facts, preferences, events) to exfiltrate information from other sessions or manipulate scoring.                                                                           |
| **Current Controls** | Memory scoring uses similarity (0.5), recency (0.3), utility (0.2) weights (`scoring.ts:12-16`). Half-life decay: facts 365d, preferences 180d, events 14d (`scoring.ts:5-9`).                                                                            |
| **Gaps**             | No access control on memory recall — an agent can search all collections it can reach. Scoring is deterministic and gameable if an attacker understands the weights. Access count updates are fire-and-forget with race conditions (`client.ts:140-158`). |
| **Impact**           | Medium — information disclosure across sessions.                                                                                                                                                                                                          |

---

### 3.8 Supply Chain

#### 3.8.1 Container Image Provenance

| STRIDE Category      | Tampering                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Attacker compromises or substitutes a container image used by the platform (control plane, agent, Qdrant, Playwright).                                                                                               |
| **Current Controls** | Images referenced by tag in YAML manifests (e.g., `qdrant/deployment.yaml`).                                                                                                                                         |
| **Gaps**             | No image digest pinning — images referenced by mutable tags. No image signing or verification (Cosign/Notary). No admission controller enforcing image policies. No SBOM generation or vulnerability scanning in CI. |
| **Impact**           | Critical — full platform compromise via supply chain attack.                                                                                                                                                         |

#### 3.8.2 Dependency Auditing

| STRIDE Category      | Tampering                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | Malicious npm package is introduced as a dependency (direct or transitive) via typosquatting, maintainer compromise, or dependency confusion.                              |
| **Current Controls** | Standard npm/pnpm lockfile.                                                                                                                                                |
| **Gaps**             | No automated dependency vulnerability scanning in CI. No lockfile integrity verification. No private registry or package provenance checks. No `npm audit` in CI pipeline. |
| **Impact**           | High — arbitrary code execution in control plane or agent containers at build or runtime.                                                                                  |

#### 3.8.3 Init Container Integrity

| STRIDE Category      | Tampering                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attack Vector**    | The `hydrate` init container downloads identity/skill files from the control plane via `wget`. A MITM or compromised control plane could serve malicious payloads. |
| **Current Controls** | Init container runs with full security lockdown (`pod-template.yaml:51-56`). Download uses internal cluster DNS (`wget http://control-plane:3000/...`).            |
| **Gaps**             | Download over plaintext HTTP within the cluster (`pod-template.yaml:37-43`). `                                                                                     |     | true` means download failures are silently ignored — an attacker who blocks the download causes agents to boot without identity files (degraded mode). No checksum verification on downloaded files. |
| **Impact**           | Medium — identity spoofing or skill injection via compromised control plane or network MITM.                                                                       |

---

## 4. Risk Matrix

### Scoring Criteria

**Likelihood:**

| Score | Label          | Criteria                                                       |
| ----- | -------------- | -------------------------------------------------------------- |
| 1     | Rare           | Requires nation-state capability or multiple chained zero-days |
| 2     | Unlikely       | Requires internal access + specialized knowledge               |
| 3     | Possible       | Achievable by motivated attacker with moderate skill           |
| 4     | Likely         | Low barrier, exploitable with publicly available tools         |
| 5     | Almost Certain | Trivially exploitable, no special access required              |

**Impact:**

| Score | Label      | Criteria                                            |
| ----- | ---------- | --------------------------------------------------- |
| 1     | Negligible | Minor information disclosure, no operational impact |
| 2     | Minor      | Limited data exposure, single-agent impact          |
| 3     | Moderate   | Cross-agent impact, operational degradation         |
| 4     | Major      | Platform-wide compromise, secret exfiltration       |
| 5     | Critical   | Full cluster compromise, persistent backdoor        |

### Risk Scores

| ID      | Threat                                  | STRIDE                   | L   | I   | Risk (L×I) | Rating       |
| ------- | --------------------------------------- | ------------------------ | --- | --- | ---------- | ------------ |
| T-3.3.1 | Env var leakage (`process.env` spread)  | Info Disclosure          | 5   | 5   | **25**     | **CRITICAL** |
| T-3.7.1 | Direct Qdrant manipulation (no auth)    | Tampering                | 4   | 5   | **20**     | **CRITICAL** |
| T-3.1.3 | Memory recall injection (persistent)    | Tampering/EoP            | 4   | 5   | **20**     | **CRITICAL** |
| T-3.8.1 | Container image provenance (no signing) | Tampering                | 3   | 5   | **15**     | **HIGH**     |
| T-3.6.1 | Unauthenticated approval routes         | Spoofing/EoP             | 4   | 4   | **16**     | **HIGH**     |
| T-3.1.2 | Channel input injection                 | Tampering                | 4   | 4   | **16**     | **HIGH**     |
| T-3.5.1 | SubPath directory traversal             | Tampering/EoP            | 3   | 4   | **12**     | **HIGH**     |
| T-3.1.1 | Browser automation injection            | Tampering/EoP            | 3   | 4   | **12**     | **HIGH**     |
| T-3.4.2 | Qdrant direct access (no TLS/auth)      | Info Disclosure          | 4   | 3   | **12**     | **HIGH**     |
| T-3.8.2 | Dependency auditing gaps                | Tampering                | 3   | 4   | **12**     | **HIGH**     |
| T-3.4.1 | Agent-to-agent (CNI not verified)       | Spoofing/Info Disclosure | 3   | 4   | **12**     | **HIGH**     |
| T-3.3.3 | Agent config env passthrough            | Info Disclosure          | 4   | 3   | **12**     | **HIGH**     |
| T-3.7.2 | File-based memory injection             | Tampering                | 3   | 4   | **12**     | **HIGH**     |
| T-3.6.3 | Cookie injection (future)               | Spoofing/EoP             | 2   | 4   | **8**      | **MEDIUM**   |
| T-3.2.1 | Container escape                        | EoP                      | 1   | 5   | **5**      | **MEDIUM**   |
| T-3.6.2 | Token exposure in transit               | Info Disclosure          | 3   | 2   | **6**      | **MEDIUM**   |
| T-3.4.3 | DNS exfiltration                        | Info Disclosure          | 3   | 2   | **6**      | **MEDIUM**   |
| T-3.5.2 | Shared PVC exhaustion                   | DoS                      | 3   | 2   | **6**      | **MEDIUM**   |
| T-3.5.3 | Symlink escape                          | EoP                      | 2   | 3   | **6**      | **MEDIUM**   |
| T-3.7.3 | Memory recall manipulation              | Info Disclosure          | 3   | 2   | **6**      | **MEDIUM**   |
| T-3.2.3 | Resource exhaustion (tmp no sizeLimit)  | DoS                      | 3   | 2   | **6**      | **MEDIUM**   |
| T-3.3.2 | Prompt visible in procfs                | Info Disclosure          | 2   | 1   | **2**      | **LOW**      |
| T-3.2.2 | RBAC over-privilege                     | EoP                      | 1   | 3   | **3**      | **LOW**      |
| T-3.8.3 | Init container integrity                | Tampering                | 2   | 2   | **4**      | **LOW**      |

### Risk Heat Map

```
              Impact →
            1    2    3    4    5
         ┌────┬────┬────┬────┬────┐
      5  │    │    │    │    │3.3.│
  L      │    │    │    │    │ 1  │
  i   4  │    │    │3.4.│3.6.│3.7.│
  k      │    │    │ 2  │1,  │ 1  │
  e   3  │    │4.3,│    │1.1,│8.1 │
  l      │    │5.2,│    │5.1,│    │
  i      │    │7.3 │    │8.2 │    │
  h   2  │    │    │5.3 │6.3 │    │
  o      │    │    │    │    │    │
  o   1  │    │    │2.2 │    │2.1 │
  d      │    │    │    │    │    │
         └────┴────┴────┴────┴────┘
```

---

## 5. Mitigation Recommendations

### Priority 1 — Critical (address immediately)

#### M1: Eliminate `process.env` spreading to agent processes

- **Threat:** T-3.3.1
- **Action:** Replace `{ ...process.env, ...task.context.environment }` with an explicit allowlist of environment variables safe for agent consumption. Use Kubernetes Secrets with `secretKeyRef` for agent-specific credentials.
- **Code ref:** `packages/control-plane/src/backends/claude-code.ts:134`
- **Ticket:** Create implementation ticket for env var allowlisting

#### M2: Enable Qdrant authentication and per-agent collection isolation

- **Threat:** T-3.7.1, T-3.4.2
- **Action:** Enable Qdrant API key authentication. Implement per-agent collection naming with control-plane-mediated access (agents should not connect to Qdrant directly — route through control plane API). Enable TLS for Qdrant connections.
- **Code ref:** `packages/shared/src/memory/client.ts:19-23`, `deploy/k8s/qdrant/configmap.yaml:25`
- **Ticket:** Create implementation ticket for Qdrant auth + collection isolation

#### M3: Sanitize memory content before prompt injection

- **Threat:** T-3.1.3
- **Action:** Wrap recalled memories in structured delimiters (XML tags with role annotations) in `buildPrompt()`. Implement content validation and anomaly detection on memory records. Add provenance metadata (author, timestamp, trust level) to all memory records.
- **Code ref:** `packages/control-plane/src/backends/claude-code.ts:200-225`
- **Ticket:** Create implementation ticket for memory sanitization

### Priority 2 — High (address within current sprint)

#### M4: Add authentication middleware to approval routes

- **Threat:** T-3.6.1
- **Action:** Add authentication middleware to all approval API routes. Replace self-reported `decidedBy` with server-derived identity from the auth token. Restrict `GET /approvals` and SSE stream to authenticated users.
- **Code ref:** `packages/control-plane/src/routes/approval.ts:78, 149, 222, 276, 314, 342`
- **Ticket:** Create implementation ticket for approval route auth

#### M5: Validate agent names for path safety

- **Threat:** T-3.5.1
- **Action:** Add input validation for agent names: allowlist `[a-z0-9][a-z0-9-]*[a-z0-9]` (DNS label format). Reject names containing `..`, `/`, `\`, null bytes, or any non-alphanumeric characters except hyphens.
- **Code ref:** `packages/control-plane/src/k8s/agent-deployer.ts:60`
- **Ticket:** Create implementation ticket for agent name validation

#### M6: Add channel input rate limiting and validation

- **Threat:** T-3.1.2
- **Action:** Implement rate limiting on `ChannelRouter.route()` per `channelUserId`. Add schema validation for `InboundMessage.metadata`. Cap user auto-provisioning rate.
- **Code ref:** `packages/shared/src/channels/router.ts:76-92`, `packages/shared/src/channels/types.ts:23`
- **Ticket:** Create implementation ticket for channel input hardening

#### M7: Container image signing and digest pinning

- **Threat:** T-3.8.1
- **Action:** Pin all container images by digest (not tag). Implement Cosign signing in CI. Deploy an admission controller (Kyverno/OPA Gatekeeper) to enforce signed images. Generate SBOMs for all images.
- **Ticket:** Create implementation ticket for supply chain security

#### M8: Verify CNI NetworkPolicy enforcement

- **Threat:** T-3.4.1
- **Action:** Deploy Cilium or Calico as the CNI. Add a CI/CD check or admission webhook that verifies NetworkPolicy enforcement is active. Document CNI requirements in deployment guide.
- **Code ref:** `deploy/k8s/agent/base/networkpolicy.yaml`
- **Ticket:** Create implementation ticket for CNI verification

#### M9: Add `npm audit` and dependency scanning to CI

- **Threat:** T-3.8.2
- **Action:** Add `pnpm audit` to CI pipeline. Integrate Snyk, Trivy, or GitHub Dependabot for automated vulnerability scanning. Pin transitive dependencies. Consider a private registry.
- **Ticket:** Create implementation ticket for dependency auditing

#### M10: Use `secretKeyRef` for agent secrets

- **Threat:** T-3.3.3
- **Action:** Segregate configuration from secrets in the agent env type. Use `secretKeyRef` in pod spec for sensitive values. Add allowlist to `config.env` field.
- **Code ref:** `packages/control-plane/src/k8s/agent-deployer.ts:25-28`, `packages/control-plane/src/k8s/types.ts:15`
- **Ticket:** Create implementation ticket for agent secret management

### Priority 3 — Medium (address within next 2 sprints)

#### M11: Align TypeScript deployer with YAML template security settings

- **Threat:** T-3.2.3
- **Action:** Add `sizeLimit: "100Mi"` to the `tmp` emptyDir volume in `buildPod()`. Ensure all security-relevant settings in the YAML template are mirrored in the programmatic deployer.
- **Code ref:** `packages/control-plane/src/k8s/agent-deployer.ts:73`

#### M12: Add DNS query filtering

- **Threat:** T-3.4.3
- **Action:** Deploy CoreDNS with response policy zone (RPZ) or external DNS filtering to detect and block DNS tunneling. Log all agent DNS queries for monitoring.

#### M13: Implement browser domain allowlisting

- **Threat:** T-3.1.1
- **Action:** Add a configurable domain allowlist for Playwright navigation. Block navigation to internal cluster DNS names. Strip hidden content from scraped pages before passing to LLM.

#### M14: Design cookie isolation for auth handoff

- **Threat:** T-3.6.3
- **Action:** When implementing browser auth handoff (§8.7), use short-lived, scoped session tokens injected via a sidecar (not shared filesystem or env vars). Implement cookie jar isolation between agent core and browser processes.

#### M15: Add seccomp profile to Qdrant

- **Threat:** T-3.2.1
- **Action:** Add `seccompProfile: { type: "RuntimeDefault" }` to Qdrant pod security context to match control plane and agent pods.
- **Code ref:** `deploy/k8s/qdrant/deployment.yaml:29-32`

#### M16: Memory content validation

- **Threat:** T-3.7.2
- **Action:** Add content validation rules to memory sync: max record size, character encoding validation, structural pattern detection for known injection patterns. Add provenance tracking to all memory records.
- **Code ref:** `packages/shared/src/memory/sync/sync.ts:56-98`

---

## 6. Penetration Testing Plan

### 6.1 Scope and Objectives

**Objective:** Validate the effectiveness of existing security controls and identify exploitable vulnerabilities in the Cortex Plane platform.

**Scope:**

- Control plane API (approval routes, SSE, agent management)
- Agent pod isolation (container escape, RBAC, network policy)
- Memory subsystem (Qdrant access, memory poisoning)
- Channel input handling (Telegram adapter, webhook)
- Shared volume isolation (subPath traversal, symlink)

**Out of scope:**

- Third-party SaaS services (Anthropic API, Telegram API)
- Underlying cloud provider infrastructure
- Physical security

### 6.2 Test Cases

#### Phase 1 — External Attack Surface (Black Box)

| ID    | Test                                | Target                            | Method                                             | Expected Outcome                                 |
| ----- | ----------------------------------- | --------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| PT-01 | Unauthenticated approval API access | `/approvals`, `/approvals/stream` | Curl endpoints without credentials                 | Document: are all approval data accessible?      |
| PT-02 | Approval decision without auth      | `/approval/:id/decide`            | Submit decision with forged `decidedBy`            | Verify: can arbitrary caller approve requests?   |
| PT-03 | Channel input injection             | Telegram adapter                  | Send messages with prompt injection payloads       | Verify: does agent behavior change?              |
| PT-04 | Rate limit bypass                   | Channel router                    | Rapid message submission from multiple channel IDs | Verify: can mass user provisioning be triggered? |
| PT-05 | Token brute force                   | `/approval/token/decide`          | Submit random token values at high rate            | Verify: is rate limiting enforced?               |

#### Phase 2 — Agent Sandbox Escape (Gray Box)

| ID    | Test                      | Target             | Method                                                             | Expected Outcome                             |
| ----- | ------------------------- | ------------------ | ------------------------------------------------------------------ | -------------------------------------------- |
| PT-06 | Process env enumeration   | Agent container    | `env` / `cat /proc/1/environ` from within agent                    | Verify: are control plane secrets visible?   |
| PT-07 | Network policy validation | Agent pod          | Attempt connections to other agent pods, postgres, kube-api        | Verify: are connections blocked?             |
| PT-08 | Qdrant cross-agent access | Agent pod → Qdrant | Query other agents' collections directly                           | Verify: can agent A read agent B's memories? |
| PT-09 | SubPath traversal         | Agent pod          | Attempt file access at `../../other-agent/` relative to workspace  | Verify: is traversal blocked?                |
| PT-10 | Symlink escape            | Agent pod          | Create symlinks pointing to `/etc/`, `/proc/`, `/var/run/secrets/` | Verify: are symlinks restricted?             |
| PT-11 | Capability verification   | Agent pod          | Attempt privileged operations (mount, chroot, setuid)              | Verify: are all capabilities dropped?        |
| PT-12 | procfs information leak   | Agent pod          | Read `/proc/*/cmdline` for other processes in pod                  | Document: what information is exposed?       |
| PT-13 | emptyDir exhaustion       | Agent pod          | Write large files to `/tmp`                                        | Verify: is sizeLimit enforced?               |

#### Phase 3 — Memory Poisoning (Gray Box)

| ID    | Test                                   | Target      | Method                                                               | Expected Outcome                                   |
| ----- | -------------------------------------- | ----------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| PT-14 | Direct Qdrant write                    | Qdrant API  | Upsert malicious memory records via HTTP                             | Verify: is authentication required?                |
| PT-15 | Cross-agent memory read                | Qdrant API  | Query collections belonging to other agents                          | Verify: is collection isolation enforced?          |
| PT-16 | Persistent prompt injection via memory | Memory sync | Write crafted files to workspace, trigger sync, observe next session | Verify: does poisoned memory alter agent behavior? |
| PT-17 | Memory scoring manipulation            | Qdrant API  | Artificially inflate access counts and recency                       | Verify: can recall ranking be gamed?               |

#### Phase 4 — Supply Chain Validation

| ID    | Test                 | Target                 | Method                                           | Expected Outcome                                   |
| ----- | -------------------- | ---------------------- | ------------------------------------------------ | -------------------------------------------------- |
| PT-18 | Image tag mutability | Container registry     | Verify that deployed images are pinned by digest | Document: are tags or digests used?                |
| PT-19 | Dependency audit     | npm/pnpm packages      | Run `pnpm audit`, review lockfile integrity      | Document: known vulnerabilities in dependency tree |
| PT-20 | Init container MITM  | Hydrate init container | Intercept wget download within cluster network   | Verify: is download integrity verified?            |

### 6.3 Tools

| Tool                     | Purpose                                 |
| ------------------------ | --------------------------------------- |
| `curl` / `httpie`        | API endpoint testing                    |
| `kubectl exec`           | In-pod testing (phases 2-3)             |
| `nmap` / `netcat`        | Network policy validation               |
| `trivy`                  | Container image and dependency scanning |
| `cosign`                 | Image signature verification            |
| `nuclei`                 | Automated API security scanning         |
| `qdrant-client` (Python) | Direct Qdrant manipulation              |

### 6.4 Success Criteria

A penetration test is considered **passed** when:

- All CRITICAL-rated threats (T-3.3.1, T-3.7.1, T-3.1.3) have verified mitigations in place
- No agent pod can access control plane secrets
- No agent can read/write another agent's memory without authorization
- Network policies are confirmed enforced (not just declared)
- All approval API endpoints require authentication
- Container images are verifiably signed and pinned

### 6.5 Reporting

Each finding should include:

- **Severity:** CVSS 3.1 score
- **Proof of concept:** Reproducible steps
- **Remediation:** Specific code/config changes
- **Verification:** Steps to confirm the fix

---

## 7. References

| Reference                                                                                                    | Description                                         |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `packages/control-plane/src/k8s/agent-deployer.ts`                                                           | Pod construction, security contexts, RBAC           |
| `packages/control-plane/src/k8s/types.ts`                                                                    | Agent config type definitions                       |
| `packages/control-plane/src/backends/claude-code.ts`                                                         | Claude Code backend, env spreading, prompt building |
| `packages/control-plane/src/routes/approval.ts`                                                              | Approval REST API routes                            |
| `packages/control-plane/src/approval/service.ts`                                                             | Approval business logic, token handling             |
| `packages/control-plane/src/approval/token.ts`                                                               | Token generation and hashing                        |
| `packages/control-plane/src/lifecycle/manager.ts`                                                            | Agent lifecycle state machine                       |
| `packages/control-plane/src/lifecycle/hydration.ts`                                                          | Agent hydration from DB and Qdrant                  |
| `packages/shared/src/channels/router.ts`                                                                     | Channel message routing                             |
| `packages/shared/src/channels/types.ts`                                                                      | Channel message types                               |
| `packages/shared/src/memory/client.ts`                                                                       | Qdrant memory client                                |
| `packages/shared/src/memory/sync/sync.ts`                                                                    | File-to-memory sync                                 |
| `packages/shared/src/memory/sync/watcher.ts`                                                                 | File watcher for memory sync                        |
| `deploy/k8s/agent/base/networkpolicy.yaml`                                                                   | Agent network isolation                             |
| `deploy/k8s/agent/base/pod-template.yaml`                                                                    | Agent pod template                                  |
| `deploy/k8s/agent/base/rbac.yaml`                                                                            | Agent RBAC manifests                                |
| `deploy/k8s/agent/base/pvc.yaml`                                                                             | Shared workspace PVC                                |
| `deploy/k8s/control-plane/deployment.yaml`                                                                   | Control plane deployment                            |
| `deploy/k8s/qdrant/deployment.yaml`                                                                          | Qdrant deployment                                   |
| `deploy/k8s/qdrant/configmap.yaml`                                                                           | Qdrant configuration                                |
| [STRIDE Threat Model](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats) | Microsoft STRIDE methodology                        |
| [Kubernetes Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)    | K8s security baseline                               |
| [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/)              | LLM-specific security risks                         |
