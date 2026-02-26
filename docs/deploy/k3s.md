# Deploying to k3s (Proxmox VM)

Step-by-step runbook: blank Ubuntu VM to a healthy Cortex Plane cluster on k3s.

---

## 1. VM Preparation

Minimum specs for a single-node deployment:

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| vCPU     | 4       | 6           |
| RAM      | 8 GB    | 16 GB       |
| Disk     | 40 GB   | 80 GB       |
| OS       | Ubuntu 24.04 LTS | Ubuntu 24.04 LTS |

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git
```

Ensure the VM has a static IP or a DHCP reservation so the cluster API address is stable.

---

## 2. Install k3s

Install a single-node k3s cluster. Disable the built-in Traefik ingress if you plan to use nginx-ingress instead:

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -
```

Verify installation:

```bash
sudo k3s kubectl get nodes
```

Copy the kubeconfig for use with `kubectl` on your workstation:

```bash
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $(id -u):$(id -g) ~/.kube/config
# If accessing remotely, replace 127.0.0.1 with the VM IP:
sed -i "s/127.0.0.1/<VM_IP>/g" ~/.kube/config
```

---

## 3. Install Prerequisites

```bash
# kubectl (already bundled with k3s, but install standalone for convenience)
sudo snap install kubectl --classic

# kustomize
curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" | bash
sudo mv kustomize /usr/local/bin/
```

---

## 4. Create Namespace

```bash
kubectl create namespace cortex-plane
kubectl config set-context --current --namespace=cortex-plane
```

---

## 5. Set Up Secrets

Create the secret that the control-plane deployment references via `secretRef: control-plane-secrets`:

```bash
kubectl -n cortex-plane create secret generic control-plane-secrets \
  --from-literal=DATABASE_URL='postgres://cortex:YOUR_PASSWORD@postgres:5432/cortex_plane' \
  --from-literal=CREDENTIAL_MASTER_KEY='YOUR_32_BYTE_HEX_KEY'
```

Generate a master key if you do not have one:

```bash
openssl rand -hex 32
```

---

## 6. Deploy PostgreSQL

**Option A: In-cluster (for dev/demo).** Create a minimal Postgres deployment:

```yaml
# postgres-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: cortex-plane
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources:
    requests:
      storage: 10Gi
```

```yaml
# postgres-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: cortex-plane
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:17-bookworm
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_USER
              value: cortex
            - name: POSTGRES_PASSWORD
              value: YOUR_PASSWORD
            - name: POSTGRES_DB
              value: cortex_plane
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: postgres-data
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: cortex-plane
spec:
  selector:
    app: postgres
  ports:
    - port: 5432
      targetPort: 5432
```

```bash
kubectl apply -f postgres-pvc.yaml -f postgres-deployment.yaml
```

**Option B: External managed DB.** Point `DATABASE_URL` in the secret to your managed Postgres instance and skip the in-cluster deployment.

---

## 7. Deploy Qdrant

Apply the Qdrant manifests from the repo:

```bash
kubectl apply -k deploy/k8s/qdrant/ -n cortex-plane
```

This creates:
- `qdrant-data` PVC (10Gi, `local-path` storage class)
- `qdrant-config` ConfigMap (production.yaml tuning)
- Deployment (`qdrant/qdrant:v1.13.2` with liveness/readiness probes on port 6333)
- Service (ClusterIP, ports 6333 HTTP + 6334 gRPC)

Wait for ready:

```bash
kubectl -n cortex-plane rollout status deployment/qdrant
```

---

## 8. Deploy Control Plane

Apply the control-plane manifests:

```bash
kubectl apply -k deploy/k8s/control-plane/ -n cortex-plane
```

This creates:
- `control-plane-config` ConfigMap (PORT, HOST, NODE_ENV, LOG_LEVEL, QDRANT_URL, GRAPHILE_WORKER_CONCURRENCY)
- Deployment (`noncelogic/cortex-control-plane:latest`, port 4000)
- Service (ClusterIP, port 4000)

The deployment references both the ConfigMap and the `control-plane-secrets` Secret.

Wait for ready:

```bash
kubectl -n cortex-plane rollout status deployment/control-plane
```

Run database migrations if this is the first deploy:

```bash
kubectl -n cortex-plane exec deploy/control-plane -- \
  node packages/control-plane/dist/migrate.js
```

---

## 9. Deploy Dashboard

Apply the dashboard manifests:

```bash
kubectl apply -k deploy/k8s/dashboard/ -n cortex-plane
```

This creates:
- `dashboard-config` ConfigMap (HOSTNAME, PORT, NODE_ENV, CORTEX_API_URL, NEXT_PUBLIC_CORTEX_API_URL)
- Deployment (`noncelogic/cortex-dashboard:latest`, port 3000)
- Service (ClusterIP, port 3000)

Update `NEXT_PUBLIC_CORTEX_API_URL` in the ConfigMap to match your actual public URL before applying.

