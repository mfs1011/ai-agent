#!/usr/bin/env bash
# Serverni bir marta tayyorlash (Ubuntu 22.04+/Debian 12+, root sifatida). Qayta ishga tushirish xavfsiz.
# deploy.sh buni avtomatik chaqiradi.
set -euo pipefail

APP_USER="${APP_USER:-agent}"
APP_HOME="/home/${APP_USER}"
NODE_MAJOR="${NODE_MAJOR:-24}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

log "Paketlar"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git sqlite3 rsync ufw cron >/dev/null

log "Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

log "pm2"
command -v pm2 >/dev/null || npm install -g pm2@5 >/dev/null
pm2 -v

log "Foydalanuvchi: ${APP_USER} (sudo'siz — bot va agy faqat o'z papkasida)"
id -u "${APP_USER}" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "${APP_USER}"
mkdir -p "${APP_HOME}/.ssh" && chmod 700 "${APP_HOME}/.ssh"
# root'ning kalitlari bilan agent'ga ham SSH orqali kirish (deploy uchun)
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys "${APP_HOME}/.ssh/authorized_keys"
  chmod 600 "${APP_HOME}/.ssh/authorized_keys"
fi
chown -R "${APP_USER}:${APP_USER}" "${APP_HOME}/.ssh"

log "Swap (2 GB) — agy jarayonlari uchun zaxira"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Firewall: faqat SSH (bot long polling ishlatadi — kiruvchi port kerak emas)"
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null

log "Antigravity CLI (agy) — ${APP_USER} uchun"
if ! sudo -u "${APP_USER}" -H bash -lc 'command -v agy || test -x ~/.local/bin/agy' >/dev/null 2>&1; then
  sudo -u "${APP_USER}" -H bash -lc 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
fi
sudo -u "${APP_USER}" -H bash -lc 'grep -q ".local/bin" ~/.profile || echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> ~/.profile'
sudo -u "${APP_USER}" -H bash -lc '~/.local/bin/agy --version' || { echo "agy o'rnatilmadi — qo'lda o'rnating"; exit 1; }

log "agy xavfsiz sozlamalari (sandbox'dan tashqari fayl o'qish yo'q, xavfli buyruqlar taqiqlangan)"
AGY_CFG="${APP_HOME}/.gemini/antigravity-cli"
mkdir -p "${AGY_CFG}"
if [ -f "${APP_HOME}/ai-agent/deploy/agy-settings.json" ]; then
  cp "${APP_HOME}/ai-agent/deploy/agy-settings.json" "${AGY_CFG}/settings.json"
fi
chown -R "${APP_USER}:${APP_USER}" "${APP_HOME}/.gemini"

log "pm2 — server qayta yonganda bot avtomatik ishga tushadi"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "${APP_USER}" --hp "${APP_HOME}" >/dev/null
sudo -u "${APP_USER}" -H bash -lc 'pm2 install pm2-logrotate >/dev/null 2>&1 || true; pm2 set pm2-logrotate:max_size 10M >/dev/null; pm2 set pm2-logrotate:retain 7 >/dev/null'

log "Kunlik zaxira: 03:30 da bazaning nusxasi, 14 kun saqlanadi"
mkdir -p "${APP_HOME}/backups" && chown "${APP_USER}:${APP_USER}" "${APP_HOME}/backups"
CRON_LINE="30 3 * * * sqlite3 ${APP_HOME}/ai-agent/data/agent.db \".backup '${APP_HOME}/backups/agent-\$(date +\\%F).db'\" && find ${APP_HOME}/backups -name 'agent-*.db' -mtime +14 -delete"
( crontab -u "${APP_USER}" -l 2>/dev/null | grep -v 'agent.db' ; echo "${CRON_LINE}" ) | crontab -u "${APP_USER}" -

log "Server tayyor"
