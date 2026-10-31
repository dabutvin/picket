#!/usr/bin/env bash
# Receiver health report. Run on the instance through SSM by `ops → receiver-logs`.
# Never fails: every section prints what it can.
section() { printf '\n===== %s =====\n' "$1"; }

section "cloud-init"
cloud-init status --long 2>&1 || true
section "cloud-init-output.log (last 40 lines)"
tail -n 40 /var/log/cloud-init-output.log 2>&1 || true

section "pure-ftpd service"
systemctl is-enabled pure-ftpd 2>&1 || true
systemctl is-active pure-ftpd 2>&1 || true
systemctl status pure-ftpd --no-pager -l 2>&1 | head -n 15 || true
section "listening sockets (21 = FTP control, 80 = ACME challenge)"
ss -ltnp 2>/dev/null | grep -E ':(21|80|30[0-9]{3}) ' || echo "nothing listening on 21/80"

section "pure-ftpd config"
for f in /etc/pure-ftpd/conf/*; do printf '%s=%s\n' "$(basename "$f")" "$(tr -d '\n' < "$f")"; done 2>/dev/null || true
ls -l /etc/pure-ftpd/auth 2>&1 || true
grep -E '^(UPLOADSCRIPT|UPLOADUID|UPLOADGID|STANDALONE_OR_INETD|VIRTUALCHROOT)=' /etc/default/pure-ftpd-common 2>&1 || true

section "ftp user"
source /etc/picket.env 2>/dev/null || true
pure-pw show "${PICKET_FTP_USER:-camera}" -f /etc/pure-ftpd/pureftpd.passwd 2>&1 | head -n 6 || true
ls -ld /srv/ftp /srv/ftp/* 2>&1 || true

section "FTP home: files waiting for upload"
ls -l /srv/ftp/camera 2>&1 || true

section "upload hook environment (pure-uploadscript process)"
command -v aws || echo "aws not on this shell's PATH"
aws --version 2>&1 || true
pid="$(pgrep -f pure-uploadscript | head -n1 || true)"
if [ -n "$pid" ]; then
  tr '\0' '\n' < "/proc/$pid/environ" | grep -E '^(PATH|HOME|USER|LOGNAME)=' || echo "(no PATH/HOME in the uploadscript environment)"
  hook_path="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^PATH=//p')"
  hook_home="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^HOME=//p')"
else
  echo "pure-uploadscript is not running"; hook_path=""; hook_home=""
fi

section "upload hook dry run as ftpcamera, with the uploadscript's PATH/HOME, stderr shown"
source /etc/picket.env 2>/dev/null || true
f="$(find /srv/ftp -type f ! -name '.*' | head -n1 || true)"
if [ -n "$f" ]; then
  echo "trying the real hook on: $f"
  sudo -u ftpcamera env -i PATH="${hook_path:-/usr/bin:/bin}" HOME="${hook_home:-/}" \
    bash -x /usr/local/bin/picket-upload.sh "$f" 2>&1 | tail -n 25 || true
else
  # Nothing waiting: push a tiny text file through the real hook instead (the preview Lambda
  # ignores keys that are not .arw). Proves PATH, credentials and the bucket policy together.
  echo "no files waiting; running the real hook on a throwaway text file instead"
  tmp="$(mktemp /tmp/picket-diag-XXXXXX.txt)"; echo "picket receiver diagnostic $(date -u +%FT%TZ)" > "$tmp"; chown ftpcamera "$tmp"
  sudo -u ftpcamera env -i PATH="${hook_path:-/usr/bin:/bin}" HOME="${hook_home:-/}" \
    bash -x /usr/local/bin/picket-upload.sh "$tmp" 2>&1 | tail -n 25 || true
  [ -f "$tmp" ] && echo "hook did NOT upload the file (still on disk)" || echo "hook uploaded and removed the file: OK"
  rm -f "$tmp"
fi

section "sweep timer"
systemctl status picket-sweep.timer --no-pager 2>&1 | head -n 6 || true
journalctl -u picket-sweep --no-pager -n 20 2>&1 || true

section "TLS certificate served"
openssl x509 -in /etc/ssl/private/pure-ftpd.pem -noout -subject -issuer -dates -ext subjectAltName 2>&1 || true
ls /etc/letsencrypt/live 2>&1 || echo "no Let's Encrypt directory yet"
systemctl list-timers --no-pager 2>/dev/null | grep -E 'picket|certbot' || true

section "picket journal (last 40)"
journalctl -t picket -t picket-upload -t picket-sweep --no-pager -n 40 2>&1 || true
section "pure-ftpd journal (last 60)"
journalctl -u pure-ftpd -t pure-ftpd --no-pager -n 60 2>&1 || true
section "picket-obtain-cert journal (last 30)"
journalctl -u picket-obtain-cert --no-pager -n 30 2>&1 || true

section "disk / memory"
df -h / 2>&1 | tail -n 1; free -m 2>&1 | head -n 2
