# PostgreSQL HA Runbook (CloudNativePG)

This runbook covers health probes, failover operations, and backup/PITR for the CNPG-backed PostgreSQL cluster.

## Scope

- Namespace: `cortex` (default)
- Cluster: `postgresql`
- App DB endpoint: `postgresql-rw-pooler:5432`
- DB name: `cortex_plane`

## Manifests

- CNPG cluster + WAL archiving: `deploy/k8s/postgresql/cluster.yaml`
- PgBouncer pooler: `deploy/k8s/postgresql/pooler.yaml`
- Daily scheduled backup: `deploy/k8s/postgresql/scheduled-backup.yaml`
- PITR template: `deploy/k8s/postgresql/pitr-restore.example.yaml`

Apply with:

```bash
kubectl apply -k deploy/k8s/postgresql -n cortex
```

## Readiness/Liveness Probes

CNPG manages pod liveness/readiness for PostgreSQL instances and pooler pods. In addition, use the following operational probes:

1. Cluster readiness:

```bash
kubectl -n cortex wait --for=condition=Ready cluster/postgresql --timeout=120s
```

2. Primary socket readiness:

```bash
PRIMARY=$(kubectl -n cortex get cluster/postgresql -o jsonpath='{.status.currentPrimary}')
kubectl -n cortex exec "$PRIMARY" -- pg_isready -U postgres -d cortex_plane
```

3. Pooler service readiness (app path):

```bash
kubectl -n cortex run pg-probe --rm -i --restart=Never \
  --image=postgres:17-bookworm -- \
  pg_isready -h postgresql-rw-pooler -p 5432 -U cortex -d cortex_plane
```

4. Control-plane liveness/readiness (queue consumer + API):

```bash
kubectl -n cortex get pods -l app=control-plane
kubectl -n cortex port-forward svc/control-plane 4000:4000
curl -f http://127.0.0.1:4000/healthz
curl -f http://127.0.0.1:4000/readyz
```

## Planned Failover Procedure

1. Capture current primary:

```bash
kubectl -n cortex get cluster/postgresql -o jsonpath='{.status.currentPrimary}'; echo
```

2. Trigger failover (safe simulation):

```bash
PRIMARY=$(kubectl -n cortex get cluster/postgresql -o jsonpath='{.status.currentPrimary}')
kubectl -n cortex delete pod "$PRIMARY" --wait=false
```

3. Watch election and recovery:

```bash
watch -n 2 "kubectl -n cortex get cluster/postgresql -o jsonpath='{.status.currentPrimary}{\"\n\"}{.status.phase}{\"\n\"}'"
kubectl -n cortex wait --for=condition=Ready cluster/postgresql --timeout=120s
```

4. Validate app path:

```bash
kubectl -n cortex port-forward svc/control-plane 4000:4000
curl -f http://127.0.0.1:4000/readyz
```

5. Validate worker continuity:

```bash
./scripts/test-pg-failover.sh cortex postgresql
```

## Backup Strategy

- WAL archiving: continuous WAL shipping via `spec.backup.barmanObjectStore` to S3/MinIO.
- Full logical backup cadence: `ScheduledBackup/postgresql-daily` runs daily at 02:00 UTC.
- Retention: 7 days (`retentionPolicy: 7d`).

Check backup status:

```bash
kubectl -n cortex get backups.postgresql.cnpg.io
kubectl -n cortex get scheduledbackup/postgresql-daily -o yaml
```

## PITR Procedure

1. Copy `deploy/k8s/postgresql/pitr-restore.example.yaml` to a new manifest.
2. Set `spec.bootstrap.recovery.recoveryTarget.targetTime` to a UTC timestamp before data corruption.
3. Apply restore cluster.
4. Wait for restore cluster readiness.
5. Validate data.
6. Repoint app `DATABASE_URL` to the restore pooler endpoint.

Example:

```bash
kubectl apply -f deploy/k8s/postgresql/pitr-restore.example.yaml -n cortex
kubectl -n cortex wait --for=condition=Ready cluster/postgresql-restore --timeout=300s
```

## Failure Signals and Immediate Actions

1. `cluster/postgresql` not Ready for >5 minutes:
- Check events: `kubectl -n cortex describe cluster/postgresql`
- Check pods: `kubectl -n cortex get pods -l cnpg.io/cluster=postgresql`
- Check operator logs in CNPG namespace.

2. Control-plane `/readyz` failing after failover:
- Confirm pooler service exists and has endpoints.
- Confirm `DATABASE_URL` points to `postgresql-rw-pooler`.
- Restart control-plane deployment once DB is healthy.

3. Backups failing:
- Validate `postgresql-backup-s3` credentials.
- Verify MinIO/S3 endpoint reachability and bucket policy.
