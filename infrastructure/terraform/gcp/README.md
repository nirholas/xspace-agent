# xspace-agent GCP Infrastructure

Terraform for migrating xspace-agent from Railway to GCP.
Stack: GKE Autopilot + Cloud SQL (PostgreSQL 15) + Memorystore (Redis 7) + Artifact Registry + Cloud Run + Secret Manager.

## Prerequisites

- Terraform >= 1.5 — `brew install terraform` or [tfenv](https://github.com/tfutils/tfenv)
- gcloud CLI authenticated: `gcloud auth application-default login`
- Project billing enabled with $110k credit
- Project ID: `aerial-vehicle-466722-p5` (already set as default)

## Quick Setup

### 1. Initialize

```bash
cd infrastructure/terraform/gcp
terraform init
```

### 2. Review the plan

```bash
terraform plan -out=tfplan
```

The first apply takes ~15 minutes (GKE cluster + Cloud SQL are slow to provision).

### 3. Apply

```bash
terraform apply tfplan
```

### 4. Push secrets after apply

Secrets are created empty. Populate them with your values:

```bash
# AI provider keys
gcloud secrets versions add xspace-agent-openai-api-key      --data-file=- <<< "sk-..."
gcloud secrets versions add xspace-agent-anthropic-api-key   --data-file=- <<< "sk-ant-..."
gcloud secrets versions add xspace-agent-groq-api-key        --data-file=- <<< "gsk_..."
gcloud secrets versions add xspace-agent-elevenlabs-api-key  --data-file=- <<< "..."

# X (Twitter) cookie auth
gcloud secrets versions add xspace-agent-x-auth-token        --data-file=- <<< "..."
gcloud secrets versions add xspace-agent-x-ct0               --data-file=- <<< "..."

# Admin panel
gcloud secrets versions add xspace-agent-admin-api-key       --data-file=- <<< "$(openssl rand -hex 32)"
gcloud secrets versions add xspace-agent-cookie-encryption-key --data-file=- <<< "$(openssl rand -hex 32)"

# Optional Google API key (for Google TTS / Gemini)
gcloud secrets versions add xspace-agent-google-api-key      --data-file=- <<< "..."
```

`db_password` and `redis_auth_string` are auto-populated by Terraform.

### 5. Get kubeconfig

```bash
$(terraform output -raw kubeconfig_command)
# or manually:
gcloud container clusters get-credentials xspace-agent \
  --region us-central1 \
  --project aerial-vehicle-466722-p5
```

### 6. Deploy Kubernetes manifests

```bash
# Update PROJECT_ID placeholders in the manifests first
sed -i 's/PROJECT_ID/aerial-vehicle-466722-p5/g' \
  ../../k8s/service-account.yaml \
  ../../k8s/deployment.yaml

kubectl apply -f ../../k8s/namespace.yaml
kubectl apply -f ../../k8s/service-account.yaml
kubectl apply -f ../../k8s/deployment.yaml
kubectl apply -f ../../k8s/service.yaml
kubectl apply -f ../../k8s/hpa.yaml
kubectl apply -f ../../k8s/ingress.yaml
```

## Pushing Docker Images

```bash
# Authenticate Docker to Artifact Registry
gcloud auth configure-docker us-central1-docker.pkg.dev

# Build and push
docker build -t us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/xspace-agent/server:latest .
docker push    us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/xspace-agent/server:latest
```

## On-demand Sessions via Cloud Run

The Cloud Run service (`xspace-agent-ondemand`) scales to zero when idle and
handles one Space session per instance. Get its URL:

```bash
terraform output cloud_run_url
```

## State Backend (optional but recommended)

Uncomment the `backend "gcs"` block in `main.tf` and create the bucket first:

```bash
gsutil mb -p aerial-vehicle-466722-p5 -l us-central1 gs://aerial-vehicle-466722-p5-tfstate
gsutil versioning set on gs://aerial-vehicle-466722-p5-tfstate
terraform init -migrate-state
```

## Destroy

The Cloud SQL instance has `deletion_protection = true`. To destroy:

1. First remove the protection: `terraform state rm google_sql_database_instance.postgres` or temporarily set `deletion_protection = false` and re-apply.
2. Then `terraform destroy`.
