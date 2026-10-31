#!/usr/bin/env bash
# cloud-init for the Picket FTPS receiver. Rendered by CDK: the double-underscore
# tokens (BUCKET, REGION, ...) are substituted in lib/receiver.ts. Idempotent enough to re-run.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

BUCKET="__BUCKET__"
RAW_PREFIX="__RAW_PREFIX__"
REGION="__REGION__"
PUBLIC_IP="__PUBLIC_IP__"
HOST_NAME="__HOST_NAME__"   # empty: IP-only receiver with a self-signed cert
FTP_USER="__FTP_USER__"
FTP_SECRET_ARN="__FTP_SECRET_ARN__"
PASV_MIN="__PASV_MIN__"
PASV_MAX="__PASV_MAX__"

apt-get update
apt-get install -y pure-ftpd unzip curl openssl
[ -z "${HOST_NAME}" ] || apt-get install -y certbot

# --- AWS CLI v2 (arm64) --------------------------------------------------------
if ! command -v aws >/dev/null; then
  curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscli.zip
  unzip -q -o /tmp/awscli.zip -d /tmp
  /tmp/aws/install --update
  rm -rf /tmp/aws /tmp/awscli.zip
fi

cat > /etc/picket.env <<ENV
PICKET_BUCKET=${BUCKET}
PICKET_RAW_PREFIX=${RAW_PREFIX}
AWS_DEFAULT_REGION=${REGION}
ENV
chmod 0644 /etc/picket.env

# --- Upload hook + sweep -----------------------------------------------------
install -m 0755 /dev/stdin /usr/local/bin/picket-upload.sh <<'UPLOAD'
__UPLOAD_SCRIPT__
UPLOAD
install -m 0755 /dev/stdin /usr/local/bin/picket-sweep.sh <<'SWEEP'
__SWEEP_SCRIPT__
SWEEP

cat > /etc/systemd/system/picket-sweep.service <<UNIT
[Unit]
Description=Picket: retry uploads left in the FTP home
[Service]
Type=oneshot
ExecStart=/usr/local/bin/picket-sweep.sh
UNIT
cat > /etc/systemd/system/picket-sweep.timer <<UNIT
[Unit]
Description=Picket: run the upload sweep every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT

# --- TLS cert ------------------------------------------------------------------
# Day one: self-signed (SAN = IP and hostname) so FTPS works immediately.
# With a hostname: a timer keeps trying Let's Encrypt until DNS resolves, then
# swaps the cert in; certbot's own timer renews it and the deploy hook reinstalls.
mkdir -p /etc/ssl/private
if [ ! -s /etc/ssl/private/pure-ftpd.pem ]; then
  san="IP:${PUBLIC_IP}"; [ -z "${HOST_NAME}" ] || san="DNS:${HOST_NAME},${san}"
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -subj "/CN=${HOST_NAME:-picket-receiver}" \
    -addext "subjectAltName=${san}" \
    -keyout /etc/ssl/private/pure-ftpd.key -out /etc/ssl/private/pure-ftpd.crt
  cat /etc/ssl/private/pure-ftpd.key /etc/ssl/private/pure-ftpd.crt > /etc/ssl/private/pure-ftpd.pem
  chmod 0600 /etc/ssl/private/pure-ftpd.pem
  install -D -m 0644 /etc/ssl/private/pure-ftpd.crt /srv/picket-receiver-cert.pem
fi

if [ -n "${HOST_NAME}" ]; then
  install -m 0755 /dev/stdin /usr/local/bin/picket-install-cert.sh <<'INSTALLCERT'
#!/usr/bin/env bash
# certbot deploy hook: pure-ftpd wants key + chain in one file.
set -euo pipefail
live="/etc/letsencrypt/live/$(ls /etc/letsencrypt/live | grep -v README | head -n1)"
cat "$live/privkey.pem" "$live/fullchain.pem" > /etc/ssl/private/pure-ftpd.pem.new
chmod 0600 /etc/ssl/private/pure-ftpd.pem.new
mv /etc/ssl/private/pure-ftpd.pem.new /etc/ssl/private/pure-ftpd.pem
systemctl restart pure-ftpd
logger -t picket "installed Let's Encrypt certificate from $live"
INSTALLCERT
  cat > /etc/picket-cert.env <<ENV
PICKET_HOST_NAME=${HOST_NAME}
ENV
  install -m 0755 /dev/stdin /usr/local/bin/picket-obtain-cert.sh <<'OBTAIN'
#!/usr/bin/env bash
# Runs from a timer until it succeeds once, then disables itself (certbot renews from there).
set -euo pipefail
source /etc/picket-cert.env
if [ -d "/etc/letsencrypt/live/${PICKET_HOST_NAME}" ]; then systemctl disable --now picket-obtain-cert.timer || true; exit 0; fi
if certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email \
     --preferred-challenges http -d "${PICKET_HOST_NAME}" --deploy-hook /usr/local/bin/picket-install-cert.sh; then
  systemctl disable --now picket-obtain-cert.timer || true
  logger -t picket "Let's Encrypt certificate obtained for ${PICKET_HOST_NAME}"
