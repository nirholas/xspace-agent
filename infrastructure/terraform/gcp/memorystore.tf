###############################################################################
# Memorystore for Redis 7.0
#
# STANDARD_HA tier: primary + replica in different zones.
# AUTH enabled + in-transit TLS encryption.
# Private service access — no public endpoint.
###############################################################################

resource "google_redis_instance" "cache" {
  name           = "${local.name_prefix}-redis"
  redis_version  = "REDIS_7_0"
  tier           = var.redis_tier
  memory_size_gb = 1

  region             = var.region
  authorized_network = google_compute_network.vpc.id

  # Private service access — connect via the VPC peering range
  connect_mode = "PRIVATE_SERVICE_ACCESS"

  # Enable AUTH token for password protection
  auth_enabled = true

  # Require TLS for all connections
  transit_encryption_mode = "SERVER_AUTHENTICATION"

  # Spread primary and replica across zones
  replica_count    = var.redis_tier == "STANDARD_HA" ? 1 : 0
  read_replicas_mode = var.redis_tier == "STANDARD_HA" ? "READ_REPLICAS_ENABLED" : "READ_REPLICAS_DISABLED"

  maintenance_policy {
    weekly_maintenance_window {
      day = "SUNDAY"
      start_time {
        hours   = 4
        minutes = 0
        seconds = 0
        nanos   = 0
      }
    }
  }

  labels = local.common_labels

  lifecycle {
    prevent_destroy = false
  }

  depends_on = [
    google_service_networking_connection.private_vpc_connection,
    google_project_service.apis,
  ]
}

# Capture the Redis AUTH string in Secret Manager after instance creation
resource "google_secret_manager_secret_version" "redis_auth_string" {
  secret      = google_secret_manager_secret.redis_auth_string.id
  secret_data = google_redis_instance.cache.auth_string

  lifecycle {
    ignore_changes = [secret_data]
  }
}
