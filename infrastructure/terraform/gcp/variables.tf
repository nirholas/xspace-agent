###############################################################################
# xspace-agent GCP Infrastructure — Variables
###############################################################################

variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "aerial-vehicle-466722-p5"
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Deployment environment (production | staging | development)"
  type        = string
  default     = "production"

  validation {
    condition     = contains(["production", "staging", "development"], var.environment)
    error_message = "environment must be production, staging, or development."
  }
}

variable "cluster_name" {
  description = "GKE Autopilot cluster name"
  type        = string
  default     = "xspace-agent"
}

variable "db_tier" {
  description = "Cloud SQL machine tier (e.g. db-n1-standard-2, db-n1-standard-4)"
  type        = string
  default     = "db-n1-standard-2"
}

variable "redis_tier" {
  description = "Memorystore tier: STANDARD_HA (recommended) or BASIC"
  type        = string
  default     = "STANDARD_HA"

  validation {
    condition     = contains(["STANDARD_HA", "BASIC"], var.redis_tier)
    error_message = "redis_tier must be STANDARD_HA or BASIC."
  }
}

variable "min_nodes" {
  description = "Minimum node count for GKE cluster autoscaling"
  type        = number
  default     = 1
}

variable "max_nodes" {
  description = "Maximum node count for GKE cluster autoscaling"
  type        = number
  default     = 10
}

variable "alert_email" {
  description = "Email address for Cloud Monitoring alert notifications"
  type        = string
  default     = "nicholas.usd@gmail.com"
}

variable "app_domain" {
  description = "Custom domain for the ingress / Cloud Run service (e.g. app.xspaceagent.com)"
  type        = string
  default     = "app.xspaceagent.com"
}
