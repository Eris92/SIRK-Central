#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

SSH_PORT="${SIRK_SSH_PORT:-22}"
CONFIGURE_UFW="${SIRK_CONFIGURE_UFW:-1}"
HARDEN_SSH="${SIRK_HARDEN_SSH:-1}"
ALLOW_LOCKOUT_RISK="${SIRK_ALLOW_SSH_LOCKOUT_RISK:-false}"
INSTALL_DIR="${SIRK_INSTALL_DIR:-/opt/sirk-central}"

log() { printf '[SIRK BOOTSTRAP] %s\n' "$*"; }
fail() { printf '[SIRK BOOTSTRAP] ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || fail "Run as root through sudo."
[[ -r /etc/os-release ]] || fail "/etc/os-release is missing."
# shellcheck disable=SC1091
. /etc/os-release

case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) ;;
  *) fail "Supported systems: Ubuntu 24.04/26.04 and Debian 12/13; detected ${PRETTY_NAME:-unknown}." ;;
esac
[[ -n "${VERSION_CODENAME:-}" ]] || fail "VERSION_CODENAME is missing."
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] && (( SSH_PORT >= 1 && SSH_PORT <= 65535 )) || fail "Invalid SSH port: $SSH_PORT"
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != "/" ]] || fail "Unsafe installation path: $INSTALL_DIR"

export DEBIAN_FRONTEND=noninteractive
log "Installing operating-system prerequisites"
apt-get update
apt-get install -y \
  ca-certificates \
  coreutils \
  curl \
  findutils \
  gawk \
  git \
  gnupg \
  grep \
  jq \
  openssl \
  openssh-server \
  ufw \
  unattended-upgrades

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  log "Installing Docker Engine and Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
    | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/${ID}
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.gpg
EOF
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

install -d -m 0755 -o root -g root "$INSTALL_DIR"

if [[ "$CONFIGURE_UFW" == "1" ]]; then
  log "Configuring UFW"
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow "${SSH_PORT}/tcp" comment "SSH"
  ufw allow 80/tcp comment "SIRK ACME HTTP"
  ufw allow 443/tcp comment "SIRK HTTPS"
  ufw status | grep -q '^Status: active' || ufw --force enable
fi

has_authorized_key=false
for key_file in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [[ -f "$key_file" && -s "$key_file" ]] || continue
  if grep -Eq '^[[:space:]]*(ssh-(rsa|ed25519)|ecdsa-sha2-|sk-(ssh-ed25519|ecdsa-sha2-))' "$key_file"; then
    has_authorized_key=true
    break
  fi
done

if [[ "$HARDEN_SSH" == "1" ]]; then
  if [[ "$has_authorized_key" != true && "$ALLOW_LOCKOUT_RISK" != "true" ]]; then
    fail "No SSH public key was found. Refusing to disable password authentication. Set SIRK_ALLOW_SSH_LOCKOUT_RISK=true only from console access."
  fi
  log "Applying SSH hardening"
  install -d -m 0755 /etc/ssh/sshd_config.d
  rm -f /etc/ssh/sshd_config.d/99-sirk-hardening.conf
  cat > /etc/ssh/sshd_config.d/00-sirk-hardening.conf.tmp <<EOF
Port ${SSH_PORT}
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
MaxAuthTries 4
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
EOF
  chmod 0644 /etc/ssh/sshd_config.d/00-sirk-hardening.conf.tmp
  mv /etc/ssh/sshd_config.d/00-sirk-hardening.conf.tmp /etc/ssh/sshd_config.d/00-sirk-hardening.conf
  /usr/sbin/sshd -t
  systemctl reload ssh
fi

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

log "Bootstrap completed"
docker version
docker compose version
[[ "$CONFIGURE_UFW" == "1" ]] && ufw status verbose || true
[[ "$HARDEN_SSH" == "1" ]] && /usr/sbin/sshd -T | grep -E '^(port|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|authenticationmethods|maxauthtries|logingracetime) ' || true
