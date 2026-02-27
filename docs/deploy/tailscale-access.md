# Tailscale Access: Cortex Plane Demo Endpoint

Exposes the Cortex Plane dashboard and control-plane API over Tailscale for internal demo access. No public internet exposure by default.

**Architecture:** A `tailscale-proxy` pod runs in the `cortex` namespace. It joins your Tailscale network and uses [Tailscale Serve](https://tailscale.com/kb/1312/serve) to reverse-proxy traffic to the internal ClusterIP services.

**Endpoints (after setup):**

| Service           | URL                                            |
| ----------------- | ---------------------------------------------- |
| Dashboard         | `https://cortex-demo.<tailnet>.ts.net/`        |
| Control-plane API | `https://cortex-demo.<tailnet>.ts.net/api`     |
| Health check      | `https://cortex-demo.<tailnet>.ts.net/healthz` |
| Readiness check   | `https://cortex-demo.<tailnet>.ts.net/readyz`  |

Replace `<tailnet>` with your Tailscale tailnet name (visible at https://login.tailscale.com/admin/dns).

---

## Prerequisites

| Requirement                                 | How to verify                                     |
| ------------------------------------------- | ------------------------------------------------- |
| Cortex Plane deployed and healthy           | `./scripts/smoke-test-cluster.sh cortex`          |
| Tailscale account                           | https://login.tailscale.com                       |
| HTTPS certificates enabled (for HTTPS mode) | Tailscale Admin → DNS → Enable HTTPS Certificates |
| Tailscale auth key generated                | See Step 1 below                                  |
| Operator machine on the same tailnet        | `tailscale status` shows connected                |

---

## Step 1: Generate a Tailscale auth key

Go to https://login.tailscale.com/admin/settings/keys and create a new auth key:

- **Reusable:** No (one-time is fine for a single proxy)
- **Ephemeral:** Yes (node auto-removed if proxy pod is deleted)
- **Pre-approved:** Yes (skips manual device approval)
- **Tags:** `tag:demo` (optional, for ACL policies)

Copy the key — it's shown only once.

---

## Step 2: Create the auth secret in Kubernetes

```bash
kubectl -n cortex create secret generic tailscale-auth \
  --from-literal=TS_AUTHKEY='tskey-auth-XXXXX'
```

---

## Step 3: Deploy the Tailscale proxy

```bash
# From the repo root:
kubectl apply -k deploy/k8s/tailscale-proxy/ -n cortex

# Wait for the pod to be ready
kubectl -n cortex rollout status deployment/tailscale-proxy --timeout=60s
```

Or, if deploying via the prod overlay (which includes tailscale-proxy):

```bash
kubectl apply -k deploy/k8s/overlays/prod
```

---

## Step 4: Verify the deployment

```bash
# Check pod is running
kubectl -n cortex get pods -l app=tailscale-proxy

# Check Tailscale node status
kubectl -n cortex exec deploy/tailscale-proxy -- tailscale status

# Check serve config is active
kubectl -n cortex exec deploy/tailscale-proxy -- tailscale serve status
```

---

## Step 5: Test access from your machine

Your machine must be on the same Tailscale network.

```bash
# Verify you can see the node
tailscale status | grep cortex-demo

# Test dashboard
curl -sf https://cortex-demo.<tailnet>.ts.net/

# Test API health
curl -sf https://cortex-demo.<tailnet>.ts.net/healthz

# Test API readiness
curl -sf https://cortex-demo.<tailnet>.ts.net/readyz
```

Or open `https://cortex-demo.<tailnet>.ts.net/` in your browser.

---

## Step 6: Run the full verification script

```bash
./scripts/tailscale-verify.sh cortex cortex-demo
```

This checks pod health, Tailscale connectivity, service routing, and security boundaries.

---

## HTTP-Only Mode (no HTTPS cert setup)

If you haven't enabled HTTPS certificates in Tailscale admin, switch to HTTP mode:

1. Edit `deploy/k8s/tailscale-proxy/configmap.yaml`
2. In the `serve-config.json` key, replace the HTTPS config with the HTTP alternative:

```json
{
  "TCP": {
    "80": {
      "HTTP": true
    }
  },
  "Web": {
    "${TS_CERT_DOMAIN}:80": {
      "Handlers": {
        "/": {
          "Proxy": "http://dashboard.cortex.svc.cluster.local:3000"
        },
        "/api": {
          "Proxy": "http://control-plane.cortex.svc.cluster.local:4000"
        },
        "/healthz": {
          "Proxy": "http://control-plane.cortex.svc.cluster.local:4000"
        },
        "/readyz": {
          "Proxy": "http://control-plane.cortex.svc.cluster.local:4000"
        }
      }
    }
  }
}
```

3. Re-apply: `kubectl apply -k deploy/k8s/tailscale-proxy/ -n cortex`
4. Restart the pod: `kubectl -n cortex rollout restart deployment/tailscale-proxy`

Access via `http://cortex-demo.<tailnet>.ts.net/` (HTTP). Traffic is still encrypted by WireGuard at the network layer.

---

## Optional: Public Exposure via Tailscale Funnel

> **Warning:** This makes the endpoint accessible from the public internet. Only enable for demos where external viewers need access.

Tailscale Funnel extends Serve to allow public internet access through Tailscale's infrastructure.

### Enable Funnel

1. Enable Funnel in Tailscale ACL policy:

   ```json
   {
     "nodeAttrs": [
       {
         "target": ["tag:demo"],
         "attr": ["funnel"]
       }
     ]
   }
   ```

2. Update the serve config to enable Funnel (`AllowFunnel: true`):

   ```json
   {
     "AllowFunnel": {
       "${TS_CERT_DOMAIN}:443": true
     },
     "TCP": {
       "443": {
         "HTTPS": true
       }
     },
     "Web": {
       "${TS_CERT_DOMAIN}:443": {
         "Handlers": {
           "/": {
             "Proxy": "http://dashboard.cortex.svc.cluster.local:3000"
           },
           "/api": {
             "Proxy": "http://control-plane.cortex.svc.cluster.local:4000"
           }
         }
       }
     }
   }
   ```

3. Re-apply and restart: `kubectl -n cortex rollout restart deployment/tailscale-proxy`

4. The endpoint is now reachable at `https://cortex-demo.<tailnet>.ts.net/` from any browser.

### Disable Funnel (rollback to internal-only)

Remove the `AllowFunnel` block from the serve config, re-apply, and restart the pod:

```bash
kubectl -n cortex rollout restart deployment/tailscale-proxy
```

---

## Security Checks

### Verify no public exposure (internal-only mode)

```bash
# 1. Tailscale IP should be in CGNAT range (100.64.0.0/10)
kubectl -n cortex exec deploy/tailscale-proxy -- tailscale ip -4
# Expected: 100.x.x.x

# 2. Services should NOT be accessible via the VM's public/LAN IP
#    Replace with your node IP, or set CORTEX_VM_IP env var
NODE_IP="${CORTEX_VM_IP:-$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')}"
curl --max-time 3 "http://${NODE_IP}:3000/" 2>&1 || echo "Not reachable (expected)"
curl --max-time 3 "http://${NODE_IP}:4000/healthz" 2>&1 || echo "Not reachable (expected)"

# 3. No NodePort services exposed
kubectl -n cortex get svc -o wide
# All services should be ClusterIP type

# 4. Tailscale Funnel should be OFF
kubectl -n cortex exec deploy/tailscale-proxy -- tailscale serve status
# Should NOT show "Funnel on"
```

### ACL Lockdown (recommended for production)

Restrict which Tailscale users/devices can reach the demo endpoint:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["group:demo-viewers"],
      "dst": ["tag:demo:443"]
    }
  ],
  "tagOwners": {
    "tag:demo": ["autogroup:admin"]
  },
  "groups": {
    "group:demo-viewers": ["user@example.com"]
  }
}
```

---

## Rollback / Remove

### Remove the Tailscale proxy (keep other services running)

```bash
kubectl -n cortex delete -k deploy/k8s/tailscale-proxy/
kubectl -n cortex delete secret tailscale-auth tailscale-state
```

The Tailscale node will be automatically removed from your tailnet if the auth key was ephemeral. Otherwise, remove it manually at https://login.tailscale.com/admin/machines.

### Remove from prod overlay

Edit `deploy/k8s/overlays/prod/kustomization.yaml` and remove the `../../tailscale-proxy` resource line.

---

## Troubleshooting

### Pod stuck in CrashLoopBackOff

```bash
kubectl -n cortex logs deploy/tailscale-proxy
```

**Common causes:**

- `tailscale-auth` secret missing or invalid key → check Step 2
- Auth key expired → generate a new one in Tailscale admin
- `/dev/net/tun` not available → verify the k3s host has TUN device support

### Tailscale node shows "offline"

```bash
kubectl -n cortex exec deploy/tailscale-proxy -- tailscale status
```

**Fix:** Check that the k3s node has outbound internet access (Tailscale needs to reach coordination servers). Verify: `kubectl -n cortex exec deploy/tailscale-proxy -- wget -qO- https://controlplane.tailscale.com/`

