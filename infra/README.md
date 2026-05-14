# Infrastructure

Terraform + systemd units for the GCP VM that hosts the xspace-agent voice broadcaster.

## Layout

```
infra/
  terraform/
    main.tf                    GCP resources: VM, SA, firewall, monitoring alerts
    variables.tf               Input variables
    outputs.tf                 Outputs: external IP, SSH command, dashboard URL
    startup.sh                 VM startup script (runs on boot, idempotent)
    terraform.tfvars.example   Copy to terraform.tfvars and fill in
    .gitignore                 Excludes state, .terraform/, tfvars (contain secrets)
  systemd/
    swarm-server.service       Node server (auto-restart, journal logging, graceful drain)
    xvfb.service               Virtual display :99 for headless Chrome
```

## First-time setup

### Prerequisites

```bash
# Terraform >= 1.5
brew install terraform           # macOS
# or https://developer.hashicorp.com/terraform/install

# gcloud CLI authenticated
gcloud auth application-default login
gcloud config set project aerial-vehicle-466722-p5
```

### Configure

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit: set your ssh_public_key and alert_email at minimum
```

### Apply

```bash
terraform init
terraform plan -out=tfplan    # review before applying
terraform apply tfplan
```

Terraform outputs the external IP and a ready-to-paste SSH command.

## Deploying code changes

From any machine with `gcloud` authenticated:

```bash
./scripts/deploy.sh              # pull + pnpm install + graceful restart
./scripts/deploy.sh --status     # show agent status, no deploy
./scripts/deploy.sh --rollback <sha>
```

## Installing systemd units on the VM

`startup.sh` handles this automatically on first boot. Manual install:

```bash
sudo cp infra/systemd/swarm-server.service /etc/systemd/system/
sudo cp infra/systemd/xvfb.service         /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now swarm-server xvfb
```

Secrets live in `/home/agent/.env` on the VM only — the service loads them via
`EnvironmentFile`. They never touch this repo.

## GCP Monitoring alerts (created by Terraform)

- CPU > 85% for 5 min
- VM unreachable (uptime check fails)

Both send email to `var.alert_email`. View in GCP Console → Monitoring → Alerting.

## Cost estimates (us-central1-a, 2026)

| Resource | 24/7 | Show-only (spot) |
|---|---|---|
| n2-standard-4 VM | ~$140/mo | ~$30/mo |
| 50 GB SSD | ~$9/mo | ~$9/mo |
| Static IP | ~$7/mo | ~$7/mo |
| Network egress | ~$5/mo | ~$2/mo |

Set `scheduling_preemptible = true` in `terraform.tfvars` for spot pricing.
