#!/bin/sh
# One-time setup of a fresh Ubuntu 24 VPS for FckScrn. Run as root on the server:
#   ssh root@<IP> 'sh -s' < tools/server-setup.sh
# Safe to run again.
set -eu

echo "== system updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# keep the provider's own config files (cloud-init) when packages ship new ones
DPKG="-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
dpkg --force-confold --configure -a || true
apt-get upgrade -y -q $DPKG
# security updates install themselves from now on
apt-get install -y -q $DPKG unattended-upgrades ufw rsync curl
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== Docker (official)"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker

echo "== firewall: only SSH and web"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "== swap 2 GB (LibreOffice peaks when many speakers upload at once)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

echo "== app folder"
mkdir -p /opt/fckscrn

echo "== done"
docker --version
ufw status | head -8
free -h | head -3