### Serve not routing traffic

```bash
kubectl -n cortex exec deploy/tailscale-proxy -- tailscale serve status
```

**Fix:** Verify the serve config JSON is valid. Check that the backend services are reachable from the pod:

```bash
kubectl -n cortex exec deploy/tailscale-proxy -- wget -qO- http://dashboard:3000/ 2>&1 | head -5
kubectl -n cortex exec deploy/tailscale-proxy -- wget -qO- http://control-plane:4000/healthz 2>&1 | head -5
```

### HTTPS certificate errors

HTTPS certificates require:

1. MagicDNS enabled in Tailscale admin → DNS settings
2. HTTPS certificates enabled in Tailscale admin → DNS settings
3. The node must be online for at least a few seconds to provision the cert

If certs fail, switch to HTTP-only mode (see above).

---

## Architecture Overview

```
Tailscale Client (your laptop)
        │
        │  WireGuard tunnel (encrypted)
        │
        ▼
┌─────────────────────────────┐
│  tailscale-proxy pod        │
│  (cortex namespace)         │
│                             │
│  tailscale serve:           │
│    /     → dashboard:3000   │
│    /api  → ctrl-plane:4000  │
│    /healthz → ctrl-plane    │
│    /readyz  → ctrl-plane    │
└──────────┬──────────────────┘
           │  ClusterIP (k8s internal)
           ▼
    ┌──────────────┐    ┌─────────────────┐
    │  dashboard   │    │  control-plane  │
    │  :3000       │    │  :4000          │
    └──────────────┘    └─────────────────┘
```

All traffic between the Tailscale client and the proxy pod is encrypted via WireGuard. The proxy pod communicates with internal services over the k8s cluster network.
