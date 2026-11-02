#!/usr/bin/env bash
# One-time setup of an Oracle Cloud Always Free VM (Ubuntu 24.04, Ampere A1)
# for cairnmcp: Ampere A1 (Arm) or the x86 E2.1.Micro. Run on the VM, from
# the folder that ship.sh (or a repo clone) put there:
#
#   cd cairnmcp && deploy/oracle/setup-vm.sh
#
# Safe to re-run: installed pieces and existing settings are kept. Secret
# values are read from the terminal (hidden), never from arguments.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
here="$(cd "$(dirname "$0")" && pwd)"
step() { printf '\n• %s\n' "$*"; }

# Check before changing anything: this script uses apt and Ubuntu's iptables rules.
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "This VM runs ${PRETTY_NAME:-an unknown system}, but this script needs Ubuntu (24.04)." >&2
  echo "Recreate the VM with image Canonical Ubuntu 24.04 and shape VM.Standard.A1.Flex (see README)." >&2
  exit 1
fi
case "$(uname -m)" in
  aarch64 | arm64) ;;
  *) echo "note: found $(uname -m), not the Always Free Arm shape (VM.Standard.A1.Flex); check the shape is free. Continuing." ;;
esac

# A VM made by deploy/oracle/infra runs cloud-init on first boot (Docker, swap,
# firewall); wait for it so the two don't fight over apt.
if command -v cloud-init >/dev/null; then
  echo "waiting for first-boot setup (cloud-init) to finish..."
  sudo cloud-init status --wait >/dev/null || true
fi

step "Docker (from Docker's apt repository)"
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" |
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -q
  sudo apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  echo "  installed; log out and back in (or run 'newgrp docker') before deploy.sh"
else
  echo "  already installed"
fi

step "swap (small VMs)"
# The free x86 VM (E2.1.Micro) has 1 GB of memory; swap absorbs spikes such as Docker pulls.
mem_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
if [ "$mem_kb" -lt 3000000 ] && [ -z "$(swapon --noheadings --show)" ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-cairnmcp-swap.conf >/dev/null
  sudo sysctl -q -p /etc/sysctl.d/99-cairnmcp-swap.conf
  echo "  added a 2 GB swap file"
else
  echo "  not needed or already present"
fi

step "automatic security updates"
sudo apt-get install -yq unattended-upgrades iptables-persistent >/dev/null
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

step "open ports 80 and 443 in the VM's firewall"
# Oracle's Ubuntu images reject everything but SSH in iptables, even when the
# cloud security list allows it. Insert just above that REJECT rule and persist.
allow() { # protocol port
  sudo iptables -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null && return
  local reject
  reject="$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
  sudo iptables -I INPUT "${reject:-1}" -p "$1" --dport "$2" -j ACCEPT
}
allow tcp 80
allow tcp 443
allow udp 443
sudo netfilter-persistent save >/dev/null

step "domain"
if [ ! -f "$here/.env" ]; then
  ip="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
  default="${ip//./-}.sslip.io"
  read -r -p "  Domain for HTTPS (a DNS A record to $ip), or Enter for $default: " domain
  domain="${domain:-$default}"
  printf 'CAIRNMCP_DOMAIN=%s\n' "$domain" >"$here/.env"
fi
domain="$(sed -n 's/^CAIRNMCP_DOMAIN=//p' "$here/.env")"
echo "  https://$domain"

step "app settings (deploy/oracle/app.env and migrate.env, readable only by you)"
umask 077
ask() { # prompt -> value (hidden)
  local value
  read -r -s -p "  $1: " value
  echo >&2
  [ -n "$value" ] || { echo "  empty value" >&2; exit 1; }
  printf '%s' "$value"
}
if [ ! -f "$here/app.env" ]; then
  db_url="$(ask "CAIRNMCP_DATABASE_URL (cairnmcp_server, Neon pooled host)")"
  oidc="$(ask "CAIRNMCP_OIDC_PROVIDERS JSON (see README: Google sign-in)")"
  {
    printf 'CAIRNMCP_PUBLIC_URL=https://%s\n' "$domain"
    printf 'CAIRNMCP_DATABASE_URL=%s\n' "$db_url"
    # Generated here and never printed. Back it up (README): without it, stored credentials can't be decrypted.
    printf 'CAIRNMCP_MASTER_KEY=%s\n' "$(openssl rand -base64 32 | tr -d '\n')"
    printf 'CAIRNMCP_OIDC_PROVIDERS=%s\n' "$oidc"
  } >"$here/app.env"
  echo "  wrote app.env with a new master key"
else
  echo "  app.env exists"
fi
if [ ! -f "$here/migrate.env" ]; then
  printf 'CAIRNMCP_DATABASE_OWNER_URL=%s\n' "$(ask "DATABASE_URL_UNPOOLED (Neon owner, direct host)")" >"$here/migrate.env"
  echo "  wrote migrate.env"
else
  echo "  migrate.env exists"
fi

printf '\n✓ VM ready. Google sign-in redirect URI: https://%s/oauth/callback/google\n' "$domain"
printf '  Back up the master key now (README, "Back up the master key"), then run deploy/oracle/deploy.sh\n'
