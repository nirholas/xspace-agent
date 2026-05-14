###############################################################################
# Cloud Run — @xspace/server (admin panel + API + webhook receiver)
###############################################################################

locals {
  image = "${var.region}-docker.pkg.dev/${var.project_id}/xspace-server/server:latest"
}

resource "google_cloud_run_v2_service" "server" {
  name     = "xspace-server"
  location = var.region

  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.cloud_run_sa.email

    scaling {
      min_instance_count = 1   # Always-warm — no cold starts in prod
      max_instance_count = 20  # Scale out under load
    }

    # Connect to private VPC (Cloud SQL + Redis)
    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.image

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle          = true  # CPU only allocated during request handling
        startup_cpu_boost = true  # Extra CPU during cold start
      }

      ports {
        name           = "http1"
        container_port = 3000
      }

      # ── Environment variables ──────────────────────────────────────────────

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "PORT"
        value = "3000"
      }

      env {
        name  = "HEADLESS"
        value = "true"
      }

      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }

      env {
        name  = "GCP_REGION"
        value = var.region
      }

      env {
        name  = "APP_URL"
        value = "https://${var.app_domain}"
      }

      # ── Secrets from Secret Manager ────────────────────────────────────────

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "REDIS_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.redis_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "ADMIN_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["admin-api-key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "STRIPE_SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["stripe-secret-key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "STRIPE_WEBHOOK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["stripe-webhook-secret"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "STRIPE_PRICE_DEVELOPER"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["stripe-price-developer"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "STRIPE_PRICE_PRO"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["stripe-price-pro"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "STRIPE_PRICE_BUSINESS"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["stripe-price-business"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["openai-api-key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "ANTHROPIC_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["anthropic-api-key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GROQ_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["groq-api-key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "ELEVENLABS_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["elevenlabs-api-key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "X_AUTH_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["x-auth-token"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "X_CT0"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["x-ct0"].secret_id
            version = "latest"
          }
        }
      }

      # ── Health check ───────────────────────────────────────────────────────

      startup_probe {
        http_get {
          path = "/health"
          port = 3000
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        failure_threshold     = 5
        timeout_seconds       = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 3000
        }
        period_seconds    = 30
        failure_threshold = 3
        timeout_seconds   = 5
      }
    }
  }

  depends_on = [
    google_artifact_registry_repository.server,
    google_vpc_access_connector.connector,
    google_project_service.apis["run.googleapis.com"],
  ]
}

# Allow public unauthenticated access (API key auth is handled by the app)
resource "google_cloud_run_v2_service_iam_member" "public" {
  location = google_cloud_run_v2_service.server.location
  name     = google_cloud_run_v2_service.server.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

###############################################################################
# Cloud Run — Per-tenant agent runners (one service per hosted agent)
# These are created dynamically by the deployment manager, not statically here.
# The template below is referenced by lifecycle-manager-cloudrun.ts.
###############################################################################

# Agent runner image (same repo, different tag/service)
# Deployment manager creates google_cloud_run_v2_service resources via API calls.
