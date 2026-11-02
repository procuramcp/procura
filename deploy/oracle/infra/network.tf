# One VCN with a public subnet: the VM reaches the internet (Neon, Google,
# upstream APIs) through the Internet Gateway, using its own public IP.

resource "oci_core_vcn" "cairnmcp" {
  compartment_id = local.compartment_id
  display_name   = "cairnmcp"
  cidr_blocks    = ["10.0.0.0/16"]
  dns_label      = "cairnmcp"
}

resource "oci_core_internet_gateway" "cairnmcp" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.cairnmcp.id
  display_name   = "cairnmcp"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.cairnmcp.id
  display_name   = "cairnmcp-public"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.cairnmcp.id
  }
}

resource "oci_core_security_list" "public" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.cairnmcp.id
  display_name   = "cairnmcp-public"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  # SSH
  ingress_security_rules {
    source   = var.ssh_source_cidr
    protocol = "6"
    tcp_options {
      min = 22
      max = 22
    }
  }

  # HTTP (certificate challenges, redirect to HTTPS) and HTTPS
  dynamic "ingress_security_rules" {
    for_each = [80, 443]
    content {
      source   = "0.0.0.0/0"
      protocol = "6"
      tcp_options {
        min = ingress_security_rules.value
        max = ingress_security_rules.value
      }
    }
  }

  # HTTP/3
  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "17"
    udp_options {
      min = 443
      max = 443
    }
  }

  # Path MTU discovery
  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "1"
    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id    = local.compartment_id
  vcn_id            = oci_core_vcn.cairnmcp.id
  display_name      = "cairnmcp-public"
  cidr_block        = "10.0.0.0/24"
  dns_label         = "public"
  route_table_id    = oci_core_route_table.public.id
  security_list_ids = [oci_core_security_list.public.id]
}
