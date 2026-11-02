terraform {
  required_version = ">= 1.5"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 9.11"
    }
  }
}

# Credentials come from ~/.oci/config (an API key; see README). In Oracle
# Resource Manager, leave oci_profile empty: it authenticates on its own.
provider "oci" {
  region              = var.region
  config_file_profile = var.oci_profile == "" ? null : var.oci_profile
}
