output "external_ip" {
  description = "Static external IP address of the swarm-agent VM"
  value       = google_compute_address.swarm_agent_ip.address
}

output "ssh_command" {
  description = "IAP-tunnelled SSH command (no public port 22 required)"
  value       = "gcloud compute ssh swarm-agent --tunnel-through-iap --zone=${var.zone} --project=${var.project_id}"
}

output "dashboard_url" {
  description = "Operator dashboard URL (port 3000 — only reachable via Cloudflare Tunnel or SSH forward)"
  value       = "http://${google_compute_address.swarm_agent_ip.address}:3000/dashboard"
}

output "service_account_email" {
  description = "Email of the VM service account (logging, monitoring, storage)"
  value       = google_service_account.swarm_agent_sa.email
}
