###############################################################################
# Secret Manager — Application secrets (populate manually after tf apply)
###############################################################################

locals {
  app_secrets = {
    "stripe-secret-key"        = "Stripe sk_live_... key"
    "stripe-webhook-secret"    = "Stripe whsec_... webhook secret"
    "stripe-price-developer"   = "Stripe price ID for Developer plan"
    "stripe-price-pro"         = "Stripe price ID for Pro plan"
    "stripe-price-business"    = "Stripe price ID for Business plan"
    "admin-api-key"            = "Admin panel API key"
    "openai-api-key"           = "OpenAI API key"
    "anthropic-api-key"        = "Anthropic API key"
    "groq-api-key"             = "Groq API key"
    "elevenlabs-api-key"       = "ElevenLabs API key"
    "x-auth-token"             = "X auth_token cookie"
    "x-ct0"                    = "X ct0 cookie"
  }
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.app_secrets
  secret_id = each.key
  replication { auto {} }
  labels = { app = "xspace-agent"; managed-by = "terraform" }
}

resource "google_secret_manager_secret_iam_member" "cloud_run_access" {
  for_each  = local.app_secrets
  secret_id = google_secret_manager_secret.app[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run_sa.email}"
}

resource "google_secret_manager_secret_iam_member" "cloud_run_db_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run_sa.email}"
}

resource "google_secret_manager_secret_iam_member" "cloud_run_redis_url" {
  secret_id = google_secret_manager_secret.redis_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run_sa.email}"
}
