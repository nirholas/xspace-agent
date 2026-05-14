###############################################################################
# IAM — Service Accounts and Role Bindings
###############################################################################

# Primary application service account used by GKE workloads and Cloud Run
resource "google_service_account" "xspace_agent_sa" {
  account_id   = local.sa_account_id
  display_name = "xspace-agent application service account"
  description  = "Used by GKE Pods (Workload Identity) and Cloud Run for all app operations"

  depends_on = [google_project_service.apis]
}

###############################################################################
# Project-level IAM roles for the service account
###############################################################################

locals {
  sa_roles = [
    "roles/secretmanager.secretAccessor",  # Read secrets from Secret Manager
    "roles/cloudsql.client",               # Connect to Cloud SQL via Cloud SQL Auth Proxy
    "roles/monitoring.metricWriter",       # Publish custom metrics to Cloud Monitoring
    "roles/logging.logWriter",             # Write structured logs to Cloud Logging
    "roles/artifactregistry.reader",       # Pull images from Artifact Registry
  ]
}

resource "google_project_iam_member" "sa_roles" {
  for_each = toset(local.sa_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.xspace_agent_sa.email}"
}

###############################################################################
# Workload Identity binding
#
# Allows the Kubernetes service account (KSA) in the xspace-agent namespace
# to impersonate the GCP service account without mounting key files.
# The KSA is created separately in infrastructure/k8s/service-account.yaml.
###############################################################################

resource "google_service_account_iam_member" "workload_identity_binding" {
  service_account_id = google_service_account.xspace_agent_sa.name
  role               = "roles/iam.workloadIdentityUser"

  # Format: serviceAccount:PROJECT.svc.id.goog[NAMESPACE/KSA_NAME]
  member = "serviceAccount:${var.project_id}.svc.id.goog[xspace-agent/xspace-agent-sa]"

  depends_on = [
    google_container_cluster.primary,
    google_project_service.apis,
  ]
}
