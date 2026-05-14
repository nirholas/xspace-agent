variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "aerial-vehicle-466722-p5"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone"
  type        = string
  default     = "us-central1-a"
}

variable "operator_ips" {
  description = <<-EOT
    CIDRs allowed to reach port 3000 (admin dashboard).
    WARNING: Default is 0.0.0.0/0 (open to the world). Replace with your
    actual operator IPs before applying in production, e.g.:
      operator_ips = ["203.0.113.42/32", "198.51.100.0/24"]
  EOT
  type    = list(string)
  default = ["0.0.0.0/0"] # TODO: restrict before first production apply
}

variable "alert_email" {
  description = "Email address for Cloud Monitoring alert notifications"
  type        = string
  # Set in terraform.tfvars — do not hard-code here
}

variable "ssh_public_key" {
  description = "Public SSH key for the 'agent' OS user on the VM (openssh format)"
  type        = string
  # Set in terraform.tfvars — do not hard-code here
}
