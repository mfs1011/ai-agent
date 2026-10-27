# Universal AI Agent (Telegram)

Telegram orqali boshqariladigan shaxsiy AI agent. LLM — **Antigravity CLI** (`agy -p ... --output-format json`), API emas.

## Qayerda nima

| Joy | Vazifa | Kim |
|---|---|---|
| **Bot DM** | Faqat sozlamalar: statistika, foydalanuvchilar va ruxsatlar, kanallar/feedlar, ishchi guruh | Egasi, adminlar (`feeds` ruxsatlilar — kanallar) |
| **Ishchi guruh** | Bot bilan istalgan suhbat, ovoz, moliya, loyiha takliflari | `agent` ruxsati borlar; har bir tool o'z ruxsati bilan |
| **Kanallar** | Bot har kuni belgilangan soatda izlanma tashlaydi (yangiliklar, vakansiyalar…) | — |
| **Kanal muhokama guruhlari** | Bot chaqirilsa javob beradi. **Tool yo'q** — hech narsani o'zgartira olmaydi | Hamma (ruxsatsizlarga kunlik limit) |

### Muhokamada botni chaqirish
- `@bot_username savol` — mention
- botning xabariga **reply**
- `/ask savol`

### Ruxsatlar
`agent`, `finance`, `ideas`, `ideas.implement`, `feeds`, `unlimited`, `admin`. Egasida — hammasi. `admin`ni faqat egasi beradi.
Boshqaruv: bot DM → /settings → 👥 Foydalanuvchilar.

## O'zini rivojlantirish
1. Har kuni (yoki `/ideas`) bot loyiha bo'yicha takliflar yuboradi → 👍/👎.
2. Yoqqanini **▶️ Bajar** → alohida git worktree'da agent kod yozadi.
3. `npm run check` o'tsa → `agent/sg-<id>-...` branch, push, **PR `dev`ga**. Hisobot + PR havolasi chatga keladi.
4. **Merge — faqat siz, qo'lda.** Bot hech qachon merge qilmaydi va `dev`/`main`ga push qilmaydi.

## Lokal ishga tushirish
```bash
npm install
cp .env.example .env    # BOT_TOKEN, OWNER_ID
npm run check           # typecheck + testlar
npm run dev             # watch rejimida
```
Telegram'da:
1. Botga DM'da `/start` — ID'ingiz ko'rinadi, `OWNER_ID`ga yozing.
2. Guruh yarating → botni qo'shing va **admin** qiling → guruhda `/setup_work`.
3. Kanal(lar) → botni admin qiling (post huquqi) → kanalga muhokama guruhi ulang → botni u guruhga ham admin qiling.
4. DM → /settings → 📢 Kanallar → feed qo'shing.

## Xavfsizlik (agy)
- agy'ga botning secretlari berilmaydi (`safeEnv`): faqat HOME, PATH va h.k.
- Chat so'rovlari bo'sh sandbox papkada ishlaydi; headless rejimda terminal va fayl yozish avtomatik rad etiladi.
- **Fayl o'qish** esa agy sozlamasiga bog'liq. Startup'da bot tekshiradi (canary): sandbox tashqarisidagi faylni o'qiy olsa — ommaviy muhokama **o'chadi** va egasiga xabar boradi.
- Serverda bot uchun alohida OS user va `deploy/agy-settings.json` → `~/.gemini/antigravity-cli/settings.json` (`allowNonWorkspaceAccess: false`, xavfli buyruqlar deny).

## Xavfsiz agy profili (muhokama hamma uchun ochilishi uchun)
Bot agy'ni **alohida profil** bilan ishlatadi: o'z `settings.json`i (`allowNonWorkspaceAccess: false`, xavfli buyruqlar taqiqlangan) va o'z login'i. Shaxsiy agy sozlamalaringiz o'zgarmaydi.
```bash
mkdir -p data/agy-home/.gemini/antigravity-cli && chmod 700 data/agy-home
cp deploy/agy-settings.json data/agy-home/.gemini/antigravity-cli/settings.json
HOME="$PWD/data/agy-home" agy      # bir marta login qiling, keyin /exit
echo "AGY_HOME=./data/agy-home" >> .env
```
Botni qayta ishga tushiring: startup'da xavfsizlik testi o'tsa, kanal muhokamalari hamma uchun avtomatik ochiladi.

## Deploy (VPS, pm2)
Ubuntu 22.04+/Debian 12+, 2 vCPU / 4 GB yetarli. Kompyuteringizdan:
```bash
ssh-copy-id root@IP                              # bir marta: SSH kalit
./scripts/deploy.sh root@IP --with-data          # birinchi deploy + lokal bazani ko'chirish
ssh -t agent@IP '~/.local/bin/agy'               # bir marta: agy login (havolani brauzerda oching), /exit
ssh agent@IP 'pm2 restart universal-agent'
```
Keyingi yangilashlar: `./scripts/deploy.sh root@IP --update`.

Skript nima qiladi (`scripts/server-setup.sh`): Node 24, pm2 (+logrotate), `agent` foydalanuvchisi (sudo'siz), 2 GB swap,
firewall (faqat SSH), agy CLI va uning qattiq `settings.json`i, server qayta yonganda avtomatik ishga tushish,
har kuni 03:30 da bazaning zaxirasi (`~/backups`, 14 kun).

⚠️ Bitta token bilan faqat bitta bot ishlay oladi — serverda ishga tushirishdan oldin lokal botni to'xtating.

## Tuzilma
```
src/
  index.ts           — yig'ish va ishga tushirish
  config.ts          — .env (Zod)
  db.ts              — SQLite + migratsiyalar
  core/              — agent (router), tool'lar, ruxsatlar, navbat, vaqt, holat
  llm/               — LlmRunner/CodingAgent interfeyslari, agy, claude, xavfsizlik probe
  stt/               — ovoz → matn
  bot/               — settings (DM), groups (ishchi guruh + muhokama), ui
  modules/finance    — moliya
  modules/ideas      — takliflar va PR pipeline
  modules/feeds      — kanal feedlari
```
