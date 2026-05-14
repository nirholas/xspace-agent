###############################################################################
# xspace-agent — GCP Infrastructure
# Project : aerial-vehicle-466722-p5
# Region  : us-central1 / zone us-central1-a
#
# Apply order:
#   terraform init
#   terraform plan -out=tfplan
#   terraform apply tfplan
###############################################################################

terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }

  # Uncomment to store state in GCS (recommended for team use):
  # backend "gcs" {
  #   bucket = "aerial-vehicle-466722-p5-tfstate"
  #   prefix = "xspace-agent"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

###############################################################################
# Required GCP APIs
# Enable these once on a fresh project. terraform apply is idempotent.
###############################################################################

resource "google_project_service" "apis" {
  for_each = toset([
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iap.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ])

  service                    = each.value
  disable_dependent_services = false
  # Do not disable APIs when resources are destroyed — other things may use them
  disable_on_destroy = false
}

###############################################################################
# Service Account
###############################################################################

resource "google_service_account" "swarm_agent_sa" {
  account_id   = "swarm-agent-vm"
  display_name = "swarm-agent VM service account"
  description  = "Minimal SA for the xspace-agent swarm VM"

  depends_on = [google_project_service.apis]
}

# Logging — required for structured logs to Cloud Logging
resource "google_project_iam_member" "swarm_agent_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.swarm_agent_sa.email}"
}

# Metrics — required for Cloud Monitoring agent
resource "google_project_iam_member" "swarm_agent_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.swarm_agent_sa.email}"
}

# Storage read — lets the VM pull config/assets from GCS if needed
resource "google_project_iam_member" "swarm_agent_storage_viewer" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.swarm_agent_sa.email}"
}

###############################################################################
# Static External IP
###############################################################################

resource "google_compute_address" "swarm_agent_ip" {
  name         = "swarm-agent-ip"
  address_type = "EXTERNAL"
  region       = var.region
  description  = "Static IP for the swarm-agent VM. Changing this breaks DNS/firewall rules."
}

###############################################################################
# Compute Instance
###############################################################################

resource "google_compute_instance" "swarm_agent" {
  name         = "swarm-agent"
  machine_type = "n2-standard-4" # 4 vCPU / 16 GB — headroom for 4 Chrome + Node
  zone         = var.zone

  labels = {
    environment = "production"
    app         = "xspace-agent"
  }

  # Network tags drive firewall rule targeting
  tags = ["swarm-agent", "http-server", "https-server"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 50   # GB — Chrome profile data + logs
      type  = "pd-ssd"
    }
  }

  network_interface {
    network = "default"

    # Attach the static IP
    access_config {
      nat_ip = google_compute_address.swarm_agent_ip.address
    }
  }

  service_account {
    email  = google_service_account.swarm_agent_sa.email
    # Prefer IAM roles over broad OAuth scopes; cloud-platform is intentionally
    # NOT listed here. Only the SA IAM bindings above determine access.
    scopes = ["cloud-platform"]
  }

  metadata = {
    # OS-level SSH key; IAP is the only allowed ingress path (see firewall rules)
    ssh-keys = "agent:${var.ssh_public_key}"

    # Runs on first boot and on every restart (script is idempotent)
    startup-script = file("${path.module}/startup.sh")

    # Enables OS Login as an alternative to metadata SSH keys (optional belt+suspenders)
    # enable-oslogin = "TRUE"
  }

  # Ensure the SA bindings exist before the VM boots and tries to use them,
  # and that all required APIs are enabled first.
  depends_on = [
    google_project_service.apis,
    google_project_iam_member.swarm_agent_log_writer,
    google_project_iam_member.swarm_agent_metric_writer,
    google_project_iam_member.swarm_agent_storage_viewer,
  ]
}

###############################################################################
# Firewall Rules
###############################################################################

# Allow SSH only from IAP's published range — no public port 22.
# IAP range: 35.235.240.0/20 (https://cloud.google.com/iap/docs/using-tcp-forwarding)
resource "google_compute_firewall" "allow_ssh_iap" {
  name    = "swarm-agent-allow-ssh-iap"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # IAP TCP forwarding source range — do not widen this
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["swarm-agent"]

  description = "Allow SSH only through Identity-Aware Proxy tunnel"
}

