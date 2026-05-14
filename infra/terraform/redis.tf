###############################################################################
# Cloud Memorystore — Redis 7 for usage tracking + rate limiting
###############################################################################

resource "google_redis_instance" "main" {
  name               = "xspace-redis"
  tier               = "STANDARD_HA"
  memory_size_gb     = 1
  region             = var.region
  authorized_network = data.google_compute_network.default.id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  redis_version      = "REDIS_7_0"
  display_name       = "xspace-agent Redis"

  redis_configs = {
    maxmemory-policy = "allkeys-lru"
  }

  maintenance_policy {
    weekly_maintenance_window {
      day = "SUNDAY"
      start_time { hours = 4; minutes = 0; seconds = 0; nanos = 0 }
    }
  }

  persistence_config {
    persistence_mode    = "RDB"
    rdb_snapshot_period = "ONE_HOUR"
  }

  depends_on = [google_service_networking_connection.private_vpc_connection]
}

resource "google_secret_manager_secret" "redis_url" {
  secret_id = "redis-url"
  replication { auto {} }
}

resource "google_secret_manager_secret_version" "redis_url" {
  secret      = google_secret_manager_secret.redis_url.id
  secret_data = "redis://${google_redis_instance.main.host}:${google_redis_instance.main.port}"
}
