###############################################################################
# Cloud SQL — PostgreSQL 16 (private IP, HA)
###############################################################################

resource "random_password" "db_password" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "main" {
  name             = "xspace-db"
  database_version = "POSTGRES_16"
  region           = var.region
  deletion_protection = true

  settings {
    tier              = "db-g1-small"
    availability_type = "REGIONAL"
    disk_size         = 20
    disk_autoresize   = true
    disk_autoresize_limit = 500

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = 7
      hour         = 4
      update_track = "stable"
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = data.google_compute_network.default.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    database_flags { name = "max_connections"; value = "100" }
    database_flags { name = "log_min_duration_statement"; value = "1000" }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = true
      record_client_address   = false
    }
  }

  depends_on = [google_service_networking_connection.private_vpc_connection]
}

resource "google_sql_database" "app" {
  name     = "xspace"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = "xspace"
  instance = google_sql_database_instance.main.name
  password = random_password.db_password.result
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "database-url"
  replication { auto {} }
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://xspace:${random_password.db_password.result}@${google_sql_database_instance.main.private_ip_address}:5432/xspace?sslmode=require"
}
