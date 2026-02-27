# Self-Hosted GitHub Actions Deploys on k3s

This runbook configures a private self-hosted GitHub Actions runner on your k3s VM so `main` pushes can deploy `deploy/k8s/overlays/prod` automatically.

## 1. Prerequisites

- A private k3s VM with cluster access for the runner user.
- Repository admin access in `noncelogic/cortex-plane`.
- Existing prod namespace `cortex` and app secrets.
- `ghcr-secret` in namespace `cortex` so workloads can pull private images.

## 2. Install Runner on the k3s VM

Run as a non-root user dedicated to automation.

```bash
sudo apt update
sudo apt install -y curl jq ca-certificates

mkdir -p ~/actions-runner && cd ~/actions-runner
# Replace with the latest release URL from GitHub Actions runner releases.
curl -L -o actions-runner.tar.gz \
  https://github.com/actions/runner/releases/download/v2.325.0/actions-runner-linux-x64-2.325.0.tar.gz
tar xzf actions-runner.tar.gz
```

In GitHub: `Settings -> Actions -> Runners -> New self-hosted runner`, then use the generated configure command. Example:

```bash
./config.sh \
  --url https://github.com/noncelogic/cortex-plane \
  --token <registration-token> \
  --labels self-hosted,linux,cortex-k3s \
  --name cortex-k3s-runner
```

Install and start as a service:

```bash
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

## 3. Configure kubeconfig for the Runner

Use one of these approaches:

1. Recommended: put kubeconfig at `/home/<runner-user>/.kube/config` with access to namespace `cortex`.
2. Optional fallback: add repo secret `K3S_KUBECONFIG` (full kubeconfig YAML). Workflow writes this to a temporary file.

For local kubeconfig on the VM:

```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $(id -u):$(id -g) ~/.kube/config
```

If needed, edit the kubeconfig server address from `127.0.0.1` to the VM IP.

## 4. Required Cluster Secrets and Objects

The deploy workflow assumes these are already present in namespace `cortex`:

- `control-plane-secrets`
- `postgresql-app`
- `postgresql-backup-s3` (if backups enabled)
- `ghcr-secret` (image pull secret for GHCR)

Example `ghcr-secret` creation:

```bash
kubectl -n cortex create secret docker-registry ghcr-secret \
  --docker-server=ghcr.io \
  --docker-username=<github-username> \
  --docker-password=<github-classic-pat-or-fine-grained-token> \
  --docker-email=<email>
```

## 5. Workflow Environment and Permissions

Workflow file: `.github/workflows/deploy-self-hosted.yml`

- Trigger: push to `main` and manual dispatch.
- Runner labels: `self-hosted`, `linux`, `cortex-k3s`.
- Namespace: `cortex`.
- Overlay: `deploy/k8s/overlays/prod`.
- Image tags: immutable SHA-based tags from `${GITHUB_SHA}`.

Required workflow permissions:

- `contents: read`
- `packages: read`

## 6. Deploy Sequence Per Run

The workflow executes `scripts/deploy-k3s.sh`, which:

1. Pins `control-plane` and `dashboard` images to commit SHA tags.
2. Pins `playwright-sidecar` tag too when that image exists in rendered manifests.
3. Applies `deploy/k8s/overlays/prod` with `kubectl apply -k`.
4. Waits for rollout status on key deployments in namespace `cortex`.
5. Runs smoke checks:
   - `control-plane /healthz`
   - `control-plane /readyz`
   - `dashboard /`

## 7. Operational Notes

- Keep the runner private to your trusted network.
- For long-term security, prefer ephemeral registration tokens and rotate PATs used by `ghcr-secret`.
- If deploy fails with image pull errors, verify the image for that commit SHA was published and `ghcr-secret` is valid.
