// Ovoz noto'g'ri eshitilsa — tuzatish.
// Har bir ovozli xabar uchun: eshitilgan matn, "Eshitdim" xabari va shu xabar natijasida qilingan o'zgarishlarni
// bekor qilish funksiyalari saqlanadi. Foydalanuvchi "✏️ Tuzatish"ni bosib, to'g'ri variantni matn yoki ovoz bilan
// yuboradi (yoki "Eshitdim" xabariga reply qiladi) — oldingi natija bekor qilinib, yangi matn bo'yicha qayta bajariladi.
// Xotirada saqlanadi: restart'dan keyin eski ovozlarni tuzatib bo'lmaydi (kamdan-kam kerak bo'ladi).

export type VoiceTurn = {
  chatId: number;
  /** Xabar muallifi (anonim admin bo'lsa — egasi). */
  userId: number;
  voiceMsgId: number;
  transcript: string;
  /** "🎙 Eshitdim" xabari — tuzatilganda tahrirlanadi. */
  transcriptMsgId: number | null;
  undo: (() => void)[];
  at: number;
};

export class Corrections {
  private turns = new Map<string, VoiceTurn>();
  private pending = new Map<string, { voiceMsgId: number; at: number }>();
  private ttlMs: number;
  private now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 6 * 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  private key(chatId: number, id: number) {
    return `${chatId}:${id}`;
  }

  remember(turn: Omit<VoiceTurn, "at">) {
    this.prune();
    this.turns.set(this.key(turn.chatId, turn.voiceMsgId), { ...turn, at: this.now() });
  }

  get(chatId: number, voiceMsgId: number): VoiceTurn | null {
    const t = this.turns.get(this.key(chatId, voiceMsgId));
    return t && this.now() - t.at < this.ttlMs ? t : null;
  }

  /** "Eshitdim" xabariga reply qilinganda — qaysi ovozga tegishli. */
  byTranscriptMsg(chatId: number, transcriptMsgId: number): VoiceTurn | null {
    for (const t of this.turns.values()) {
      if (t.chatId === chatId && t.transcriptMsgId === transcriptMsgId && this.now() - t.at < this.ttlMs) return t;
    }
    return null;
  }

  /** Tuzatish rejimi: shu foydalanuvchining shu chatdagi keyingi xabari — tuzatish. */
  startEdit(turn: VoiceTurn) {
    this.pending.set(this.key(turn.chatId, turn.userId), { voiceMsgId: turn.voiceMsgId, at: this.now() });
  }

  cancelEdit(chatId: number, userId: number) {
    this.pending.delete(this.key(chatId, userId));
  }

  /** Kutilayotgan tuzatishni oladi (10 daqiqa ichida). Olingandan keyin o'chiriladi. */
  takePending(chatId: number, userId: number): VoiceTurn | null {
    const k = this.key(chatId, userId);
    const p = this.pending.get(k);
    if (!p) return null;
    this.pending.delete(k);
    if (this.now() - p.at > 10 * 60 * 1000) return null;
    return this.get(chatId, p.voiceMsgId);
  }

  /** Oldingi natijani bekor qiladi. Bekor qilingan amallar soni. */
  revert(turn: VoiceTurn): number {
    let n = 0;
    for (const fn of turn.undo.splice(0)) {
      try {
        fn();
        n++;
      } catch {
        // allaqachon o'chirilgan bo'lishi mumkin
      }
    }
    return n;
  }

  private prune() {
    const now = this.now();
    for (const [k, t] of this.turns) if (now - t.at >= this.ttlMs) this.turns.delete(k);
  }
}
