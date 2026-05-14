# Optional infrastructure

These files are **not applied** with the main `infra/terraform/` voice-broadcaster setup.
They live here for reference and future use.

## cloud-run.tf

Deploys `packages/server` (the TypeScript admin panel + API) to Cloud Run with:
- Cloud SQL (Postgres) for conversation storage
- Memorystore Redis for session caching
- VPC Access connector for private networking
- Managed SSL via Cloud Run custom domain

**Do not merge this into `infra/terraform/` unless you are intentionally migrating
the admin panel to Cloud Run.** Applying it creates ~$200/mo of additional infrastructure.

To use: copy to `infra/terraform/`, add the required variables, and run `terraform apply`.

## cloudbuild.yaml

Cloud Build pipeline that builds the Docker image for `packages/server`,
pushes to Artifact Registry, and deploys to Cloud Run on every push to `main`.

To activate: create a Cloud Build trigger in the GCP Console pointing at this file.
