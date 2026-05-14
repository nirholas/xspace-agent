###############################################################################
# xspace-agent — GCP Infrastructure (GKE + Cloud SQL + Memorystore + Cloud Run)
# Project : aerial-vehicle-466722-p5
# Region  : us-central1
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
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.27"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.13"
    }
  }

  # Uncomment to store state in GCS (strongly recommended for team/production use):
  # backend "gcs" {
  #   bucket = "aerial-vehicle-466722-p5-tfstate"
  #   prefix = "xspace-agent/gke"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# Kubernetes and Helm providers are configured after the GKE cluster is created.
# Use `terraform output cluster_endpoint` to populate these if running in CI.
provider "kubernetes" {
  host                   = "https://${google_container_cluster.primary.endpoint}"
  token                  = data.google_client_config.default.access_token
  cluster_ca_certificate = base64decode(google_container_cluster.primary.master_auth[0].cluster_ca_certificate)
}

provider "helm" {
  kubernetes {
    host                   = "https://${google_container_cluster.primary.endpoint}"
    token                  = data.google_client_config.default.access_token
    cluster_ca_certificate = base64decode(google_container_cluster.primary.master_auth[0].cluster_ca_certificate)
  }
}

data "google_client_config" "default" {}

###############################################################################
# Locals — reduce repetition across resources
###############################################################################

locals {
  name_prefix = "xspace-agent"

  common_labels = {
    app         = "xspace-agent"
    environment = var.environment
    managed_by  = "terraform"
  }

  # Derived names
  network_name    = "${local.name_prefix}-vpc"
  subnet_name     = "${local.name_prefix}-subnet"
  sa_account_id   = "${local.name_prefix}-sa"

  # Artifact Registry image base path
  registry_base = "${var.region}-docker.pkg.dev/${var.project_id}/${local.name_prefix}"
}

###############################################################################
# Enable Required GCP APIs
###############################################################################

resource "google_project_service" "apis" {
  for_each = toset([
    "container.googleapis.com",           # GKE
    "sqladmin.googleapis.com",            # Cloud SQL
    "redis.googleapis.com",               # Memorystore
    "secretmanager.googleapis.com",       # Secret Manager
    "artifactregistry.googleapis.com",    # Artifact Registry
    "run.googleapis.com",                 # Cloud Run
    "cloudbuild.googleapis.com",          # Cloud Build (CI/CD)
    "monitoring.googleapis.com",          # Cloud Monitoring
    "logging.googleapis.com",             # Cloud Logging
    "iam.googleapis.com",                 # IAM
    "servicenetworking.googleapis.com",   # Private service access (SQL/Redis)
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
  ])

  service            = each.value
  disable_on_destroy = false # Do not disable APIs on terraform destroy
}

###############################################################################
# VPC Network
###############################################################################

resource "google_compute_network" "vpc" {
  name                    = local.network_name
  auto_create_subnetworks = false
  description             = "xspace-agent VPC — GKE, Cloud SQL, Memorystore"

  depends_on = [google_project_service.apis]
}

resource "google_compute_subnetwork" "subnet" {
  name          = local.subnet_name
  ip_cidr_range = "10.0.0.0/20"
  region        = var.region
  network       = google_compute_network.vpc.id
  description   = "Primary subnet for GKE nodes"

  # Secondary ranges for GKE pods and services (alias IPs)
  secondary_ip_range {
    range_name    = "gke-pods"
    ip_cidr_range = "10.1.0.0/16"
  }

  secondary_ip_range {
    range_name    = "gke-services"
    ip_cidr_range = "10.2.0.0/16"
  }

  # Required for Cloud SQL private IP access
  private_ip_google_access = true
}

# Private service access peering — required for Cloud SQL and Memorystore private IPs
resource "google_compute_global_address" "private_ip_range" {
  name          = "${local.name_prefix}-private-ip-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id

  depends_on = [google_project_service.apis]
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_range.name]

  depends_on = [google_project_service.apis]
}

###############################################################################
# Cloud Router + NAT — lets private GKE nodes reach the internet
###############################################################################

resource "google_compute_router" "router" {
  name    = "${local.name_prefix}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "${local.name_prefix}-nat"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
