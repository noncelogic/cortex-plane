# PVE VM + k3s Bootstrap Runbook

Reproducible runbook for provisioning a Cortex Plane VM on Proxmox VE (lnx-pegasus) and bootstrapping a single-node k3s cluster.

> **Scope:** Demo-critical infra path. For application deployment steps, see [k3s.md](./k3s.md) and [first-deploy.md](./first-deploy.md).

---

## Current Deployment

| Property      | Value                                      |
| ------------- | ------------------------------------------ |
| PVE Host      | lnx-pegasus (AMD Ryzen 9 3950X, 64 GB RAM) |
| VMID          | 110                                        |
| VM Name       | cortex-plane                               |
| OS            | Ubuntu 24.04.4 LTS                         |
| vCPU          | 4 (host passthrough)                       |
| RAM           | 8 GiB                                      |
| Disk          | 80 GB (local-lvm, thin)                    |
| Static IP     | 10.244.7.110/16                            |
| Gateway       | 10.244.0.1                                 |
| DNS           | 10.244.0.1                                 |
| SSH User      | cortex                                     |
| k3s Version   | v1.34.4+k3s1                               |
| Ingress       | Traefik (bundled, hostPort 80/443)         |
| Storage Class | local-path (default)                       |
| Namespace     | cortex (pre-created)                       |

---

## 1. Prerequisites

- SSH access to lnx-pegasus as a user with `sudo` privileges
- Proxmox VE tools: `qm`, `pvesm` (available on PVE host)
- Ubuntu 24.04 cloud image (downloaded to PVE `local` storage)

---

## 2. Download Cloud Image (one-time)

```bash
ssh lnx-pegasus
sudo wget -O /var/lib/vz/template/iso/noble-server-cloudimg-amd64.img \
  https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
```

---

## 3. Create the VM

```bash
VMID=110
VM_NAME=cortex-plane
VM_IP=10.244.7.110
GATEWAY=10.244.0.1
CORES=4
MEMORY=8192    # MiB
DISK_SIZE=80G
STORAGE=local-lvm
BRIDGE=vmbr0

# Create VM shell
sudo qm create $VMID \
  --name $VM_NAME \
  --ostype l26 \
  --cpu host \
  --cores $CORES \
  --sockets 1 \
  --memory $MEMORY \
  --net0 virtio,bridge=$BRIDGE,firewall=1 \
  --scsihw virtio-scsi-single \
  --agent enabled=1 \
  --onboot 1 \
  --boot order=scsi0

# Import cloud image as boot disk
sudo qm set $VMID \
  --scsi0 $STORAGE:0,import-from=/var/lib/vz/template/iso/noble-server-cloudimg-amd64.img,size=$DISK_SIZE

# Resize to target (import creates at image size)
sudo qm disk resize $VMID scsi0 $DISK_SIZE

# Add cloud-init drive
sudo qm set $VMID --ide2 $STORAGE:cloudinit

# Configure cloud-init
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM7ru1REX/ZUb/pRcxBGggSfUeyHZwh6+1ZdSS9BRU1p jg-noncelogic@lnx-aquila' \
  > /tmp/cortex-sshkey.pub

sudo qm set $VMID \
  --ciuser cortex \
  --sshkeys /tmp/cortex-sshkey.pub \
  --ipconfig0 ip=$VM_IP/16,gw=$GATEWAY \
  --nameserver $GATEWAY \
  --searchdomain local

rm /tmp/cortex-sshkey.pub
```

---

## 4. Start the VM

```bash
sudo qm start $VMID
```

Wait for SSH (typically 15-30 seconds with cloud-init):

```bash
until ssh -o ConnectTimeout=3 -o BatchMode=yes cortex@10.244.7.110 true 2>/dev/null; do
  sleep 5
done
echo "VM ready"
```

---

## 5. OS Hardening

```bash
ssh cortex@10.244.7.110
```

### System updates and prerequisites

```bash
sudo apt-get update -qq && sudo apt-get upgrade -y -qq
sudo apt-get install -y -qq qemu-guest-agent curl wget jq open-iscsi nfs-common ufw
sudo systemctl enable --now qemu-guest-agent
```

### SSH hardening

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl reload ssh
```

### Firewall (UFW)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow 6443/tcp comment 'k3s API'
sudo ufw allow 80/tcp comment 'HTTP ingress'
sudo ufw allow 443/tcp comment 'HTTPS ingress'
sudo ufw allow 10250/tcp comment 'kubelet'
sudo ufw allow from 10.42.0.0/16 comment 'k3s pod CIDR'
sudo ufw allow from 10.43.0.0/16 comment 'k3s service CIDR'
echo "y" | sudo ufw enable
sudo ufw status numbered
```

---

## 6. Install k3s

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server \
  --tls-san 10.244.7.110 \
  --tls-san cortex-plane.local \
  --node-name cortex-plane \
  --write-kubeconfig-mode 644 \
  --disable servicelb \
  --kube-apiserver-arg=audit-log-maxage=30 \
  --kube-apiserver-arg=audit-log-maxbackup=3 \
  --kube-apiserver-arg=audit-log-maxsize=100" sh -
