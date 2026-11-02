# Names match Oracle Resource Manager's built-in variables (tenancy_ocid,
# region, compartment_ocid), so the same code runs there unchanged.

variable "tenancy_ocid" {
  description = "Tenancy OCID (Profile → Tenancy). The quota and budget live in the root."
  type        = string
}

variable "region" {
  description = "Your home region, e.g. us-sanjose-1 or us-phoenix-1. Always Free resources exist only there."
  type        = string
}

variable "compartment_ocid" {
  description = "Compartment for the network and VM. Empty means the root compartment."
  type        = string
  default     = ""
}

variable "oci_profile" {
  description = "Profile in ~/.oci/config. Empty in Resource Manager."
  type        = string
  default     = "DEFAULT"
}

variable "ssh_public_key_path" {
  description = "Public half of the key you'll SSH in with."
  type        = string
  default     = "~/.ssh/oracle_cairnmcp.pub"
}

variable "ssh_source_cidr" {
  description = "Who may reach SSH (port 22). Narrow it to your own IP/32 if it's stable."
  type        = string
  default     = "0.0.0.0/0"
}

variable "shape" {
  description = "VM.Standard.E2.1.Micro (x86, 1 GB, usually available) or VM.Standard.A1.Flex (Arm, often out of capacity)."
  type        = string
  default     = "VM.Standard.E2.1.Micro"

  validation {
    condition     = contains(["VM.Standard.E2.1.Micro", "VM.Standard.A1.Flex"], var.shape)
    error_message = "Only the Always Free shapes: VM.Standard.E2.1.Micro or VM.Standard.A1.Flex."
  }
}

variable "a1_ocpus" {
  description = "OCPUs for VM.Standard.A1.Flex. Stay within the Always Free allowance shown in the console."
  type        = number
  default     = 1
}

variable "a1_memory_gbs" {
  description = "Memory (GB) for VM.Standard.A1.Flex."
  type        = number
  default     = 6
}

variable "availability_domain_index" {
  description = "Which availability domain (0-based). The free E2.1.Micro is often offered in only one; try others on 'out of capacity'."
  type        = number
  default     = 0
}

variable "boot_volume_gbs" {
  description = "Boot volume size. Always Free covers 200 GB of block storage in total."
  type        = number
  default     = 50
}

variable "manage_quota" {
  description = "Create a tenancy-wide quota that allows only the Always Free compute shapes. Affects everything in the tenancy."
  type        = bool
  default     = true
}

variable "a1_quota_ocpus" {
  description = "Most A1 OCPUs the quota allows (the free allowance; reported as 2 in 2026, check the console)."
  type        = number
  default     = 2
}

variable "budget_alert_email" {
  description = "Where budget alerts go."
  type        = string
}

variable "budget_amount" {
  description = "Monthly budget in your billing currency. Alerts fire on any actual spend and when the forecast reaches it."
  type        = number
  default     = 1
}
