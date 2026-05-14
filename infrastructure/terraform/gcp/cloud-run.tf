###############################################################################
# Cloud Run — On-demand X Space sessions
#
# Each instance handles exactly one concurrent Space session (concurrency = 1).
# Scale-to-zero when idle; scales out instantly on new session requests.
# All secrets injected as environment variables from Secret Manager.
###############################################################################

resource "google_cloud_run_v2_service" "xspace_agent_ondemand" {
  provider = google-beta

  name     = "${local.name_prefix}-ondemand"
  location = var.region

  description = "xspace-agent on-demand Space sessions — one session per instance"

  template {
    service_account = google_service_account.xspace_agent_sa.email

    # One Space session per container instance — prevents audio pipeline conflicts
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0   # Scale to zero when idle
      max_instance_count = 100 # Adjust based on expected concurrent sessions
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/${local.name_prefix}/server:latest"

      resources {
        limits = {
          cpu    = "2"
          memory = "4Gi"
        }
        # CPU is always allocated (not just during request) — required for audio processing
        cpu_idle = false
        startup_cpu_boost = true
      }

      ports {
        container_port = 3000
      }

      # -----------------------------------------------------------------------
      # Environment variables from Secret Manager
      # Each secret must have at least one version before the service starts.
      # -----------------------------------------------------------------------

      env {
        name  = "NODE_ENV"
        value = var.environment
      }

      env {
        name  = "PORT"
        value = "3000"
      }

      env {
        name  = "AI_PROVIDER"
        value = "openai"
      }

      env {
        name  = "TTS_PROVIDER"
        value = "elevenlabs"
      }

      env {
        name  = "STT_PROVIDER"
        value = "groq"
      }

      env {
        name  = "HEADLESS"
        value = "true"
      }

      # Manual secrets (from local.manual_secrets in secret-manager.tf)
      dynamic "env" {
        for_each = {
          OPENAI_API_KEY        = "openai-api-key"
          ANTHROPIC_API_KEY     = "anthropic-api-key"
          GROQ_API_KEY          = "groq-api-key"
          ELEVENLABS_API_KEY    = "elevenlabs-api-key"
          X_AUTH_TOKEN          = "x-auth-token"
          X_CT0                 = "x-ct0"
          ADMIN_API_KEY         = "admin-api-key"
          COOKIE_ENCRYPTION_KEY = "cookie-encryption-key"
          GOOGLE_API_KEY        = "google-api-key"
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app_secrets[env.value].name
              version = "latest"
            }
          }
        }
      }

      # Auto-populated secrets (db_password + redis_auth_string)
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_password.name
            version = "latest"
          }
        }
      }

      env {
        name = "REDIS_AUTH_STRING"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.redis_auth_string.name
            version = "latest"
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 10
        timeout_seconds       = 5
        period_seconds        = 10
        failure_threshold     = 3

        http_get {
          path = "/health"
          port = 3000
        }
      }

      liveness_probe {
        initial_delay_seconds = 15
        period_seconds        = 30
        timeout_seconds       = 5
        failure_threshold     = 3

        http_get {
          path = "/health"
          port = 3000
        }
      }
    }

    # VPC connector allows Cloud Run instances to reach private Cloud SQL and Redis
    vpc_access {
      network_interfaces {
        network    = google_compute_network.vpc.name
        subnetwork = google_compute_subnetwork.subnet.name
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
  }

  labels = local.common_labels

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image, # Updated by CI/CD, not Terraform
    ]
  }

  depends_on = [
    google_project_service.apis,
    google_service_account.xspace_agent_sa,
    google_secret_manager_secret.app_secrets,
    google_secret_manager_secret.db_password,
    google_secret_manager_secret.redis_auth_string,
  ]
}

# Allow unauthenticated invocations (public API endpoint)
# Remove this if the service should require IAM auth
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.xspace_agent_ondemand.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
