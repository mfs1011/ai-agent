#!/usr/bin/env bash
# Deploy / yangilash — kompyuteringizdan bitta buyruq bilan.
#
#   ./scripts/deploy.sh root@1.2.3.4              # birinchi marta: server tayyorlanadi + bot o'rnatiladi
#   ./scripts/deploy.sh root@1.2.3.4 --with-data  # + lokal bazani (data/agent.db) serverga ko'chiradi
#   ./scripts/deploy.sh root@1.2.3.4 --update     # keyingi safar: faqat kod yangilanadi va bot qayta ishga tushadi
#
# Talab: serverga SSH kalit bilan kirish (ssh-copy-id root@IP).
set -euo pipefail

TARGET="${1:?Foydalanish: ./scripts/deploy.sh root@IP [--with-data|--update]}"
MODE="${2:-}"
HOST="${TARGET#*@}"
APP_USER="agent"
APP_DIR="/home/${APP_USER}/ai-agent"
cd "$(dirname "$0")/.."

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

[ -f .env ] || { echo ".env topilmadi"; exit 1; }

log "Lokal tekshiruv: typecheck + testlar"
npm run check >/dev/null

if [ "${MODE}" != "--update" ]; then
  log "Server tayyorlanmoqda (${TARGET})"
  ssh -o StrictHostKeyChecking=accept-new "${TARGET}" 'bash -s' < scripts/server-setup.sh
fi

log "Kod yuborilmoqda"
ssh "${TARGET}" "mkdir -p ${APP_DIR} && chown ${APP_USER}:${APP_USER} ${APP_DIR}"
rsync -az --delete \
  --exclude node_modules --exclude data --exclude logs --exclude .env --exclude .git --exclude '*.db*' \
  ./ "${APP_USER}@${HOST}:${APP_DIR}/"

# .env: serverda bot o'z HOME'idagi qattiq agy profilidan foydalanadi — AGY_HOME kerak emas
log ".env yuborilmoqda"
grep -Ev '^#?[[:space:]]*AGY_HOME=' .env | ssh "${APP_USER}@${HOST}" "cat > ${APP_DIR}/.env && chmod 600 ${APP_DIR}/.env"

if [ "${MODE}" = "--with-data" ]; then
  log "Baza ko'chirilmoqda (lokal bot to'xtatilgan bo'lishi kerak!)"
  SNAP="$(mktemp)"
  sqlite3 data/agent.db ".backup '${SNAP}'"
  ssh "${APP_USER}@${HOST}" "mkdir -p ${APP_DIR}/data"
  scp -q "${SNAP}" "${APP_USER}@${HOST}:${APP_DIR}/data/agent.db"
  rm -f "${SNAP}"
fi

log "agy xavfsiz sozlamalari yangilanmoqda"
ssh "${APP_USER}@${HOST}" "mkdir -p ~/.gemini/antigravity-cli && cp ${APP_DIR}/deploy/agy-settings.json ~/.gemini/antigravity-cli/settings.json"

log "Paketlar va ishga tushirish (pm2)"
ssh "${APP_USER}@${HOST}" "bash -lc 'cd ${APP_DIR} && npm ci --omit=dev --no-audit --no-fund >/dev/null && mkdir -p logs data && \
  (pm2 describe ai-agent >/dev/null 2>&1 && pm2 reload ecosystem.config.cjs || pm2 start ecosystem.config.cjs) && pm2 save >/dev/null'"

log "Holat"
ssh "${APP_USER}@${HOST}" "bash -lc 'pm2 status ai-agent; tail -n 5 ${APP_DIR}/logs/out.log 2>/dev/null || true'"

cat <<EOF

Tayyor. Agar agy hali login qilinmagan bo'lsa (birinchi deploy):
  ssh -t ${APP_USER}@${HOST} '~/.local/bin/agy'     # havolani brauzerda oching, login, keyin /exit
  ssh ${APP_USER}@${HOST} 'pm2 restart ai-agent'

Log:      ssh ${APP_USER}@${HOST} 'pm2 logs ai-agent'
Zaxira:   ~/backups (har kuni 03:30, 14 kun)
EOF
