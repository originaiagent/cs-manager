#!/bin/bash
# =============================================================================
# Yahoo egress fixed-IP proxy — VM startup-script (idempotent, runs every boot)
# -----------------------------------------------------------------------------
# Role: turn this VM (which holds the reserved static external IP) into a locked
#       down forward proxy so that cs-manager's Yahoo API traffic egresses from a
#       single fixed global IP.
#
# Lockdown (design codex APPROVE 2026-06-28):
#   - BasicAuth required (creds fetched from Secret Manager via the VM service
#     account; never written to serial/journal logs).
#   - Destination whitelist = Yahoo API domains only (FilterDefaultDeny Yes).
#   - CONNECT tunnelling restricted to port 443.
#   - No `Allow` lines => any source may *connect* but is gated by BasicAuth, and
#     can only reach whitelisted Yahoo hosts (Vercel egress IP is dynamic, so we
#     cannot source-restrict at the firewall; auth + dest-whitelist is the gate).
#
# Self-heal: systemd `Restart=always` drop-in + enabled at boot + this script is
#   idempotent and re-runs on every boot, so a reboot fully restores the proxy.
# =============================================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

PROJECT="logistics-app-481912"
SECRET_NAME="yahoo-egress-proxy-basicauth"
PROXY_PORT="8888"
LOG_TAG="[yahoo-egress-proxy startup]"
log() { echo "${LOG_TAG} $*"; }

# --- 1. packages (idempotent) ------------------------------------------------
if ! command -v tinyproxy >/dev/null 2>&1; then
  log "installing tinyproxy/jq/curl"
  apt-get update -y
  apt-get install -y tinyproxy jq curl
fi
# fail2ban is best-effort hardening; never block proxy bring-up on its failure.
apt-get install -y fail2ban >/dev/null 2>&1 || log "fail2ban install skipped (non-fatal)"

# --- 2. fetch BasicAuth from Secret Manager (no secret in logs) --------------
# Uses the VM service account's metadata access token; the SA is granted
# secretAccessor on ONLY this secret (least privilege).
log "fetching BasicAuth from Secret Manager"
ACCESS_TOKEN="$(curl -sf -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
  | jq -r '.access_token')"
if [ -z "${ACCESS_TOKEN}" ] || [ "${ACCESS_TOKEN}" = "null" ]; then
  log "FATAL: could not obtain metadata access token"; exit 1
fi

# Disable command tracing around secret handling so nothing leaks to logs.
set +x
SECRET_B64="$(curl -sf -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${SECRET_NAME}/versions/latest:access" \
  | jq -r '.payload.data')"
BASICAUTH="$(printf '%s' "${SECRET_B64}" | base64 -d)"   # format: user:pass
PROXY_USER="${BASICAUTH%%:*}"
PROXY_PASS="${BASICAUTH#*:}"
if [ -z "${PROXY_USER}" ] || [ -z "${PROXY_PASS}" ] || [ "${PROXY_USER}" = "${BASICAUTH}" ]; then
  unset BASICAUTH PROXY_PASS SECRET_B64
  log "FATAL: BasicAuth secret malformed (expected user:pass)"; exit 1
fi

# --- 3. render Yahoo-only destination whitelist (ERE, anchored) --------------
cat >/etc/tinyproxy/filter <<'EOF'
^circus\.shopping\.yahooapis\.jp$
^auth\.login\.yahoo\.co\.jp$
^api\.login\.yahoo\.co\.jp$
EOF
chmod 644 /etc/tinyproxy/filter

# --- 4. render tinyproxy.conf (secret written with restrictive perms) --------
umask 077
cat >/etc/tinyproxy/tinyproxy.conf <<EOF
User tinyproxy
Group tinyproxy
Port ${PROXY_PORT}
Listen 0.0.0.0
Timeout 600
DefaultErrorFile "/usr/share/tinyproxy/default.html"
StatFile "/usr/share/tinyproxy/stats.html"
LogFile "/var/log/tinyproxy/tinyproxy.log"
LogLevel Info
PidFile "/run/tinyproxy/tinyproxy.pid"
MaxClients 50
# --- auth: any source may connect but must authenticate (no Allow lines) ---
BasicAuth ${PROXY_USER} ${PROXY_PASS}
# --- destination whitelist: Yahoo API domains only -------------------------
Filter "/etc/tinyproxy/filter"
FilterType ere
FilterDefaultDeny Yes
FilterCaseSensitive Off
# --- CONNECT (HTTPS) tunnelling restricted to 443 only ---------------------
ConnectPort 443
EOF
chown tinyproxy:tinyproxy /etc/tinyproxy/tinyproxy.conf
chmod 600 /etc/tinyproxy/tinyproxy.conf
# scrub secret vars from the shell before re-enabling tracing
unset BASICAUTH PROXY_PASS SECRET_B64 PROXY_USER
set -x

# --- 4b. ensure log dir is writable by tinyproxy (package ships it root-owned
#         on some images, which suppresses the logfile and breaks fail2ban) ----
mkdir -p /var/log/tinyproxy
chown tinyproxy:tinyproxy /var/log/tinyproxy

# --- 5. systemd: Restart=always + enable at boot -----------------------------
mkdir -p /etc/systemd/system/tinyproxy.service.d
cat >/etc/systemd/system/tinyproxy.service.d/override.conf <<'EOF'
[Service]
Restart=always
RestartSec=2
EOF
systemctl daemon-reload
systemctl enable tinyproxy

# --- 6. (re)start and verify (restart applies the new config cleanly even if
#         tinyproxy was already running from a previous boot) -----------------
systemctl restart tinyproxy
sleep 2
if systemctl is-active --quiet tinyproxy; then
  log "tinyproxy active on port ${PROXY_PORT}"
else
  log "FATAL: tinyproxy failed to start"
  journalctl -u tinyproxy --no-pager | tail -20 || true
  exit 1
fi

# --- 7. fail2ban jail for tinyproxy auth failures (best-effort) --------------
if command -v fail2ban-server >/dev/null 2>&1; then
  cat >/etc/fail2ban/filter.d/tinyproxy-auth.conf <<'EOF'
[Definition]
failregex = Unauthorized.*from <HOST>
            .*Proxy-Authorization.*<HOST>.*407
ignoreregex =
EOF
  cat >/etc/fail2ban/jail.d/tinyproxy.conf <<'EOF'
[tinyproxy-auth]
enabled  = true
port     = 8888
filter   = tinyproxy-auth
logpath  = /var/log/tinyproxy/tinyproxy.log
maxretry = 10
findtime = 600
bantime  = 3600
EOF
  systemctl restart fail2ban >/dev/null 2>&1 || log "fail2ban restart skipped (non-fatal)"
fi

log "startup complete"
