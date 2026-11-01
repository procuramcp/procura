# Oracle Cloud infrastructure (Terraform)

Creates everything the VM needs, inside the Always Free allowance (D-029):

- **Network:** a VCN, Internet Gateway, route table, and public subnet, with a security list
  allowing SSH (22), HTTP (80), HTTPS (443 TCP and UDP), and path-MTU ICMP.
- **VM:** Canonical Ubuntu 24.04 on `VM.Standard.E2.1.Micro` (default) or `VM.Standard.A1.Flex`,
  with your SSH key and a **reserved public IP**, which is both its inbound and outbound address
  and survives replacing the VM.
- **First boot (cloud-init):** Docker from Docker's repository, 2 GB of swap, ports 80/443 opened
  in the VM's own firewall, and automatic security updates. Settings and secrets are not in
  Terraform; `setup-vm.sh` asks for them, so they never land in Terraform state.
- **Guardrails:** a tenancy-wide quota allowing only the two Always Free compute shapes, and a
  monthly budget with alerts on any actual spend and on a forecast over budget. Budgets only alert;
  the quota is what blocks paid shapes. Set `manage_quota = false` if others use the tenancy.

## Use it

1. **An API key for Terraform:** in the console, Profile → **API keys** → Add API key →
   Generate, download the private key to `~/.oci/oci_api_key.pem` (`chmod 600` it), and paste the
   configuration preview it shows into `~/.oci/config`.
2. **Settings:** `cp terraform.tfvars.example terraform.tfvars` and fill in your tenancy OCID,
   home region, and an alert email.
3. **Apply:**

   ```bash
   cd deploy/oracle/infra
   terraform init
   terraform plan      # read it: everything should be free shapes and small volumes
   terraform apply
   ```

   "Out of capacity" (common for A1) fails the apply with nothing half-made worth worrying about;
   retry later, or set `availability_domain_index` to another domain.
4. **Then:** add the printed `ssh_config` block to `~/.ssh/config`, and continue with
   [../README.md](../README.md#3-set-up-and-deploy): `ship.sh` from your machine, then
   `setup-vm.sh` on the VM (it waits for first boot to finish and skips what's already done).
   Use the printed `domain` when it asks, and register `google_redirect_uri` with Google.

## Notes

- **State** (`terraform.tfstate`) stays local and gitignored. It holds no secrets (no app
  settings), but does hold your tenancy's resource ids; keep it, since without it Terraform can't
  manage what it created. The provider lock file is committed.
- **Rebuilding the VM:** a newer image or edited cloud-init is ignored for the running VM on
  purpose. To rebuild: `terraform apply -replace=oci_core_instance.cairnmcp`. The reserved IP moves
  to the new VM; run `setup-vm.sh` and `ship.sh` again (and restore `app.env`, including the
  master key you backed up).
- **Resource Manager** (Oracle's hosted Terraform) also works: zip this folder, create a stack,
  and leave `oci_profile` empty; it fills in `tenancy_ocid`, `region`, and `compartment_ocid`.
- A VM made by hand isn't managed here; terminate it (and its boot volume) before applying, or
  you'll have two.
