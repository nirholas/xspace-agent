###############################################################################
# GKE Autopilot Cluster
#
# Autopilot manages node pools automatically — no node pool resources needed.
# Google provisions, scales, and patches nodes; you pay per Pod resource request.
###############################################################################

resource "google_container_cluster" "primary" {
  provider = google-beta

  name     = var.cluster_name
  location = var.region # Regional cluster for HA across zones

  # Autopilot mode — Google manages the node fleet
  enable_autopilot = true

  network    = google_compute_network.vpc.id
  subnetwork = google_compute_subnetwork.subnet.id

  # Private cluster: nodes have no public IPs
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false # Public endpoint (IAM-protected) for kubectl access
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "gke-pods"
    services_secondary_range_name = "gke-services"
  }

  # Workload Identity: Pods authenticate as GCP service accounts without key files
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  release_channel {
    channel = "REGULAR" # Stable weekly releases; RAPID for cutting-edge
  }

  # Enable Vertical Pod Autoscaling (managed by Autopilot)
  vertical_pod_autoscaling {
    enabled = true
  }

  # Cluster-level autoscaling resource limits
  cluster_autoscaling {
    autoscaling_profile = "OPTIMIZE_UTILIZATION"

    auto_provisioning_defaults {
      service_account = google_service_account.xspace_agent_sa.email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

      management {
        auto_repair  = true
        auto_upgrade = true
      }
    }

    resource_limits {
      resource_type = "cpu"
      minimum       = var.min_nodes * 2  # 2 vCPU per minimum node
      maximum       = var.max_nodes * 8  # 8 vCPU per maximum node
    }

    resource_limits {
      resource_type = "memory"
      minimum       = var.min_nodes * 4  # 4GB per minimum node
      maximum       = var.max_nodes * 32 # 32GB per maximum node
    }
  }

  # Logging and monitoring via Cloud Operations
  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS"]
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]

    managed_prometheus {
      enabled = true # Enables Google Managed Prometheus for Kubernetes metrics
    }
  }

  # Master authorized networks — restrict kubectl access by CIDR
  # Set to 0.0.0.0/0 to allow all; tighten in production if possible.
  master_authorized_networks_config {
    cidr_blocks {
      cidr_block   = "0.0.0.0/0"
      display_name = "all-for-now"
    }
  }

  labels = local.common_labels

  # Prevent accidental cluster deletion
  lifecycle {
    prevent_destroy = false # Set to true once cluster is fully configured
    ignore_changes = [
      # Autopilot may adjust these; don't fight it
      cluster_autoscaling,
    ]
  }

  depends_on = [
    google_project_service.apis,
    google_compute_subnetwork.subnet,
    google_service_account.xspace_agent_sa,
  ]
}