Wait for ready:

```bash
kubectl -n cortex-plane rollout status deployment/dashboard
```

---

## 10. Configure Ingress and TLS

### Install nginx-ingress

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.0/deploy/static/provider/cloud/deploy.yaml
```

### Install cert-manager

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.0/cert-manager.yaml
```

### Create ClusterIssuer for Let's Encrypt

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
      - http01:
          ingress:
            class: nginx
```

### Create Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: cortex-plane-ingress
  namespace: cortex-plane
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "32m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - cortex.example.com
      secretName: cortex-tls
  rules:
    - host: cortex.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: control-plane
                port:
                  number: 4000
          - path: /healthz
            pathType: Exact
            backend:
              service:
                name: control-plane
                port:
                  number: 4000
          - path: /readyz
            pathType: Exact
            backend:
              service:
                name: control-plane
                port:
                  number: 4000
          - path: /
            pathType: Prefix
            backend:
              service:
                name: dashboard
                port:
                  number: 3000
```

Apply:

```bash
kubectl apply -f cluster-issuer.yaml -f ingress.yaml
```

---

## 11. Verify with Smoke Test

Port-forward if you do not have ingress set up yet:

```bash
kubectl -n cortex-plane port-forward svc/control-plane 4000:4000 &
kubectl -n cortex-plane port-forward svc/dashboard 3000:3000 &
```

Run the smoke test from the repo root:

```bash
./scripts/smoke-test.sh http://localhost:4000
```

Or test directly:

```bash
curl -sf http://localhost:4000/healthz   # expect 200
curl -sf http://localhost:4000/readyz    # expect 200
curl -sf http://localhost:6333/healthz   # expect 200 (if port-forwarded)
curl -sf http://localhost:3000/          # expect 200
```

---

## 12. Persistent Volume Notes

k3s ships with the `local-path` provisioner by default. This stores PV data on the node filesystem under `/var/lib/rancher/k3s/storage/`.

| PVC           | Default Size | Storage Class | Mount Path             |
|---------------|-------------|---------------|------------------------|
| `qdrant-data` | 10Gi        | `local-path`  | `/qdrant/storage`      |
| `postgres-data` (if in-cluster) | 10Gi | `local-path` | `/var/lib/postgresql/data` |

**Backup strategy:** Snapshot the Proxmox VM disk, or use `kubectl exec` to run `pg_dump` and copy Qdrant snapshots.

For production, consider a CSI driver with proper backup support (e.g., Longhorn).

---

## 13. Resource Requirements Summary

| Component      | CPU Request | CPU Limit | Memory Request | Memory Limit |
|---------------|-------------|-----------|----------------|--------------|
| control-plane | 250m        | 1000m     | 256Mi          | 512Mi        |
| dashboard     | 100m        | 500m      | 128Mi          | 256Mi        |
| qdrant        | 500m        | 1000m     | 1Gi            | 2Gi          |
| postgres      | 250m        | 500m      | 256Mi          | 512Mi        |
| **Total**     | **1100m**   | **3000m** | **~1.6Gi**     | **~3.3Gi**   |

The 4 vCPU / 8 GB minimum leaves headroom for k3s system components and the ingress controller.

---

## 14. Common Troubleshooting

### Pod stuck in CrashLoopBackOff

```bash
kubectl -n cortex-plane logs deploy/control-plane --previous
kubectl -n cortex-plane describe pod -l app=control-plane
```

Common causes: missing `control-plane-secrets`, unreachable Postgres, failed migrations.

### Readiness probe failing

```bash
kubectl -n cortex-plane exec deploy/control-plane -- \
  node -e "fetch('http://localhost:4000/readyz').then(r=>r.text()).then(console.log)"
```

The `/readyz` endpoint checks the database connection. If it fails, verify `DATABASE_URL` and Postgres connectivity.

### PVC stuck in Pending

```bash
kubectl -n cortex-plane get pvc
kubectl -n cortex-plane describe pvc qdrant-data
```

Ensure the `local-path` storage class exists:

```bash
kubectl get storageclass
```

### Images not pulling

If using GHCR private images:

```bash
kubectl -n cortex-plane create secret docker-registry ghcr-creds \
  --docker-server=ghcr.io \
  --docker-username=YOUR_GH_USER \
  --docker-password=YOUR_GH_PAT

# Then add imagePullSecrets to deployments or patch the default service account
kubectl -n cortex-plane patch serviceaccount default \
  -p '{"imagePullSecrets": [{"name": "ghcr-creds"}]}'
```

### DNS resolution inside the cluster

```bash
kubectl -n cortex-plane exec deploy/control-plane -- nslookup postgres
kubectl -n cortex-plane exec deploy/control-plane -- nslookup qdrant
```

### Restarting a single service

```bash
kubectl -n cortex-plane rollout restart deployment/control-plane
kubectl -n cortex-plane rollout status deployment/control-plane
```
