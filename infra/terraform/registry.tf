###############################################################################
# Artifact Registry — Docker image repository
###############################################################################

resource "google_artifact_registry_repository" "server" {
  location      = var.region
  repository_id = "xspace-server"
  description   = "Docker images for @xspace/server"
  format        = "DOCKER"

  labels = {
    app         = "xspace-agent"
    environment = "production"
  }

  depends_on = [google_project_service.apis["artifactregistry.googleapis.com"]]
}

# Grant Cloud Run SA pull access
resource "google_artifact_registry_repository_iam_member" "cloud_run_reader" {
  location   = google_artifact_registry_repository.server.location
  repository = google_artifact_registry_repository.server.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.cloud_run_sa.email}"
}

# Grant Cloud Build SA push access
resource "google_artifact_registry_repository_iam_member" "cloud_build_writer" {
  location   = google_artifact_registry_repository.server.location
  repository = google_artifact_registry_repository.server.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.cloud_build_sa.email}"
}

###############################################################################
# Service accounts for Cloud Run + Cloud Build (used by multiple .tf files)
###############################################################################

resource "google_service_account" "cloud_run_sa" {
  account_id   = "xspace-cloud-run"
  display_name = "xspace-agent Cloud Run SA"
  description  = "Runs the @xspace/server container on Cloud Run"
}

resource "google_service_account" "cloud_build_sa" {
  account_id   = "xspace-cloud-build"
  display_name = "xspace-agent Cloud Build SA"
  description  = "Builds and deploys the @xspace/server container"
}

# Cloud Run SA permissions
resource "google_project_iam_member" "cloud_run_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.cloud_run_sa.email}"
}

resource "google_project_iam_member" "cloud_run_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.cloud_run_sa.email}"
}

resource "google_project_iam_member" "cloud_run_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.cloud_run_sa.email}"
}

resource "google_project_iam_member" "cloud_run_trace_agent" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.cloud_run_sa.email}"
}

resource "google_project_iam_member" "cloud_run_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.cloud_run_sa.email}"
}

# Cloud Build SA permissions
resource "google_project_iam_member" "cloud_build_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.cloud_build_sa.email}"
}

resource "google_project_iam_member" "cloud_build_sa_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.cloud_build_sa.email}"
}
