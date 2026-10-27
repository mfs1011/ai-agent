# Yo'l xaritasi

Holat: 2026-10-27. Repo: github.com/mfs1011/ai-agent (`main`, `dev`).

## 1. Bajarilgan

### Asos
- Node 24+, TypeScript build'siz, `node:sqlite` (migratsiyalar), grammY + runner (chat bo'yicha navbat).
- LLM — faqat Antigravity CLI (`agy -p ... --output-format json`), API kalitsiz. Bir vaqtda ko'pi bilan 2 ta agy jarayoni (4 GB RAM uchun).
- Agent protokoli: javob matni + `<<<ACTIONS ... ACTIONS>>>` blokidagi tool chaqiruvlari (Zod bilan tekshiriladi, 3 raundgacha).
- Ishonchlilik: update dedup (bitta xabarga ikki marta javob yo'q), graceful shutdown (ish tugaguncha kutadi), eskirgan callback'lar jim o'tkaziladi.

### Telegram tuzilmasi
- **DM** — faqat sozlamalar va statistika: foydalanuvchilar, ruxsatlar, guruhlar, kanallar/feedlar, cheklovlar.
- **Shtab** (`/setup_work`) — vazifalar guruhi, barcha tool'lar.
- **Erkin chat guruhi** (`/setup_chat`) — istalgan mavzuda suhbat.
- **Kanal muhokamalari** — postlar bo'yicha suhbat, tool'larsiz.
- Anonim admin va kanal nomidan yozilgan xabarlar ham taniladi.

### Xavfsizlik
- Ruxsatlar katalogi: chat, agent, finance, ideas, ideas.implement, feeds, unlimited, admin. Native tugmalar bilan berish, olish va bloklash.
- Begonalar: bot javob bermaydi (DMda faqat "🔒 Bu bot yopiq" va ID).
- Admin bo'lmaganlarga tizim haqida hech qanday ma'lumot berilmaydi (PUBLIC_RULES).
- Kunlik limit (unlimited ruxsatisiz foydalanuvchilar uchun).

### Javoblar va UX
- Streaming: animatsiyali "o'ylayapman", bosqichma-bosqich chiqish, ⏹ to'xtatish tugmasi.
- Rich format (sarlavha, jadval, marker) did bilan, premium emoji. Rich ishlamasa HTML'ga, u ham ishlamasa oddiy matnga tushadi.
- Ovoz: agy orqali tanish (limitsiz), lug'at, matnni tozalash. ✏️ Tuzatish — matn yoki ovoz bilan qayta aytish.

### Moliya
- Ovoz yoki matn bilan xarajat/daromad, tahrirlash, o'chirish, ↩️ bekor qilish.
- Valyuta to'lov kunidagi CBU kursi bilan saqlanadi; eski yozuvlarga ham kurs qo'yilgan.
- Dublikat himoyasi: bir xil summa ±0,5% 2 soat ichida yoki bir xil matn 24 soat ichida — bot so'raydi.
- Majburiy oylik to'lovlar: qo'shish, o'zgartirish, 09:00 eslatma, ✅ To'landi / ⏭ O'tkazish.
- Oy prognozi va rasmli hisobot (`/report`).

### Boshqa modullar
- **Uzoq muddatli xotira**: "eslab qol", "unut" — har bir javobda hisobga olinadi.
- **Rasm generatsiyasi** — agy orqali.
- **Kanal feedlari**:
  - yangiliklar: 14 kunlik yangilik, havolalar tekshiriladi, soxta/umumiy havolalar tashlanadi;
  - vakansiyalar: rasmiy manbalardan (Remotive, We Work Remotely, siz qo'shgan Telegram kanallar), model faqat tanlaydi va izoh yozadi;
  - o'qilishi oson tipografiya, avval chiqqanlar takrorlanmaydi.
- **O'z-o'zini rivojlantirish**: takliflar → 👍/👎 → "Bajar" → worktree'da kod → `npm run check` → `dev`ga PR. Merge — qo'lda.

### Deploy
- `scripts/deploy.sh root@IP [--with-data|--update]` — serverni tayyorlaydi (Node 24, pm2, swap, firewall, `agent` foydalanuvchi, agy, kunlik zaxira) va botni ishga tushiradi.

## 2. Navbatdagi ishlar

1. **VPS'ga deploy.** IP va root SSH kalit kerak (`ssh-copy-id root@IP`), keyin:
   - lokal botni to'xtatish (bitta token — bitta bot);
   - `./scripts/deploy.sh root@IP --with-data`;
   - serverda agy login: `ssh -t agent@IP '~/.local/bin/agy'`, keyin `pm2 restart ai-agent`.
2. **GitHub'da default branch'ni `dev` qilish** — bot PR'lari shu yerga boradi.
3. **O'z-o'zini rivojlantirishni haqiqiy repoda sinash**: bitta kichik taklifni "Bajar" qilib, PR ochilishini tekshirish (serverda `gh auth login` kerak).
4. **Vakansiya feed'iga O'zbekiston manbalari**: DM → kanal → 📡 Telegram manbalar — mahalliy IT vakansiya kanallarini qo'shish.
5. **Lokal agy profilini ajratish** (ixtiyoriy, server uchun shart emas): `HOME="$PWD/data/agy-home" agy` bilan login, keyin `.env`da `AGY_HOME`ni yoqish.
6. **Bot DM'idagi test xabarni o'chirish** (avval yuborilgan).

## 3. Keyingi imkoniyatlar

### Kundalik yordamchi
- **Eslatmalar**: "ertaga 10 da ... eslat", takroriy eslatmalar, kechiktirish tugmasi.
- **Kunlik brif** (ertalab): bugungi to'lovlar, eslatmalar, kecha xarajatlari, feedlardagi muhim narsa.
- **Second brain**: havola, fayl, ovozli eslatma saqlash va tabiiy tilda qidirish.
- **Kalendar** (Google Calendar) bilan sinxron.

### Moliya
- Kategoriya bo'yicha oylik limit va oshganda ogohlantirish.
- Haftalik/oylik avtomatik hisobot va o'tgan oy bilan solishtirish.
- Chek rasmidan summa va do'konni o'qish.
- Jamg'arma maqsadlari (masalan, "noutbuk uchun $1500") va progress.
- Qarzlar: kimga berildi/kimdan olindi, qaytarish eslatmasi.
- Excel/CSV eksport.

### Ish va daromad
- **Job Hunter+**: vakansiyani rezyumega moslik bo'yicha baholash, cover letter qoralamasi.
- **Freelance Hunter**: buyurtmalarni topish, budjet va murakkablikni baholash, taklif xati qoralamasi (yuborish — faqat siz).
- **Market / raqobatchi tadqiqoti**: manbalar bilan hisobot.
- **SaaS g'oya tekshiruvi**: bozor, auditoriya, MVP doirasi.

### Dasturlash
- **Developer agent**: istalgan repo bo'yicha vazifa → branch → PR (hozir faqat o'zi uchun).
- **Code review**: PR'ni tahlil qilib izoh qoldirish; CodeRabbit izohlariga javob.
- **Dependency watcher**: yangilanish va breaking change'lar, yangilash PR'i.
- **Security audit**: maxfiy kalitlar, zaif paketlar, xavfli sozlamalar.
- **Watchdog**: sayt/API health check, SSL muddati, server resurslari — muammo bo'lsa xabar.

### Platforma
- **Telegram Mini App** panel: sozlamalar, hisobotlar va grafiklar vizual ko'rinishda.
- LLM statistikasi: chaqiruvlar soni, vaqti, xatolar — DMda.
- Bir nechta model: oddiy ish uchun tez model, murakkab ish uchun kuchli model (avtomatik tanlash).
- Zaxira nusxani boshqa joyga (masalan, Telegram'ga shifrlangan holda) yuborish.
- Ko'p tilli javoblar (o'zbek / rus / ingliz) foydalanuvchi tiliga qarab.
