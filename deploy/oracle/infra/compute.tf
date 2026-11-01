locals {
  compartment_id = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid
  is_flex        = endswith(var.shape, ".Flex")
}

data "oci_identity_availability_domains" "all" {
  compartment_id = var.tenancy_ocid
}

# Newest full (not Minimal) Canonical Ubuntu 24.04 image built for the chosen shape.
data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"

  filter {
    name   = "display_name"
    values = ["^Canonical-Ubuntu-24\\.04-(aarch64-)?[0-9]{4}\\."]
    regex  = true
  }
}

resource "oci_core_instance" "cairnmcp" {
  compartment_id      = local.compartment_id
  availability_domain = data.oci_identity_availability_domains.all.availability_domains[var.availability_domain_index].name
  display_name        = "cairnmcp"
  shape               = var.shape

  dynamic "shape_config" {
    for_each = local.is_flex ? [1] : []
    content {
      ocpus         = var.a1_ocpus
      memory_in_gbs = var.a1_memory_gbs
    }
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gbs
  }

  create_vnic_details {
    subnet_id      = oci_core_subnet.public.id
    hostname_label = "cairnmcp"
    # The reserved public IP below is attached instead, so the address outlives the VM.
    assign_public_ip = false
  }

  metadata = {
    ssh_authorized_keys = trimspace(file(pathexpand(var.ssh_public_key_path)))
    user_data           = base64encode(file("${path.module}/cloud-init.yaml"))
  }

  # Don't keep a boot volume around (counting against the free 200 GB) after the VM is gone.
  preserve_boot_volume = false

  lifecycle {
    # A newer Ubuntu image or an edited cloud-init must not replace a running VM.
    # To rebuild on purpose: terraform apply -replace=oci_core_instance.cairnmcp
    ignore_changes = [source_details[0].source_id, metadata["user_data"]]
  }
}

data "oci_core_vnic_attachments" "cairnmcp" {
  compartment_id = local.compartment_id
  instance_id    = oci_core_instance.cairnmcp.id
}

data "oci_core_private_ips" "cairnmcp" {
  vnic_id = data.oci_core_vnic_attachments.cairnmcp.vnic_attachments[0].vnic_id
}

# The VM's inbound and outbound address. Reserved, so it survives replacing the VM:
# upstream APIs that rate-limit or allowlist by IP keep seeing the same one.
resource "oci_core_public_ip" "cairnmcp" {
  compartment_id = local.compartment_id
  display_name   = "cairnmcp"
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_private_ips.cairnmcp.private_ips[0].id
}
