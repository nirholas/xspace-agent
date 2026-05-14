###############################################################################
# Artifact Registry — Docker repository
#
# Hosts xspace-agent container images.
# Cleanup policy: keep the 10 most recent tagged versions, purge untagged.
###############################################################################

resource "google_artifact_registry_repository" "docker" {
  provider = google-beta

  repository_id = local.name_prefix
  location      = var.region
  format        = "DOCKER"
  description   = "xspace-agent Docker images"

  labels = local.common_labels

  # Cleanup policy — prevents unbounded storage growth
  cleanup_policies {
    id     = "keep-10-latest"
    action = "KEEP"

    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"

    condition {
      tag_state = "UNTAGGED"
    }
  }

  depends_on = [google_project_service.apis]
}

# Grant the GKE service account pull access to the registry
resource "google_artifact_registry_repository_iam_member" "gke_reader" {
  provider = google-beta

  location   = google_artifact_registry_repository.docker.location
  repository = google_artifact_registry_repository.docker.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.xspace_agent_sa.email}"
}

# Grant Cloud Build push access for CI/CD pipelines
resource "google_artifact_registry_repository_iam_member" "cloudbuild_writer" {
  provider = google-beta

  location   = google_artifact_registry_repository.docker.location
  repository = google_artifact_registry_repository.docker.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${data.google_project.project.number}@cloudbuild.gserviceaccount.com"
}

data "google_project" "project" {
  depends_on = [google_project_service.apis]
}
