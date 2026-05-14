###############################################################################
# Outputs — values needed for kubectl, CI/CD, and application config
###############################################################################

output "cluster_name" {
  description = "GKE cluster name"
  value       = google_container_cluster.primary.name
}

output "cluster_endpoint" {
  description = "GKE cluster API server endpoint (use with kubectl)"
  value       = google_container_cluster.primary.endpoint
  sensitive   = true
}

output "cluster_ca_certificate" {
  description = "GKE cluster CA certificate (base64)"
  value       = google_container_cluster.primary.master_auth[0].cluster_ca_certificate
  sensitive   = true
}

output "artifact_registry_url" {
  description = "Artifact Registry base URL for Docker images"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}"
}

output "cloud_run_url" {
  description = "Cloud Run service URL for on-demand Space sessions"
  value       = google_cloud_run_v2_service.xspace_agent_ondemand.uri
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL connection name for Cloud SQL Auth Proxy (PROJECT:REGION:INSTANCE)"
  value       = google_sql_database_instance.postgres.connection_name
}

output "cloud_sql_private_ip" {
  description = "Cloud SQL private IP (accessible from VPC only)"
  value       = google_sql_database_instance.postgres.private_ip_address
  sensitive   = true
}

output "redis_host" {
  description = "Memorystore Redis host (accessible from VPC only)"
  value       = google_redis_instance.cache.host
  sensitive   = true
}

output "redis_port" {
  description = "Memorystore Redis port"
  value       = google_redis_instance.cache.port
}

output "service_account_email" {
  description = "GCP service account email (for Workload Identity annotation)"
  value       = google_service_account.xspace_agent_sa.email
}

output "kubeconfig_command" {
  description = "Command to fetch kubeconfig for this cluster"
  value       = "gcloud container clusters get-credentials ${google_container_cluster.primary.name} --region ${var.region} --project ${var.project_id}"
}
