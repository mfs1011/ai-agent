// Model Markdown'da yozadi, Telegram esa HTML'ning kichik qismini tushunadi.
// Bu yerda Markdown -> Telegram HTML: <b> <i> <s> <u> <code> <pre> <a> <blockquote> <tg-spoiler>.
// Stream paytida matn yarim bo'lishi mumkin (yopilmagan ** yoki ```) — natija baribir to'g'ri (yopilgan) HTML bo'ladi.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

/** Bitta qator ichidagi formatlash. Kirish — xom matn (escape qilinmagan). */
export function inlineMd(text: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  // 1) `kod` — ichida hech narsa formatlanmaydi
  let s = text.replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${esc(code)}</code>`));
  // 2) havolalar [matn](https://...)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) =>
    hold(`<a href="${escAttr(url)}">${esc(label)}</a>`),
  );
  // 3) qolgani escape, keyin belgilar
  s = esc(s);
  s = s.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, "<b>$1</b>");
  s = s.replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, "<u>$1</u>");
  s = s.replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, "<s>$1</s>");
  // ==marker== (rich message'da sariq fon) — oddiy HTML'da qalin + tagiga chizilgan
  s = s.replace(/==(?=\S)([^=\n]+?)(?<=\S)==/g, "<b><u>$1</u></b>");
  s = s.replace(/\|\|(?=\S)([^|\n]+?)(?<=\S)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");
  // *kursiv* va _kursiv_ — so'z ichidagi (snake_case, 2*3*4) belgilarga tegmaydi
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, "$1<i>$2</i>");
  // yopilmagan qolgan ** (stream paytida) ko'rinmasin
  s = s.replace(/\*\*(?=\S*$)/, "");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]!);
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

/** Markdown matnni Telegram HTML'ga o'giradi. */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // ```kod bloki``` (yopilmagan bo'lsa — oxirigacha kod)
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushQuote();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      const lang = fence[1] ? ` class="language-${escAttr(fence[1])}"` : "";
      out.push(`<pre><code${lang}>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }

    // jadval -> monospace (Telegram jadvalni bilmaydi)
    if (isTableRow(line)) {
      flushQuote();
      const rows: string[] = [];
      while (i < lines.length && (isTableRow(lines[i]!) || isTableSep(lines[i]!))) {
        if (!isTableSep(lines[i]!)) rows.push(lines[i]!.trim());
        i++;
      }
      i--;
      const cells = rows.map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/\*\*/g, "")));
      const widths = cells[0]!.map((_, c) => Math.max(...cells.map((r) => (r[c] ?? "").length)));
      const text = cells.map((r) => r.map((c, k) => c.padEnd(widths[k]!)).join("  ").trimEnd()).join("\n");
      out.push(`<pre>${esc(text)}</pre>`);
      continue;
    }

    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      quote.push(inlineMd(q[1]!));
      continue;
    }
    flushQuote();

    const h = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
    if (h) {
      out.push(`<b>${inlineMd(h[1]!)}</b>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push("──────────");
      continue;
    }
    const li = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (li) {
      const depth = Math.min(3, Math.floor(li[1]!.length / 2));
      out.push(`${"   ".repeat(depth)}${depth ? "◦" : "•"} ${inlineMd(li[2]!)}`);
      continue;
    }
    out.push(inlineMd(line));
  }
  flushQuote();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Formatlashsiz ko'rinish (HTML rad etilsa zaxira): belgilar olib tashlanadi. */
export function mdToPlain(md: string): string {
  return md
    .replace(/^\s*```.*$/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\*\*|__|~~|\|\|/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)");
}

/** Telegram "can't parse entities" — HTML'ni rad etdi. */
export function isParseError(e: unknown): boolean {
  return e instanceof Error && /can't parse entities|unsupported start tag|unexpected end tag/i.test(e.message);
}
