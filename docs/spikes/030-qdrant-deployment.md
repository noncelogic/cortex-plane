# Spike #30 — Qdrant Deployment Topology & Resource Sizing

**Status:** Proposed
**Date:** 2026-02-23
**Author:** Cortex Plane Team
**Depends on:** [Spike #27 — Project Structure & Tooling](./027-project-structure.md), [Spike #29 — Qdrant Collection Schema & Decay Model](./029-qdrant-schema.md)

---

## Table of Contents

1. [Context](#context)
2. [Question 1: Single Node vs Replicated](#question-1-single-node-vs-replicated)
3. [Question 2: Persistence — PVC Size and Storage Class](#question-2-persistence--pvc-size-and-storage-class)
4. [Question 3: RAM Budget](#question-3-ram-budget)
5. [Question 4: CPU Allocation](#question-4-cpu-allocation)
6. [Question 5: Backup Strategy](#question-5-backup-strategy)
7. [Question 6: Network Topology](#question-6-network-topology)
8. [Question 7: TLS for Internal Traffic](#question-7-tls-for-internal-traffic)
9. [Question 8: Monitoring](#question-8-monitoring)
10. [Artifact: k3s Manifests](#artifact-k3s-manifests)
11. [Artifact: Resource Request/Limit Spec](#artifact-resource-requestlimit-spec)
12. [Artifact: Backup/Restore Runbook](#artifact-backuprestore-runbook)
13. [Artifact: Monitoring Configuration](#artifact-monitoring-configuration)
14. [Design Decisions](#design-decisions)
15. [Open Questions](#open-questions)

---

## Context

Spike #29 defined the Qdrant collection schema, memory types, decay model, and sizing projections. This spike answers the operational question: **how do we run Qdrant on k3s?**

The target environment is a homelab k3s cluster. The projected scale (spike #29) is:

| Metric                         | Projection                                 |
| ------------------------------ | ------------------------------------------ |
| Total vectors (1 year)         | ~100K across all agents                    |
| Collections                    | <20 (one per agent)                        |
| Vector dimensions              | 1536 (text-embedding-3-small)              |
| Quantization                   | Scalar int8 (enabled from day one)         |
| Per-vector storage (quantized) | ~2.1 KB (vector + payload + HNSW overhead) |
| Total data size (quantized)    | ~210 MB                                    |

This is a small deployment. Every decision in this spike optimizes for simplicity and operability on constrained hardware, not for enterprise scale. When a simple option exists, we take it.

### Hard Constraints

| Constraint                | Implication                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| k3s on ARM64 + x64        | `qdrant/qdrant` official images support both architectures.                |
| Homelab — limited RAM     | Total cluster memory is finite. Qdrant cannot consume unbounded RAM.       |
| Homelab — limited storage | No cloud-provisioned SSDs. Local NVMe or SSD via `local-path` provisioner. |
| Stateless control plane   | Control plane connects to Qdrant via REST/gRPC as an external service.     |
| `qdrant/qdrant:v1.13.2`   | Pinned version from spike #27's docker-compose.yml.                        |

---

## Question 1: Single Node vs Replicated

**Question:** Should Qdrant run as a single node or a replicated cluster?

**Decision:** Single node.

### Options Evaluated

| Criterion              | Single Node                                                   | Replicated (2–3 nodes)                             |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| Operational complexity | StatefulSet with 1 replica. Done.                             | Raft consensus, shard replication, peer discovery. |
| RAM cost               | 1×                                                            | 2–3× (each replica holds the full dataset)         |
| Availability           | Pod restart = brief downtime (~5–10s)                         | Survives single-node failure.                      |
| Data durability        | PVC survives pod restart. Node failure = restore from backup. | Replicated across nodes.                           |
| Homelab fit            | Excellent — minimal resources.                                | Poor — wastes scarce RAM on redundancy.            |
| Qdrant cluster mode    | Disabled. No P2P port needed.                                 | Required. Adds complexity.                         |

### Rationale

1. **The data is reconstructable.** Vector memories are derived from conversations stored in PostgreSQL. If Qdrant's volume is lost, we re-embed from the source data. This is slow but not catastrophic. The durability requirement is "don't lose data on routine pod restarts," not "survive disk failure with zero downtime."

2. **RAM is the scarcest resource.** A replicated setup doubles or triples the RAM budget for zero additional capacity — replicas hold identical data. In a homelab cluster where every gigabyte matters, this waste is unacceptable.

3. **The blast radius is contained.** If Qdrant goes down, agents lose memory retrieval. They can still function using session context (PostgreSQL). Memory is an enhancement, not a hard dependency. A 10-second pod restart is tolerable.

4. **Replication adds operational complexity.** Raft consensus, shard placement, split-brain scenarios, peer discovery via headless service — all of this is production infrastructure overhead that provides no value at homelab scale.

5. **Qdrant cluster mode can be enabled later.** Switching from single node to replicated requires changing `replicaCount` and enabling the P2P port. The StatefulSet manifest supports this evolution. We don't need to design for it now.

---

## Question 2: Persistence — PVC Size and Storage Class

**Question:** What PVC size and storage class should Qdrant use?

**Decision:** 10 GiB PVC on SSD-backed storage via the k3s `local-path` provisioner.

### Size Calculation

| Component                                         | Size at 100K vectors | Notes                                                           |
| ------------------------------------------------- | -------------------- | --------------------------------------------------------------- |
| Quantized vectors (int8)                          | ~150 MB              | 100K × 1536 bytes                                               |
| Original vectors (float32, on-disk for rescoring) | ~600 MB              | 100K × 6,144 bytes                                              |
| Payloads                                          | ~50 MB               | 100K × ~500 bytes avg                                           |
| HNSW index                                        | ~13 MB               | 100K × ~128 bytes (m=16)                                        |
| WAL segments                                      | ~32 MB               | Default WAL segment capacity                                    |
| Snapshots (1 latest)                              | ~850 MB              | Approximate full collection snapshot                            |
| **Subtotal**                                      | **~1.7 GB**          |                                                                 |
| **With 5× headroom**                              | **~8.5 GB**          | Room for growth, optimization scratch space, temporary segments |

**10 GiB** provides comfortable headroom beyond the 5× projection. Qdrant's optimizer creates temporary segments during merges that briefly double the segment storage — the headroom accounts for this.

### Storage Class

**Decision:** `local-path` (k3s default provisioner) on an SSD-backed node.

| Option                        | Fit                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `local-path` (SSD node)       | **Best.** Local NVMe/SSD provides the IOPS that HNSW indexing and WAL writes need. Zero network hops.                                     |
| `local-path` (HDD node)       | Acceptable for cold data. Not recommended — HNSW index traversal is random I/O, which HDDs handle poorly.                                 |
| NFS / network storage         | **Not compatible.** Qdrant requires POSIX-compliant block storage. NFS has known issues with mmap and file locking that Qdrant relies on. |
| Longhorn (replicated storage) | Overkill. Adds network latency to every I/O. The data is reconstructable — we don't need storage-level replication.                       |

**SSD vs HDD matters.** Qdrant's HNSW graph traversal performs random reads across the index. On HDD, each random read incurs a 5–10ms seek. On SSD, it's <0.1ms. For a graph traversal touching 100–200 nodes per query, that's the difference between 1ms and 1000ms. SSD is required for acceptable query latency.

### PVC Resize

If 10 GiB becomes insufficient:

- k3s `local-path` provisioner does **not** support volume expansion.
- Resize requires: snapshot → delete PVC → create larger PVC → restore snapshot.
- The backup runbook (Artifact 3) covers this procedure.

---

## Question 3: RAM Budget

**Question:** Does 8 GB give headroom for 100K entries at 1536 dimensions? Confirm.

**Decision:** 8 GB is the **limit**. Request 1 GiB, limit 2 GiB. 8 GB is excessive for our scale.

### Memory Breakdown at 100K Vectors (Quantized)

| Component                                          | RAM Usage   | Notes                                           |
| -------------------------------------------------- | ----------- | ----------------------------------------------- |
| Quantized vectors (int8, always_ram)               | ~150 MB     | `always_ram: true` in quantization config       |
| HNSW graph (in-memory)                             | ~13 MB      | m=16, 128 bytes per point                       |
| Payload indexes (keyword, integer)                 | ~30 MB      | 6 indexed fields                                |
| Payload data (in-memory, `on_disk_payload: false`) | ~50 MB      | All payloads in RAM for fast filtered retrieval |
| Qdrant process overhead                            | ~100 MB     | Runtime, gRPC/HTTP servers, connection pools    |
| Optimizer scratch space                            | ~100 MB     | Temporary buffers during segment merges         |
| **Total at 100K**                                  | **~443 MB** |                                                 |

Original float32 vectors are stored on disk (not in RAM) thanks to scalar quantization with `always_ram: true` — only the compressed int8 copies live in memory. Rescoring (if needed) reads from disk, which is acceptable at our query volume.

### Why Not 8 GB?

At 100K quantized vectors, Qdrant uses ~450 MB. Allocating 8 GB wastes 7.5 GB of RAM that the rest of the cluster needs — PostgreSQL, control plane pods, agent pods, monitoring. In a homelab with 32–64 GB total, every gigabyte counts.

### Recommended Allocation

| Parameter         | Value | Rationale                                                                                                                                                     |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requests.memory` | `1Gi` | Covers current usage (~450 MB) with room for burst. Scheduler can place the pod on any node with 1 GB free.                                                   |
| `limits.memory`   | `2Gi` | Hard ceiling. If Qdrant somehow exceeds 2 GB (runaway segment optimization, memory leak), the OOM killer terminates it. Pod restarts cleanly via StatefulSet. |

At 2 GiB limit, Qdrant can comfortably handle up to ~400K quantized vectors before approaching the ceiling. That's 4× our 1-year projection — years of headroom.

### When to Increase

- **>200K total vectors:** Raise limit to 4 GiB. Monitor via Prometheus metrics first.
- **>500K total vectors:** Consider dedicated node with 8 GiB+ for Qdrant. Re-evaluate HNSW parameters.

---

## Question 4: CPU Allocation

**Question:** How should CPU be allocated for indexing vs query workloads?

**Decision:** Request 250m, limit 2 cores. Let Qdrant auto-manage the split.

### Workload Profile

| Operation                        | CPU Pattern                             | Frequency                                       |
| -------------------------------- | --------------------------------------- | ----------------------------------------------- |
| **Serving (ANN search)**         | Short bursts, single-threaded per query | Every agent turn — ~10–50 queries/day           |
| **Indexing (HNSW build)**        | CPU-intensive, multi-threaded           | On memory writes — ~50–200 writes/day           |
| **Optimization (segment merge)** | Background, CPU-intensive               | Periodic — triggered by segment count threshold |
| **Idle**                         | Near zero                               | Most of the time                                |

At homelab scale, Qdrant is idle most of the time. Agent conversations happen in bursts. The CPU requirement is dominated by occasional indexing operations, not sustained query load.

### Qdrant's Built-in CPU Management

Qdrant has an internal `optimizer_cpu_budget` parameter (default: 0 = auto). In auto mode:

- Indexing uses `max(1, total_cpus - 1)` threads.
- At least 1 CPU is always reserved for serving.
- During indexing bursts, search quality is unaffected — Qdrant serves from the existing index while building the new one.

With a 2-core limit, this means: 1 core for indexing, 1 core for serving. This is more than sufficient for our query volume.

### Recommended Allocation

| Parameter      | Value  | Rationale                                                                                            |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `requests.cpu` | `250m` | Qdrant is mostly idle. 250m guarantees scheduling without hoarding CPU from other pods.              |
| `limits.cpu`   | `2`    | Allows indexing bursts to use 2 full cores. Prevents runaway optimization from starving the cluster. |

### Why Not More?

Qdrant's indexing is fast at small scale. Building an HNSW index for 10K vectors at 1536d takes <5 seconds on a single core. Even at 100K vectors, a full reindex takes ~30 seconds with 2 cores. We don't need 4+ cores for indexing that happens a few times per day.

---

## Question 5: Backup Strategy

**Question:** Snapshot to S3-compatible storage? Manual export?

**Decision:** Qdrant-native snapshots via the REST API, stored to a local volume, with optional push to S3-compatible storage (MinIO). Automated via Graphile Worker cron task.

### Strategy

```
1. Graphile Worker cron fires daily at 03:00 UTC
2. For each active collection:
   a. POST /collections/{name}/snapshots → creates snapshot tar
3. Copy snapshot from Qdrant pod to backup PVC (or push to MinIO via presigned URL)
4. Retain last 7 snapshots per collection. Delete older ones.
5. Log success/failure. Alert on failure via control plane health endpoint.
```

### Why Qdrant-Native Snapshots (Not PVC Snapshots)

| Approach                | Pros                                                                                                                               | Cons                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Qdrant snapshot API** | Application-consistent. Qdrant ensures the snapshot is a valid point-in-time image. Portable — can restore to any Qdrant instance. | Requires API call per collection. Snapshot sits in Qdrant's storage directory.                                                                                         |
| **PVC/volume snapshot** | Infrastructure-level. No application awareness needed.                                                                             | Not application-consistent — can capture mid-write state. Requires CSI driver with snapshot support (k3s `local-path` doesn't have this). Tied to the storage backend. |

Qdrant's snapshot API wins because:

1. It's **application-consistent** — the snapshot is always a valid state.
2. k3s `local-path` doesn't support CSI volume snapshots.
3. The snapshot tar files are portable — restore to any Qdrant instance, any cloud.

### S3-Compatible Storage (Optional)

For off-node backup durability, push snapshots to MinIO (or any S3-compatible storage running on the homelab). This is not required for day-one operation but recommended:

```bash
# After snapshot creation, copy from Qdrant pod and push to MinIO
kubectl cp qdrant-0:/qdrant/storage/snapshots/<collection>/<snapshot>.snapshot \
  /tmp/<snapshot>.snapshot

mc cp /tmp/<snapshot>.snapshot minio/cortex-backups/qdrant/<collection>/
```

The backup runbook (Artifact 3) provides step-by-step procedures.

---

## Question 6: Network Topology

**Question:** ClusterIP service? Headless for direct pod access?

**Decision:** ClusterIP service for REST and gRPC. No headless service needed (single node).

### Service Configuration

| Port | Protocol | Purpose                                                             |
| ---- | -------- | ------------------------------------------------------------------- |
| 6333 | HTTP     | REST API — used by `@qdrant/js-client-rest`, health checks, metrics |
| 6334 | gRPC     | gRPC API — higher throughput for batch operations                   |

**No port 6335.** The P2P/gossip port is only needed for Qdrant cluster mode (Raft consensus, shard sync). Single-node deployment doesn't use it.

### Why ClusterIP (Not Headless)

| Option           | Use Case                                                                                                  | Our Need                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **ClusterIP**    | Stable DNS name, load-balanced (irrelevant with 1 pod).                                                   | Yes — control plane connects to `qdrant.cortex.svc.cluster.local:6333`. Simple. |
| **Headless**     | Direct pod DNS (`qdrant-0.qdrant.cortex.svc.cluster.local`). Needed for peer discovery in clustered mode. | No — single node doesn't need peer discovery.                                   |
| **NodePort**     | External access from outside the cluster.                                                                 | No — Qdrant is internal-only.                                                   |
| **LoadBalancer** | External access with cloud LB.                                                                            | No — homelab, no cloud LB.                                                      |

ClusterIP is the simplest option. The control plane's `QDRANT_URL` environment variable points to `http://qdrant.cortex.svc.cluster.local:6333`.

### NetworkPolicy

Qdrant should only accept connections from the control plane pods. A NetworkPolicy restricts ingress:

```
Allow: pods with label app=cortex-control-plane → ports 6333, 6334
Deny: everything else
```

This prevents accidental or malicious access from other workloads in the cluster. The NetworkPolicy manifest is in Artifact 1.

---

## Question 7: TLS for Internal Traffic

**Question:** Should we enable TLS between agents and Qdrant for internal cluster traffic?

**Decision:** No TLS. Use NetworkPolicy for isolation instead.

### Options Evaluated

| Criterion             | TLS                                                            | No TLS + NetworkPolicy                                            |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Encryption in transit | Yes — all traffic encrypted.                                   | No — traffic is plaintext within the cluster network.             |
| Authentication        | mTLS provides identity verification.                           | NetworkPolicy restricts by pod label — no cryptographic identity. |
| Complexity            | Certificate management: generation, rotation, distribution.    | One NetworkPolicy manifest.                                       |
| Performance           | TLS handshake + encryption overhead (~5–10% latency increase). | Zero overhead.                                                    |
| Threat model          | Protects against traffic sniffing within the cluster.          | Protects against unauthorized connections.                        |
| Homelab reality       | Who is sniffing traffic on your home cluster?                  | Network segmentation is sufficient.                               |

### Rationale

1. **Threat model doesn't justify TLS.** In a homelab cluster, the network is trusted. There is no multi-tenant risk. The attacker who can sniff pod-to-pod traffic has already compromised a node, at which point TLS is irrelevant — they can read the data directly from the PVC.

2. **Certificate management is operational overhead.** Generating, distributing, and rotating TLS certificates (via cert-manager or manually) adds complexity that provides no security value in this environment. When we move to a shared or cloud cluster, TLS becomes necessary — and Qdrant supports it natively (see below).

3. **NetworkPolicy provides sufficient access control.** The NetworkPolicy restricts Qdrant ingress to pods labeled `app=cortex-control-plane`. This prevents unauthorized workloads from connecting. It's not cryptographic, but it's defense in depth.

### Future: Enabling TLS

Qdrant natively supports TLS via configuration:

```yaml
service:
  enable_tls: true

tls:
  cert: /tls/cert.pem
  key: /tls/key.pem
  ca_cert: /tls/ca.pem
  cert_ttl: 3600 # Auto-reload interval in seconds
```

When TLS is needed:

1. Deploy cert-manager to the cluster.
2. Create a Certificate resource for `qdrant.cortex.svc.cluster.local`.
3. Mount the TLS secret into the Qdrant pod.
4. Set `QDRANT__SERVICE__ENABLE_TLS=1` in the environment.
5. Update the control plane's `QDRANT_URL` from `http://` to `https://`.

This is a straightforward change that doesn't require manifest restructuring.

---

## Question 8: Monitoring

**Question:** How do we monitor Qdrant? Prometheus scrape?

**Decision:** Prometheus scrape of Qdrant's built-in `/metrics` endpoint via a ServiceMonitor (or Prometheus scrape annotation).

### Qdrant's Metrics

Qdrant exposes Prometheus-compatible metrics at `GET /metrics` on the HTTP port (6333). Key metrics:

| Metric                     | What It Tells You                                                          |
| -------------------------- | -------------------------------------------------------------------------- |
| `collections_total`        | Number of collections. Should match agent count.                           |
| `collections_vector_total` | Total vectors across all collections. Primary growth indicator.            |
| `rest_responses_*`         | REST API request counts and latencies by endpoint.                         |
| `grpc_responses_*`         | gRPC request counts and latencies.                                         |
| `app_info`                 | Qdrant version, build info.                                                |
| `cluster_*`                | Cluster status (irrelevant for single node, but confirms standalone mode). |

The metrics endpoint:

- Requires **no authentication** (excluded from API key checks by design).
- Has **no request logging overhead** (excluded from Qdrant's access log).
- Returns standard Prometheus text format.

### Scrape Configuration

**Option A: ServiceMonitor (if Prometheus Operator is deployed)**

A ServiceMonitor resource tells the Prometheus Operator to scrape the Qdrant service. This is the clean approach if kube-prometheus-stack or similar is installed.

**Option B: Pod annotations (if using plain Prometheus)**

Prometheus scrape annotations on the pod template:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "6333"
  prometheus.io/path: "/metrics"
```

Both approaches are provided in the monitoring configuration artifact. Use whichever matches your Prometheus deployment.

### Alerts (Recommended)

| Alert             | Condition                               | Severity |
| ----------------- | --------------------------------------- | -------- |
| QdrantDown        | `up{job="qdrant"} == 0` for >2m         | Critical |
| QdrantHighMemory  | Container memory > 80% of limit for >5m | Warning  |
| QdrantHighDisk    | PVC usage > 80% for >10m                | Warning  |
| QdrantSlowQueries | p99 REST response time > 200ms for >5m  | Warning  |

These are starting points. Tune thresholds after observing baseline behavior.

---

## Artifact: k3s Manifests

### Namespace

All Cortex Plane resources live in the `cortex` namespace.

```yaml
# deploy/qdrant/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: cortex
  labels:
    app.kubernetes.io/part-of: cortex-plane
```

### StatefulSet

```yaml
# deploy/qdrant/statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: qdrant
  namespace: cortex
  labels:
    app: qdrant
    app.kubernetes.io/name: qdrant
    app.kubernetes.io/component: vector-store
    app.kubernetes.io/part-of: cortex-plane
spec:
  serviceName: qdrant
  replicas: 1
  selector:
    matchLabels:
      app: qdrant
  template:
    metadata:
      labels:
        app: qdrant
        app.kubernetes.io/name: qdrant
        app.kubernetes.io/component: vector-store
        app.kubernetes.io/part-of: cortex-plane
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "6333"
        prometheus.io/path: "/metrics"
    spec:
      securityContext:
        runAsUser: 1000
        runAsGroup: 2000
        fsGroup: 3000
        runAsNonRoot: true
      containers:
        - name: qdrant
          image: qdrant/qdrant:v1.13.2
          ports:
            - name: http
              containerPort: 6333
              protocol: TCP
            - name: grpc
              containerPort: 6334
              protocol: TCP
          env:
            - name: QDRANT__SERVICE__ENABLE_TLS
              value: "0"
            - name: QDRANT__STORAGE__WAL_CAPACITY_MB
              value: "32"
            - name: QDRANT__SERVICE__MAX_REQUEST_SIZE_MB
              value: "32"
          resources:
            requests:
              cpu: 250m
              memory: 1Gi
            limits:
              cpu: "2"
              memory: 2Gi
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /livez
              port: http
            initialDelaySeconds: 15
            periodSeconds: 15
            timeoutSeconds: 3
            failureThreshold: 3
          startupProbe:
            httpGet:
              path: /readyz
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 12 # 60s max startup time
          volumeMounts:
            - name: qdrant-data
              mountPath: /qdrant/storage
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
      terminationGracePeriodSeconds: 30
  volumeClaimTemplates:
    - metadata:
        name: qdrant-data
        labels:
          app: qdrant
          app.kubernetes.io/name: qdrant
          app.kubernetes.io/component: vector-store
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: local-path
        resources:
          requests:
            storage: 10Gi
```

### Service

```yaml
# deploy/qdrant/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: qdrant
  namespace: cortex
  labels:
    app: qdrant
    app.kubernetes.io/name: qdrant
    app.kubernetes.io/component: vector-store
    app.kubernetes.io/part-of: cortex-plane
spec:
  type: ClusterIP
  selector:
    app: qdrant
  ports:
    - name: http
      port: 6333
      targetPort: http
      protocol: TCP
    - name: grpc
      port: 6334
      targetPort: grpc
      protocol: TCP
```

### NetworkPolicy

```yaml
# deploy/qdrant/networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: qdrant-ingress
  namespace: cortex
  labels:
    app: qdrant
    app.kubernetes.io/name: qdrant
    app.kubernetes.io/component: vector-store
    app.kubernetes.io/part-of: cortex-plane
spec:
  podSelector:
    matchLabels:
      app: qdrant
  policyTypes:
    - Ingress
  ingress:
    # Allow control plane pods to access REST and gRPC
    - from:
        - podSelector:
            matchLabels:
              app: cortex-control-plane
      ports:
        - port: 6333
          protocol: TCP
        - port: 6334
          protocol: TCP
    # Allow Prometheus to scrape metrics
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 6333
          protocol: TCP
```

### Kustomization

```yaml
# deploy/qdrant/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: cortex

resources:
  - namespace.yaml
  - statefulset.yaml
  - service.yaml
  - networkpolicy.yaml
```

**Deployment:**

```bash
kubectl apply -k deploy/qdrant/
```

---

## Artifact: Resource Request/Limit Spec

### Sizing Table

| Resource          | Request | Limit | Rationale                                                                                                             |
| ----------------- | ------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| **CPU**           | 250m    | 2     | Mostly idle. 250m guarantees scheduling. 2-core limit allows indexing bursts without starving the cluster.            |
| **Memory**        | 1Gi     | 2Gi   | ~450 MB actual usage at 100K vectors. 1Gi request ensures scheduling. 2Gi limit prevents runaway growth.              |
| **Storage (PVC)** | 10Gi    | —     | ~1.7 GB actual at 100K vectors including snapshots. 10Gi provides 5× headroom for growth and optimizer scratch space. |

### Growth Thresholds

| Scale          | Vectors   | Actual RAM | Recommended Limit | Action                                          |
| -------------- | --------- | ---------- | ----------------- | ----------------------------------------------- |
| **Current**    | <100K     | ~450 MB    | 2Gi               | Default configuration.                          |
| **Growing**    | 100K–200K | ~900 MB    | 2Gi               | Monitor. Still within limits.                   |
| **Large**      | 200K–500K | ~1.8 GB    | 4Gi               | Increase memory limit. Consider dedicated node. |
| **Enterprise** | >500K     | >2.5 GB    | 8Gi               | Dedicated node. Evaluate Qdrant cluster mode.   |

### Quality-of-Service Class

With `requests < limits`, the pod gets **Burstable** QoS. This means:

- The pod is guaranteed 250m CPU and 1Gi memory.
- It can burst up to 2 CPU and 2Gi memory when available.
- Under cluster memory pressure, Burstable pods are evicted after BestEffort pods but before Guaranteed pods.

This is the right QoS for Qdrant in a shared homelab cluster — it doesn't hoard resources when idle, but gets what it needs during bursts.

---

## Artifact: Backup/Restore Runbook

### Prerequisites

- `kubectl` configured for the k3s cluster.
- Access to the `cortex` namespace.
- (Optional) MinIO client (`mc`) configured for off-node backup.

### Procedure 1: Manual Snapshot

**Create a snapshot for a single collection:**

```bash
# List all collections
kubectl exec -n cortex qdrant-0 -- \
  curl -s http://localhost:6333/collections | jq '.result.collections[].name'

# Create snapshot (replace COLLECTION_NAME)
COLLECTION=agent_memory_devops-agent

kubectl exec -n cortex qdrant-0 -- \
  curl -s -X POST "http://localhost:6333/collections/${COLLECTION}/snapshots" \
  | jq '.'

# Response includes the snapshot filename:
# { "result": { "name": "agent_memory_devops-agent-2026-02-23-03-00-00.snapshot" } }
```

**List snapshots:**

```bash
kubectl exec -n cortex qdrant-0 -- \
  curl -s "http://localhost:6333/collections/${COLLECTION}/snapshots" \
  | jq '.result[]'
```

**Copy snapshot off the pod:**

```bash
SNAPSHOT_NAME=agent_memory_devops-agent-2026-02-23-03-00-00.snapshot

kubectl cp \
  cortex/qdrant-0:/qdrant/storage/snapshots/${COLLECTION}/${SNAPSHOT_NAME} \
  /tmp/${SNAPSHOT_NAME}
```

**Push to MinIO (optional):**

```bash
mc cp /tmp/${SNAPSHOT_NAME} minio/cortex-backups/qdrant/${COLLECTION}/
```

### Procedure 2: Snapshot All Collections

```bash
#!/usr/bin/env bash
# backup-qdrant.sh — Snapshot all Qdrant collections
set -euo pipefail

NAMESPACE=cortex
POD=qdrant-0
BACKUP_DIR=/tmp/qdrant-backups/$(date +%Y-%m-%d)

mkdir -p "$BACKUP_DIR"

# Get all collection names
COLLECTIONS=$(kubectl exec -n "$NAMESPACE" "$POD" -- \
  curl -sf http://localhost:6333/collections \
  | jq -r '.result.collections[].name')

for COLLECTION in $COLLECTIONS; do
  echo "Snapshotting: $COLLECTION"

  # Create snapshot
  SNAPSHOT=$(kubectl exec -n "$NAMESPACE" "$POD" -- \
    curl -sf -X POST "http://localhost:6333/collections/${COLLECTION}/snapshots" \
    | jq -r '.result.name')

  echo "  Created: $SNAPSHOT"

  # Copy to local
  kubectl cp \
    "${NAMESPACE}/${POD}:/qdrant/storage/snapshots/${COLLECTION}/${SNAPSHOT}" \
    "${BACKUP_DIR}/${SNAPSHOT}"

  echo "  Copied to: ${BACKUP_DIR}/${SNAPSHOT}"
done

echo "All snapshots saved to: $BACKUP_DIR"
```

### Procedure 3: Restore from Snapshot

**Restore a collection from an uploaded snapshot file:**

```bash
COLLECTION=agent_memory_devops-agent
SNAPSHOT_FILE=/tmp/agent_memory_devops-agent-2026-02-23-03-00-00.snapshot

# Copy snapshot into the pod
kubectl cp "$SNAPSHOT_FILE" cortex/qdrant-0:/tmp/restore.snapshot

# Restore — this creates the collection if it doesn't exist
kubectl exec -n cortex qdrant-0 -- \
  curl -s -X POST \
    "http://localhost:6333/collections/${COLLECTION}/snapshots/upload?priority=snapshot" \
    -H "Content-Type: multipart/form-data" \
    -F "snapshot=@/tmp/restore.snapshot"

# Verify
kubectl exec -n cortex qdrant-0 -- \
  curl -s "http://localhost:6333/collections/${COLLECTION}" | jq '.result.points_count'
```

### Procedure 4: Restore After PVC Loss (Full Recovery)

If the Qdrant PVC is lost (node failure, accidental deletion):

```bash
# 1. Delete the StatefulSet (preserves PVC if it still exists)
kubectl delete statefulset qdrant -n cortex --cascade=orphan

# 2. Delete the old PVC if it's in a failed state
kubectl delete pvc qdrant-data-qdrant-0 -n cortex

# 3. Re-apply manifests (creates new StatefulSet + PVC)
kubectl apply -k deploy/qdrant/

# 4. Wait for pod to be ready
kubectl wait -n cortex --for=condition=ready pod/qdrant-0 --timeout=120s

# 5. Restore each collection from backup snapshots
for SNAPSHOT_FILE in /path/to/backups/*.snapshot; do
  COLLECTION=$(basename "$SNAPSHOT_FILE" | sed 's/-[0-9].*\.snapshot$//')
  echo "Restoring: $COLLECTION from $SNAPSHOT_FILE"

  kubectl cp "$SNAPSHOT_FILE" cortex/qdrant-0:/tmp/restore.snapshot

  kubectl exec -n cortex qdrant-0 -- \
    curl -sf -X POST \
      "http://localhost:6333/collections/${COLLECTION}/snapshots/upload?priority=snapshot" \
      -H "Content-Type: multipart/form-data" \
      -F "snapshot=@/tmp/restore.snapshot"
done

# 6. Verify all collections are restored
kubectl exec -n cortex qdrant-0 -- \
  curl -sf http://localhost:6333/collections | jq '.result.collections[] | {name, points_count}'
```

### Procedure 5: PVC Resize

k3s `local-path` doesn't support online volume expansion. To resize:

```bash
# 1. Snapshot all collections (Procedure 2)
./backup-qdrant.sh

# 2. Delete StatefulSet (orphan PVC)
kubectl delete statefulset qdrant -n cortex --cascade=orphan

# 3. Delete old PVC
kubectl delete pvc qdrant-data-qdrant-0 -n cortex

# 4. Edit statefulset.yaml — change storage request to new size
#    e.g., 10Gi → 20Gi

# 5. Re-apply
kubectl apply -k deploy/qdrant/

# 6. Wait for ready
kubectl wait -n cortex --for=condition=ready pod/qdrant-0 --timeout=120s

# 7. Restore (Procedure 4, step 5)
```

### Automated Backup (Graphile Worker)

The daily backup task is registered as a Graphile Worker cron. It runs Procedure 2 logic via the Qdrant REST API from the control plane (no kubectl exec needed):

```typescript
// Registered in Graphile Worker task list
// Cron: "0 3 * * *" (daily at 03:00 UTC)

async function backupQdrant(client: QdrantClient, logger: Logger): Promise<void> {
  const { collections } = await client.getCollections()

  for (const { name } of collections) {
    const snapshot = await client.createSnapshot(name)
    logger.info({ collection: name, snapshot: snapshot.name }, "snapshot created")
  }

  // Retention: delete snapshots older than 7 days
  for (const { name } of collections) {
    const snapshots = await client.listSnapshots(name)
    const cutoff = Date.now() - 7 * 86_400_000

    for (const snap of snapshots) {
      // Snapshot names contain timestamps — parse and compare
      const created = parseSnapshotTimestamp(snap.name)
      if (created < cutoff) {
        await client.deleteSnapshot(name, snap.name)
        logger.info({ collection: name, snapshot: snap.name }, "old snapshot deleted")
      }
    }
  }
}
```

**Note:** This task creates snapshots within Qdrant's storage directory. Snapshots consume PVC space. The 7-day retention policy limits accumulation. For off-node durability, add a separate task to push snapshots to MinIO.

### Snapshot Retention

| Retention | Snapshots Kept   | Approximate Storage                 |
| --------- | ---------------- | ----------------------------------- |
| 7 days    | 7 per collection | ~6 GB (7 × ~850 MB at 100K vectors) |
| 3 days    | 3 per collection | ~2.5 GB                             |
| 1 day     | 1 per collection | ~850 MB                             |

The 10Gi PVC accommodates live data (~1.7 GB) plus 7 daily snapshots (~6 GB) with headroom. If PVC space is tight, reduce retention to 3 days.

---

## Artifact: Monitoring Configuration

### ServiceMonitor (Prometheus Operator)

```yaml
# deploy/qdrant/servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: qdrant
  namespace: cortex
  labels:
    app: qdrant
    app.kubernetes.io/name: qdrant
    app.kubernetes.io/component: vector-store
    app.kubernetes.io/part-of: cortex-plane
spec:
  selector:
    matchLabels:
      app: qdrant
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
  namespaceSelector:
    matchNames:
      - cortex
```

### Prometheus Scrape Config (Plain Prometheus)

If not using Prometheus Operator, add this to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: "qdrant"
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
            - cortex
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        regex: qdrant
        action: keep
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
        target_label: __address__
        regex: (.+)
        replacement: "${1}"
        action: replace
    metrics_path: /metrics
    scrape_interval: 30s
```

Alternatively, since the pod template already has `prometheus.io/scrape: "true"` annotations, Prometheus with default annotation-based service discovery will pick it up automatically.

### PrometheusRule (Alerts)

```yaml
# deploy/qdrant/prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: qdrant-alerts
  namespace: cortex
  labels:
    app: qdrant
    app.kubernetes.io/name: qdrant
    app.kubernetes.io/component: vector-store
    app.kubernetes.io/part-of: cortex-plane
spec:
  groups:
    - name: qdrant
      rules:
        - alert: QdrantDown
          expr: up{job="qdrant"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Qdrant is down"
            description: "Qdrant pod has been unreachable for more than 2 minutes."

        - alert: QdrantHighMemory
          expr: >
            container_memory_working_set_bytes{namespace="cortex", pod=~"qdrant-.*"}
            / container_spec_memory_limit_bytes{namespace="cortex", pod=~"qdrant-.*"}
            > 0.8
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Qdrant memory usage above 80%"
            description: "Qdrant is using {{ $value | humanizePercentage }} of its memory limit."

        - alert: QdrantHighDisk
          expr: >
            kubelet_volume_stats_used_bytes{namespace="cortex", persistentvolumeclaim="qdrant-data-qdrant-0"}
            / kubelet_volume_stats_capacity_bytes{namespace="cortex", persistentvolumeclaim="qdrant-data-qdrant-0"}
            > 0.8
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Qdrant PVC usage above 80%"
            description: "Qdrant PVC is {{ $value | humanizePercentage }} full. Consider expanding or reducing snapshot retention."

        - alert: QdrantSlowResponses
          expr: >
            histogram_quantile(0.99,
              rate(rest_responses_duration_seconds_bucket{job="qdrant"}[5m])
            ) > 0.2
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Qdrant p99 latency above 200ms"
            description: "Qdrant REST API p99 response time is {{ $value }}s."
```

### Grafana Dashboard (Optional)

Qdrant's community provides a Grafana dashboard. Import dashboard ID `20526` from Grafana Labs, or create a minimal one tracking:

- `collections_vector_total` — total vectors (growth over time)
- `rest_responses_duration_seconds` — query latency histogram
- Container memory usage vs limit
- PVC usage vs capacity

---

## Design Decisions

### 1. No Helm Chart

**Decision:** Use raw Kustomize manifests, not the official Qdrant Helm chart.

**Rationale:** The Helm chart is designed for production deployments with clustering, TLS, distributed sharding, and configurable replicas. For a single-node homelab deployment, it's over-abstracted — you're setting 40 Helm values to disable features you don't need. Raw manifests are 4 files, each fully readable and auditable. When the deployment outgrows raw manifests, we can migrate to Helm or add more Kustomize overlays.

### 2. readOnlyRootFilesystem

**Decision:** Run Qdrant with a read-only root filesystem.

**Rationale:** Qdrant writes only to `/qdrant/storage` (mounted from the PVC). The root filesystem doesn't need to be writable. This is a defense-in-depth measure — if a vulnerability allows code execution inside the container, it can't modify the container's binaries or write to arbitrary paths.

### 3. Startup Probe

**Decision:** Include a startup probe with 60-second timeout (12 attempts × 5 seconds).

**Rationale:** On first boot or after a restore, Qdrant may take time to load HNSW indexes into memory. Without a startup probe, the liveness probe might kill the pod before it's ready. The startup probe gives Qdrant 60 seconds to initialize before liveness checks begin.

### 4. Snapshot-Based Backup (Not WAL Replay)

**Decision:** Use Qdrant's snapshot API for backup, not WAL archiving.

**Rationale:** Qdrant's WAL is an internal implementation detail, not a backup mechanism. WAL segments are compacted and recycled — you can't reliably reconstruct state from WAL alone (unlike PostgreSQL's WAL archiving). Qdrant's snapshot API produces a consistent, portable tar archive that can be restored to any Qdrant instance.

### 5. Prometheus Annotations + ServiceMonitor

**Decision:** Include both pod annotations and a ServiceMonitor resource.

**Rationale:** Different Prometheus deployments discover targets differently. Plain Prometheus uses annotation-based discovery; Prometheus Operator uses ServiceMonitor CRDs. Including both ensures monitoring works regardless of how Prometheus is deployed on the cluster.

---

## Open Questions

1. **API key authentication.** Qdrant supports API key auth (`QDRANT__SERVICE__API_KEY`). Should we enable it? The NetworkPolicy restricts access to the control plane, so the API key adds defense-in-depth but requires secret management. Likely yes — add to a future secrets management spike.

2. **Automated backup to MinIO.** The backup runbook includes manual `mc cp` steps. Should the Graphile Worker cron task push snapshots to MinIO directly via the S3 SDK? This requires MinIO to be deployed on the cluster first. Depends on the broader backup infrastructure spike.

3. **Node affinity.** Should the Qdrant pod be pinned to a specific node (the one with the SSD)? If the cluster has mixed storage (SSD on node A, HDD on node B), a `nodeAffinity` rule ensures Qdrant always lands on the SSD node. This is cluster-specific configuration — add via a Kustomize overlay.

4. **PVC backup before upgrades.** When upgrading Qdrant versions (e.g., v1.13.2 → v1.14.x), should the runbook mandate a snapshot before the upgrade? Yes — Qdrant storage format changes are generally backward-compatible but a snapshot provides a rollback path.

5. **Resource monitoring baseline.** The alert thresholds (80% memory, 80% disk, 200ms p99) are educated guesses. They need tuning after observing real-world baseline behavior. Run for 2 weeks, analyze Prometheus data, then adjust.

6. **Snapshot storage location.** Currently, snapshots are stored inside the same PVC as the live data. This means a PVC loss destroys both live data and local backups. Off-node backup (MinIO, NFS export, rsync to another machine) should be prioritized.