else
  logger -t picket "Let's Encrypt not yet possible for ${PICKET_HOST_NAME} (DNS not delegated yet?); will retry"
  exit 1
fi
OBTAIN
  cat > /etc/systemd/system/picket-obtain-cert.service <<UNIT
[Unit]
Description=Picket: obtain Let's Encrypt certificate for the FTPS receiver
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/picket-obtain-cert.sh
UNIT
  cat > /etc/systemd/system/picket-obtain-cert.timer <<UNIT
[Unit]
Description=Picket: retry Let's Encrypt every 15 minutes until it succeeds
[Timer]
OnBootSec=90s
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
UNIT
fi

# --- pure-ftpd ---------------------------------------------------------------
# Ubuntu's package reads one option per file from /etc/pure-ftpd/conf.
conf() { echo "$2" > "/etc/pure-ftpd/conf/$1"; }
conf TLS 2                      # TLS required on the control channel (password never in the clear)
conf PassivePortRange "${PASV_MIN} ${PASV_MAX}"
conf ForcePassiveIP "${PUBLIC_IP}"
conf ChrootEveryone yes
conf NoAnonymous yes
conf CreateHomeDir yes
conf MaxClientsNumber 8
conf MaxClientsPerIP 8
conf MinUID 1000
conf CallUploadScript yes
conf VerboseLog yes
conf Umask "137 027"            # files 0640, dirs 0750; the Debian wrapper wants "fff ddd" and builds -U f:d itself
conf DontResolve yes
conf PureDB /etc/pure-ftpd/pureftpd.pdb
ln -sf ../conf/PureDB /etc/pure-ftpd/auth/50pure
rm -f /etc/pure-ftpd/auth/65unix /etc/pure-ftpd/auth/70pam

# Virtual FTP user backed by one system account.
id -u ftpcamera >/dev/null 2>&1 || useradd --system --home-dir /srv/ftp --shell /usr/sbin/nologin ftpcamera
mkdir -p "/srv/ftp/${FTP_USER}"
chown -R ftpcamera:ftpcamera /srv/ftp
chmod 0750 /srv/ftp "/srv/ftp/${FTP_USER}"

# (Re)load the camera's password from Secrets Manager. Also run later via SSM
# after the deploy workflow rotates the secret: picket-set-ftp-password.sh
cat >> /etc/picket.env <<ENV
PICKET_FTP_USER=${FTP_USER}
PICKET_FTP_SECRET_ARN=${FTP_SECRET_ARN}
ENV
install -m 0755 /dev/stdin /usr/local/bin/picket-set-ftp-password.sh <<'SETPW'
#!/usr/bin/env bash
set -euo pipefail
source /etc/picket.env
pw="$(aws secretsmanager get-secret-value --secret-id "${PICKET_FTP_SECRET_ARN}" --query SecretString --output text)"
if pure-pw show "${PICKET_FTP_USER}" -f /etc/pure-ftpd/pureftpd.passwd >/dev/null 2>&1; then
  printf '%s\n%s\n' "${pw}" "${pw}" | pure-pw passwd "${PICKET_FTP_USER}" -f /etc/pure-ftpd/pureftpd.passwd
else
  printf '%s\n%s\n' "${pw}" "${pw}" | pure-pw useradd "${PICKET_FTP_USER}" -f /etc/pure-ftpd/pureftpd.passwd \
    -u ftpcamera -g ftpcamera -d "/srv/ftp/${PICKET_FTP_USER}"
fi
pure-pw mkdb /etc/pure-ftpd/pureftpd.pdb -f /etc/pure-ftpd/pureftpd.passwd
logger -t picket "ftp password (re)loaded for ${PICKET_FTP_USER}"
SETPW
/usr/local/bin/picket-set-ftp-password.sh

# The hook runs as the FTP user's uid so it can delete what it uploads.
sed -i 's|^UPLOADSCRIPT=.*|UPLOADSCRIPT=/usr/local/bin/picket-upload.sh|' /etc/default/pure-ftpd-common
sed -i "s|^UPLOADUID=.*|UPLOADUID=$(id -u ftpcamera)|" /etc/default/pure-ftpd-common
sed -i "s|^UPLOADGID=.*|UPLOADGID=$(id -g ftpcamera)|" /etc/default/pure-ftpd-common
grep -q '^UPLOADSCRIPT=' /etc/default/pure-ftpd-common || echo "UPLOADSCRIPT=/usr/local/bin/picket-upload.sh" >> /etc/default/pure-ftpd-common
grep -q '^UPLOADUID=' /etc/default/pure-ftpd-common || echo "UPLOADUID=$(id -u ftpcamera)" >> /etc/default/pure-ftpd-common
grep -q '^UPLOADGID=' /etc/default/pure-ftpd-common || echo "UPLOADGID=$(id -g ftpcamera)" >> /etc/default/pure-ftpd-common

systemctl daemon-reload
systemctl enable --now picket-sweep.timer
[ -z "${HOST_NAME}" ] || systemctl enable --now picket-obtain-cert.timer
systemctl restart pure-ftpd
systemctl enable pure-ftpd

logger -t picket "receiver ready on ${HOST_NAME:-$PUBLIC_IP}:21 (FTPES, passive ${PASV_MIN}-${PASV_MAX})"
