# k3s Deployment Runbook

Deploy Cortex Plane on a fresh k3s VM (e.g., Proxmox / lnx-pegasus).

## Prerequisites

| Requirement | Minimum |
|---|---|
| VM RAM | 4 GB |
| VM Disk | 40 GB |
| OS | Ubuntu 22.04+ / Debian 12+ |
| Network | Static IP, ports 80/443 open |

## 1. Install k3s

```bash
curl -sfL https://get.k3s.io | sh -
# Verify
sudo k3s kubectl get nodes
```

Copy kubeconfig for local use:

```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $USER ~/.kube/config
# Update server address if accessing remotely:
# sed -i "s/127.0.0.1/<VM_IP>/" ~/.kube/config
```

## 2. Create namespace and secrets

```bash
kubectl create namespace cortex

# Postgres credentials
kubectl create secret generic postgres-secrets \
  --from-literal=POSTGRES_USER=cortex \
  --from-literal=POSTGRES_PASSWORD='<STRONG_PASSWORD>' \
  --from-literal=POSTGRES_DB=cortex_plane \
  -n cortex

# Control-plane secrets
kubectl create secret generic control-plane-secrets \
  --from-literal=DATABASE_URL='postgres://cortex:<STRONG_PASSWORD>@postgres:5432/cortex_plane' \
  --from-literal=CREDENTIAL_MASTER_KEY='<32_BYTE_HEX>' \
  -n cortex
```

## 3. Deploy with kustomize

### Development overlay (uses `:latest` tags)

```bash
kubectl apply -k deploy/k8s/overlays/dev/
```

### Production overlay (with ingress)

Edit `deploy/k8s/overlays/prod/ingress.yaml` — set your hostname:

```yaml
rules:
  - host: cortex.yourdomain.com
```

Then deploy:

```bash
kubectl apply -k deploy/k8s/overlays/prod/
```

## 4. Verify deployment

```bash
kubectl -n cortex get pods
kubectl -n cortex get svc

# Wait for all pods ready
kubectl -n cortex wait --for=condition=ready pod --all --timeout=120s

# Check control-plane health
kubectl -n cortex port-forward svc/control-plane 4000:4000 &
curl http://localhost:4000/healthz
curl http://localhost:4000/readyz
```

## 5. TLS with cert-manager (optional)

```bash
# Install cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml

# Create ClusterIssuer
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: traefik
EOF
```

Then uncomment the `tls` and `cert-manager.io/cluster-issuer` sections in `ingress.yaml` and re-apply.

## 6. Persistent volumes

k3s ships with Rancher's `local-path` provisioner. PVCs in the manifests use `storageClassName: local-path` by default.

Data locations on the host:

| Service | Volume | Default host path |
|---|---|---|
| Postgres | `postgres-data` | `/opt/local-path-provisioner/...` |
| Qdrant | `qdrant-data` | `/opt/local-path-provisioner/...` |

For production, consider backing up these directories or switching to a more robust storage class.

## 7. Updating images

```bash
# Pull latest and restart
kubectl -n cortex rollout restart deployment/control-plane
kubectl -n cortex rollout restart deployment/dashboard

# Or pin to a specific SHA tag
cd deploy/k8s/overlays/prod
kustomize edit set image noncelogic/cortex-control-plane:abc1234
kubectl apply -k .
```

## 8. Rollback

```bash
# View history
kubectl -n cortex rollout history deployment/control-plane

# Rollback to previous
kubectl -n cortex rollout undo deployment/control-plane

# Rollback to specific revision
kubectl -n cortex rollout undo deployment/control-plane --to-revision=2
```

## 9. Troubleshooting

```bash
# Pod logs
kubectl -n cortex logs -f deployment/control-plane
kubectl -n cortex logs -f deployment/dashboard

# Describe a failing pod
kubectl -n cortex describe pod <pod-name>

# Check events
kubectl -n cortex get events --sort-by='.lastTimestamp'

# Restart stuck pod
kubectl -n cortex delete pod <pod-name>
```
