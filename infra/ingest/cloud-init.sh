#!/usr/bin/env bash
# cloud-init for the Picket FTPS receiver. Rendered by CDK: the double-underscore
# tokens (BUCKET, REGION, ...) are substituted in lib/receiver.ts. Idempotent enough to re-run.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

BUCKET="__BUCKET__"
RAW_PREFIX="__RAW_PREFIX__"
REGION="__REGION__"
PUBLIC_IP="__PUBLIC_IP__"
FTP_USER="__FTP_USER__"
FTP_SECRET_ARN="__FTP_SECRET_ARN__"
PASV_MIN="__PASV_MIN__"
PASV_MAX="__PASV_MAX__"

apt-get update
apt-get install -y pure-ftpd unzip curl openssl

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

# --- TLS cert (self-signed, SAN = public IP) ---------------------------------
mkdir -p /etc/ssl/private
if [ ! -s /etc/ssl/private/pure-ftpd.pem ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -subj "/CN=picket-receiver" \
    -addext "subjectAltName=IP:${PUBLIC_IP}" \
    -keyout /etc/ssl/private/pure-ftpd.key -out /etc/ssl/private/pure-ftpd.crt
  cat /etc/ssl/private/pure-ftpd.key /etc/ssl/private/pure-ftpd.crt > /etc/ssl/private/pure-ftpd.pem
  chmod 0600 /etc/ssl/private/pure-ftpd.pem
  # Camera-importable copy (public cert only) for MENU > Network > Import Root Certificate.
  cp /etc/ssl/private/pure-ftpd.crt /srv/picket-receiver-cert.pem 2>/dev/null || install -D -m 0644 /etc/ssl/private/pure-ftpd.crt /srv/picket-receiver-cert.pem
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
conf Umask "137:027"
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
systemctl restart pure-ftpd
systemctl enable pure-ftpd

logger -t picket "receiver ready on ${PUBLIC_IP}:21 (FTPES, passive ${PASV_MIN}-${PASV_MAX})"
