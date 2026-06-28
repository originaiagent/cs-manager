#!/bin/bash
# =============================================================================
# Yahoo egress fixed-IP proxy — reproducible provisioning (IaC)
# -----------------------------------------------------------------------------
# Stands up a single locked-down forward proxy in GCP asia-northeast1 whose
# static external IP becomes the fixed egress IP for cs-manager -> Yahoo traffic.
#
# Idempotent: safe to re-run; each step is guarded by an existence check.
# Prereqers: gcloud authenticated as a project owner/editor; billing enabled.
#
# Secret model (codex APPROVE 2026-06-28):
#   - BasicAuth canonical value lives in BOTH:
#       * origin-core Vault (service_code=yahoo_egress_proxy)  -> cs-manager reads it
#       * GCP Secret Manager (yahoo-egress-proxy-basicauth)    -> the VM reads it
#     The two MUST hold the same user:pass. Rotation = update both, reload proxy.
#   - The VM reads its copy via a dedicated least-privilege service account.
# =============================================================================
set -euo pipefail

PROJECT="logistics-app-481912"
REGION="asia-northeast1"
ZONE="asia-northeast1-a"          # Tokyo => Japanese geolocated IP (Yahoo requirement)
IP_NAME="yahoo-egress-proxy-ip"
VM_NAME="yahoo-egress-proxy"
TAG="yahoo-egress-proxy"
SA_NAME="yahoo-egress-proxy-sa"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SECRET_NAME="yahoo-egress-proxy-basicauth"
PROXY_PORT="8888"
NETWORK="default"
IAP_RANGE="35.235.240.0/20"        # GCP IAP TCP-forwarding source range (SSH via IAP)
HERE="$(cd "$(dirname "$0")" && pwd)"

g() { gcloud "$@"; }
exists() { "$@" >/dev/null 2>&1; }

echo "== 0. enable APIs =="
g services enable compute.googleapis.com secretmanager.googleapis.com iam.googleapis.com --project "$PROJECT"

echo "== 1. reserve static external IP ($REGION) =="
if ! exists g compute addresses describe "$IP_NAME" --region "$REGION" --project "$PROJECT"; then
  g compute addresses create "$IP_NAME" --region "$REGION" --project "$PROJECT" \
    --description="Fixed egress IP for cs-manager Yahoo API (Vercel->proxy->Yahoo)"
fi
EGRESS_IP="$(g compute addresses describe "$IP_NAME" --region "$REGION" --project "$PROJECT" --format='value(address)')"
echo "   EGRESS_IP=${EGRESS_IP}"

echo "== 2. Secret Manager: BasicAuth (user:pass) =="
# Create the secret if missing. The VALUE must equal the origin-core Vault copy
# (service_code=yahoo_egress_proxy). Provision value out-of-band, e.g.:
#   printf 'csmanager:<PASS>' | gcloud secrets create $SECRET_NAME --data-file=- --replication-policy=automatic --project=$PROJECT
if ! exists g secrets describe "$SECRET_NAME" --project "$PROJECT"; then
  echo "   !! secret $SECRET_NAME missing — create it (value MUST match Core Vault) then re-run." >&2
  exit 1
fi

echo "== 3. dedicated VM service account (least privilege) =="
if ! exists g iam service-accounts describe "$SA_EMAIL" --project "$PROJECT"; then
  g iam service-accounts create "$SA_NAME" --project "$PROJECT" \
    --display-name="Yahoo egress proxy VM SA (least-priv secret accessor)"
fi
# secretAccessor on ONLY this secret (not project-wide).
g secrets add-iam-policy-binding "$SECRET_NAME" --project "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/secretmanager.secretAccessor >/dev/null

echo "== 4. firewall (target tag: $TAG) =="
# 4a. proxy port open to 0.0.0.0/0 (Vercel egress IP is dynamic -> cannot source-restrict;
#     gated by BasicAuth + Yahoo-only dest whitelist + ConnectPort 443).
if ! exists g compute firewall-rules describe "${TAG}-allow-proxy" --project "$PROJECT"; then
  g compute firewall-rules create "${TAG}-allow-proxy" --project "$PROJECT" --network="$NETWORK" \
    --direction=INGRESS --action=ALLOW --rules="tcp:${PROXY_PORT}" \
    --source-ranges=0.0.0.0/0 --target-tags="$TAG" \
    --description="cs-manager Yahoo egress proxy (auth+dest-whitelist gated)"
fi
# 4b. SSH only from IAP range (no public SSH).
if ! exists g compute firewall-rules describe "${TAG}-allow-iap-ssh" --project "$PROJECT"; then
  g compute firewall-rules create "${TAG}-allow-iap-ssh" --project "$PROJECT" --network="$NETWORK" \
    --direction=INGRESS --action=ALLOW --rules="tcp:22" \
    --source-ranges="$IAP_RANGE" --target-tags="$TAG" \
    --description="SSH to egress proxy via IAP tunnel only"
fi

echo "== 5. VM (e2-micro, static IP, SA, startup-script) =="
if ! exists g compute instances describe "$VM_NAME" --zone "$ZONE" --project "$PROJECT"; then
  g compute instances create "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
    --machine-type=e2-micro \
    --image-family=debian-12 --image-project=debian-cloud \
    --network="$NETWORK" --address="$EGRESS_IP" \
    --tags="$TAG" \
    --service-account="$SA_EMAIL" \
    --scopes=cloud-platform \
    --metadata-from-file=startup-script="${HERE}/startup-script.sh" \
    --no-shielded-secure-boot \
    --description="Fixed egress IP forward proxy for cs-manager Yahoo API"
else
  echo "   VM exists; to apply startup-script changes: update metadata + reset:"
  echo "   gcloud compute instances add-metadata $VM_NAME --zone=$ZONE --project=$PROJECT --metadata-from-file=startup-script=${HERE}/startup-script.sh && gcloud compute instances reset $VM_NAME --zone=$ZONE --project=$PROJECT"
fi

echo "== done. EGRESS_IP=${EGRESS_IP} =="