```

Key flags:

- `--tls-san`: Adds SANs for remote kubectl access via IP or hostname
- `--write-kubeconfig-mode 644`: Allows non-root kubeconfig reads
- `--disable servicelb`: Traefik uses hostPort instead (single-node, no MetalLB needed)
- Audit log rotation: 30 days, 3 backups, 100 MB max

### Patch Traefik for hostPort

Since ServiceLB is disabled, bind Traefik directly to host ports 80/443:

```bash
kubectl patch deployment traefik -n kube-system --type=json -p='[
  {"op": "add", "path": "/spec/template/spec/containers/0/ports/0/hostPort", "value": 80},
  {"op": "add", "path": "/spec/template/spec/containers/0/ports/1/hostPort", "value": 443}
]'
kubectl rollout status deployment/traefik -n kube-system --timeout=60s
```

### Create the application namespace

```bash
kubectl create namespace cortex
```

---

## 7. Verification Checklist

Run these after bootstrap to confirm readiness:

```bash
# Node healthy
kubectl get nodes -o wide
# Expected: cortex-plane  Ready  control-plane

# All system pods running
kubectl get pods -A
# Expected: coredns, traefik, local-path-provisioner, metrics-server all Running

# Storage class available
kubectl get sc
# Expected: local-path (default)

# Ingress reachable (from workstation)
curl -s -o /dev/null -w "%{http_code}" http://10.244.7.110:80   # expect 404 (no routes yet)
curl -sk -o /dev/null -w "%{http_code}" https://10.244.7.110:443 # expect 404

# API server reachable (from workstation)
curl -sk https://10.244.7.110:6443 # expect 401 (auth required)

# Resource usage
kubectl top node
```

---

## 8. Remote kubectl Access

From an operator workstation with kubectl installed:

```bash
# Copy kubeconfig, rewriting the API server address
ssh cortex@10.244.7.110 "sudo cat /etc/rancher/k3s/k3s.yaml" \
  | sed 's|127.0.0.1|10.244.7.110|g' \
  > ~/.kube/cortex-plane.yaml

export KUBECONFIG=~/.kube/cortex-plane.yaml
kubectl get nodes
```

Or use SSH tunnel if the API port is not directly reachable:

```bash
ssh -L 6443:127.0.0.1:6443 cortex@10.244.7.110 -N &
kubectl --kubeconfig=~/.kube/cortex-plane.yaml get nodes
```

---

## 9. Storage Assumptions

| Property       | Value                           |
| -------------- | ------------------------------- |
| Storage Class  | `local-path` (k3s default)      |
| Provisioner    | `rancher.io/local-path`         |
| Reclaim Policy | Delete                          |
| Binding Mode   | WaitForFirstConsumer            |
| Data Location  | `/var/lib/rancher/k3s/storage/` |
| Expansion      | Not supported                   |

The `local-path` provisioner is suitable for single-node demo deployments. PVCs for Postgres and Qdrant (10 Gi each) will bind on first pod scheduling.

**Backup strategy:** Use Proxmox VM snapshots (`qm snapshot 110 <name>`) or `pg_dump` / Qdrant snapshot API for application-level backups.

For production, consider [Longhorn](https://longhorn.io/) for replicated storage with backup integration.

---

## 10. Ingress and TLS Plan

### Current state (demo)

Traefik is the bundled k3s ingress controller, bound to hostPort 80/443 on the VM. The existing prod overlay at `deploy/k8s/overlays/prod/ingress.yaml` defines Traefik IngressRoute resources for the dashboard and control-plane.

### TLS options

| Option                        | Complexity | When to use                      |
| ----------------------------- | ---------- | -------------------------------- |
| Self-signed (Traefik default) | None       | Internal-only demos              |
| cert-manager + Let's Encrypt  | Medium     | Public-facing demo with DNS      |
| Manual TLS secret             | Low        | Known cert, no automation needed |

For a LAN demo, Traefik's default self-signed certificate is sufficient. For public-facing deployments with a real domain, install cert-manager:

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
```

Then create a ClusterIssuer and update the Ingress/IngressRoute with TLS configuration. See [k3s.md § 10](./k3s.md) for the full cert-manager setup.

---

## 11. Recovery

### VM won't boot

```bash
ssh lnx-pegasus
sudo qm status 110
sudo qm start 110
# If disk corruption, restore from snapshot:
sudo qm listsnapshot 110
sudo qm rollback 110 <snapshot-name>
```

### k3s service won't start

```bash
ssh cortex@10.244.7.110
sudo systemctl status k3s
sudo journalctl -u k3s -n 100 --no-pager
# Restart:
sudo systemctl restart k3s
```

### Full cluster rebuild

If the cluster is unrecoverable, uninstall and reinstall:

```bash
# On the VM:
sudo /usr/local/bin/k3s-uninstall.sh

# Re-run section 6 (Install k3s) above
# Re-create namespace and secrets
# Re-deploy applications per k3s.md / first-deploy.md
```

### VM rebuild from scratch

If the VM itself needs to be rebuilt:

```bash
# On lnx-pegasus:
sudo qm stop 110
sudo qm destroy 110 --purge

# Re-run sections 3-6 of this runbook
```

---

## 12. Known Limits

- **Single-node**: No HA. Node failure = full outage until recovery.
- **local-path storage**: Data lives on the node disk. No replication.
- **No external load balancer**: Traefik hostPort binds to the single VM IP.
- **No automated backups**: Must be set up separately (VM snapshots or app-level).
- **Fallback plan**: If k3s is blocked, fall back to Docker Compose on the same VM (`docker compose --profile full up -d`) or Railway PaaS. See [portability.md](./portability.md).

---

## 13. Host Resource Budget

| VM      | vCPU  | RAM      | Purpose                 |
| ------- | ----- | -------- | ----------------------- |
| 100     | 16    | 16 GB    | ollama (GPU)            |
| 101     | —     | —        | cluster-dev-4 (stopped) |
| 102     | 4×2   | 16 GB    | lnx-orion               |
| **110** | **4** | **8 GB** | **cortex-plane (k3s)**  |
| _Free_  | ~8    | ~22 GB   | Available               |

Host: 32 threads / 62 GiB total.
