###############################################################################
# Secret Manager — Application Secrets
#
# All secrets are created empty. Populate manually after `terraform apply`:
#
#   gcloud secrets versions add openai-api-key --data-file=- <<< "sk-..."
#   gcloud secrets versions add x-auth-token    --data-file=- <<< "..."
#
# db_password and redis_auth_string are auto-populated by their respective
# resource modules (cloud-sql.tf and memorystore.tf).
###############################################################################

locals {
  # Secrets that must be set manually after apply
  manual_secrets = toset([
    "openai-api-key",
    "anthropic-api-key",
    "groq-api-key",
    "elevenlabs-api-key",
    "x-auth-token",
    "x-ct0",
    "admin-api-key",
    "cookie-encryption-key",
    "google-api-key",
  ])
}

# Secrets auto-populated by other resources in this module
resource "google_secret_manager_secret" "db_password" {
  secret_id = "${local.name_prefix}-db-password"
  labels    = local.common_labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "redis_auth_string" {
  secret_id = "${local.name_prefix}-redis-auth-string"
  labels    = local.common_labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

# Dynamically create all remaining secrets
resource "google_secret_manager_secret" "app_secrets" {
  for_each = local.manual_secrets

  secret_id = "${local.name_prefix}-${each.key}"
  labels    = local.common_labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

###############################################################################
# IAM — Grant GKE workload identity SA read access to all secrets
###############################################################################

# Access to auto-populated secrets
resource "google_secret_manager_secret_iam_member" "sa_db_password" {
  secret_id = google_secret_manager_secret.db_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.xspace_agent_sa.email}"
}

resource "google_secret_manager_secret_iam_member" "sa_redis_auth" {
  secret_id = google_secret_manager_secret.redis_auth_string.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.xspace_agent_sa.email}"
}

# Access to all manually-set secrets
resource "google_secret_manager_secret_iam_member" "sa_app_secrets" {
  for_each = local.manual_secrets

  secret_id = google_secret_manager_secret.app_secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.xspace_agent_sa.email}"
}
