output "public_ip" {
  description = "The VM's reserved public IP (also its outbound IP)."
  value       = oci_core_public_ip.cairnmcp.ip_address
}

output "domain" {
  description = "Free hostname for the IP, to use when setup-vm.sh asks (or point your own domain's A record at public_ip)."
  value       = "${replace(oci_core_public_ip.cairnmcp.ip_address, ".", "-")}.sslip.io"
}

output "google_redirect_uri" {
  description = "Redirect URI to register with the Google sign-in client (for the sslip.io domain)."
  value       = "https://${replace(oci_core_public_ip.cairnmcp.ip_address, ".", "-")}.sslip.io/oauth/callback/google"
}

output "ssh_config" {
  description = "Add to ~/.ssh/config, then use: ssh cairnmcp, deploy/oracle/ship.sh cairnmcp"
  value       = <<-EOT
    Host cairnmcp
      HostName ${oci_core_public_ip.cairnmcp.ip_address}
      User ubuntu
      IdentityFile ${trimsuffix(var.ssh_public_key_path, ".pub")}
  EOT
}

output "image" {
  description = "The Ubuntu image the VM was created from."
  value       = data.oci_core_images.ubuntu.images[0].display_name
}
