###############################################################################
# Cloud SQL — PostgreSQL 15
#
# Private IP only — no public endpoint exposed.
# High availability (REGIONAL) with automated backups.
###############################################################################

# Random suffix prevents name collisions when recreating an instance
# (Cloud SQL instance names are globally reserved for ~7 days after deletion)
resource "random_id" "sql_suffix" {
  byte_length = 4
}

resource "google_sql_database_instance" "postgres" {
  name             = "${local.name_prefix}-pg-${random_id.sql_suffix.hex}"
  database_version = "POSTGRES_15"
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = "REGIONAL" # HA: primary + standby in different zones

    disk_size       = 20   # GB — auto-grows up to disk_autoresize_limit
    disk_type       = "PD_SSD"
    disk_autoresize = true

    disk_autoresize_limit = 100 # GB cap to prevent runaway costs

    # Private IP only — routed through VPC peering
    ip_configuration {
      ipv4_enabled    = false # No public IP
      private_network = google_compute_network.vpc.id
      require_ssl     = true
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00" # UTC — low-traffic window
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = 7 # Sunday
      hour         = 4 # 4am UTC
      update_track = "stable"
    }

    # Query Insights for slow query analysis
    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = true
      record_client_address   = false
    }

    database_flags {
      name  = "max_connections"
      value = "100"
    }

    database_flags {
      name  = "log_checkpoints"
      value = "on"
    }
  }

  deletion_protection = true # Prevents `terraform destroy` from dropping the DB

  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      settings[0].disk_size, # Auto-resized by Cloud SQL
    ]
  }

  depends_on = [
    google_service_networking_connection.private_vpc_connection,
    google_project_service.apis,
  ]
}

# Application database
resource "google_sql_database" "app_db" {
  name     = "xspace_agent"
  instance = google_sql_database_instance.postgres.name
}

# Application database user — password sourced from Secret Manager after apply
resource "google_sql_user" "app_user" {
  name     = "xspace_agent"
  instance = google_sql_database_instance.postgres.name
  password = random_password.db_password.result
}

# Generate a strong random password at apply time
resource "random_password" "db_password" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

# Store the generated password in Secret Manager
resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db_password.result

  lifecycle {
    ignore_changes = [secret_data] # Don't overwrite if manually rotated
  }
}