# Admin dashboard port 3000 — restricted to operator IPs.
# WARNING: default var is 0.0.0.0/0. Set operator_ips in terraform.tfvars.
resource "google_compute_firewall" "allow_dashboard" {
  name    = "swarm-agent-allow-dashboard"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["3000"]
  }

  source_ranges = var.operator_ips
  target_tags   = ["swarm-agent"]

  description = "Admin dashboard access. Restrict operator_ips before production use."
}

# Chrome CDP ports (9222–9225) must stay internal — never open to external traffic.
# This rule ensures they are only reachable from instances inside the default network.
resource "google_compute_firewall" "deny_cdp_external" {
  name      = "swarm-agent-deny-cdp-external"
  network   = "default"
  direction = "INGRESS"
  priority  = 500 # Higher priority than default-allow-internal (65534)

  deny {
    protocol = "tcp"
    ports    = ["9222", "9223", "9224", "9225"]
  }

  # Deny from everywhere except RFC1918 (handled by default-allow-internal at lower priority)
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["swarm-agent"]

  description = "Explicitly deny Chrome CDP ports from any external source"
}

# Allow all outbound — Chrome and Node need to reach X, OpenAI, ElevenLabs, etc.
resource "google_compute_firewall" "allow_egress_all" {
  name      = "swarm-agent-allow-egress"
  network   = "default"
  direction = "EGRESS"

  allow {
    protocol = "all"
  }

  destination_ranges = ["0.0.0.0/0"]
  target_tags        = ["swarm-agent"]

  description = "Unrestricted outbound (agent needs to reach X API, AI providers, CDNs)"
}

###############################################################################
# Cloud Monitoring — Uptime Check
###############################################################################

# Uptime check: GCP probes the Node server from outside the VM.
# Uses the static external IP on port 3000.
resource "google_monitoring_uptime_check_config" "swarm_server_uptime" {
  display_name = "swarm-agent Node server"
  timeout      = "10s"
  period       = "60s" # Check every minute

  http_check {
    path         = "/"
    port         = 3000
    use_ssl      = false
    validate_ssl = false
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = google_compute_address.swarm_agent_ip.address
    }
  }
}

###############################################################################
# Cloud Monitoring — Notification Channel
###############################################################################

resource "google_monitoring_notification_channel" "email" {
  display_name = "Operator alert email"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }
}

###############################################################################
# Cloud Monitoring — Alert Policies
###############################################################################

# Alert 1: CPU > 85% sustained for 5 minutes
resource "google_monitoring_alert_policy" "high_cpu" {
  display_name = "swarm-agent: CPU > 85% for 5 min"
  combiner     = "OR"

  conditions {
    display_name = "CPU utilization above threshold"

    condition_threshold {
      filter = <<-EOT
        resource.type = "gce_instance"
        AND resource.labels.instance_id = "${google_compute_instance.swarm_agent.instance_id}"
        AND metric.type = "compute.googleapis.com/instance/cpu/utilization"
      EOT

      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "300s" # 5 minutes of sustained high CPU

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  alert_strategy {
    auto_close = "1800s" # Auto-close after 30 min if condition clears
  }
}

# Alert 2: Memory > 90%
# Requires the Cloud Monitoring ops agent to be installed on the VM.
# startup.sh installs google-cloud-ops-agent which provides this metric.
resource "google_monitoring_alert_policy" "high_memory" {
  display_name = "swarm-agent: Memory > 90%"
  combiner     = "OR"

  conditions {
    display_name = "Memory utilization above threshold"

    condition_threshold {
      filter = <<-EOT
        resource.type = "gce_instance"
        AND resource.labels.instance_id = "${google_compute_instance.swarm_agent.instance_id}"
        AND metric.type = "agent.googleapis.com/memory/percent_used"
        AND metric.labels.state = "used"
      EOT

      comparison      = "COMPARISON_GT"
      threshold_value = 90
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  alert_strategy {
    auto_close = "1800s"
  }
}

# Alert 3: Uptime check fails — server is unreachable
resource "google_monitoring_alert_policy" "uptime_failure" {
  display_name = "swarm-agent: server unreachable"
  combiner     = "OR"

  conditions {
    display_name = "Uptime check failing"

    condition_threshold {
      filter = <<-EOT
        resource.type = "uptime_url"
        AND metric.type = "monitoring.googleapis.com/uptime_check/check_passed"
        AND metric.labels.check_id = "${google_monitoring_uptime_check_config.swarm_server_uptime.uptime_check_id}"
      EOT

      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "120s" # 2 consecutive failures before alerting

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.labels.host"]
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  alert_strategy {
    auto_close = "3600s"
  }
}
