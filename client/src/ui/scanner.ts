/**
 * Scanner de codes-barres (Datalogic, gamme QuickScan, et tout scanner USB
 * en mode « clavier » — réglage d'usine de ces modèles).
 *
 * Le scanner « tape » le code très vite puis envoie Entrée. On le distingue
 * d'une frappe humaine par la vitesse (< 40 ms entre deux touches).
 *
 * Disposition clavier : le scanner envoie les touches d'un clavier QWERTY
 * américain. Sur un PC en AZERTY belge ou français, lire `e.key` donnerait
 * « &é"'( » au lieu de « 12345 ». On lit donc la touche PHYSIQUE (`e.code`,
 * ex. « Digit1 ») et on la convertit nous-mêmes : ça marche quel que soit
 * le clavier de Windows/Linux.
 *
 * Dans un champ de saisie, rien n'est intercepté (un scan y tape le code,
 * pratique pour le champ « code-barres » du catalogue).
 */

const SCAN_MAX_GAP_MS = 40;
const SCAN_MIN_LENGTH = 4;

const US_SHIFT: Record<string, string> = {
  Digit1: "!", Digit2: "@", Digit3: "#", Digit4: "$", Digit5: "%", Digit6: "^", Digit7: "&", Digit8: "*", Digit9: "(", Digit0: ")",
  Minus: "_", Equal: "+", Slash: "?", Period: ">", Comma: "<", Semicolon: ":", Quote: '"', BracketLeft: "{", BracketRight: "}", Backslash: "|", Backquote: "~",
};
const US_PLAIN: Record<string, string> = {
  Minus: "-", Equal: "=", Slash: "/", Period: ".", Comma: ",", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Backquote: "`", Space: " ",
  NumpadDivide: "/", NumpadMultiply: "*", NumpadSubtract: "-", NumpadAdd: "+", NumpadDecimal: ".",
};

/** Touche physique → caractère tel que le scanner l'a voulu (QWERTY US). */
function scanChar(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Digit\d$/.test(c)) return e.shiftKey ? US_SHIFT[c] : c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (/^Key[A-Z]$/.test(c)) {
    const ch = c.slice(3);
    return e.shiftKey !== e.getModifierState("CapsLock") ? ch : ch.toLowerCase();
  }
  if (e.shiftKey && US_SHIFT[c]) return US_SHIFT[c];
  return US_PLAIN[c] ?? null;
}

type ScanHandler = (code: string) => void;

const scanner = {
  /** Gestionnaire de l'écran affiché (remis à zéro à chaque changement d'écran). */
  handler: null as ScanHandler | null,
  /** Utilisé quand l'écran affiché ne gère pas les scans. */
  fallback: null as ScanHandler | null,
  /** Écouteurs permanents (ex. test du scanner dans les réglages). */
  listeners: new Set<ScanHandler>(),
  last: "",
};

function onScan(fn: ScanHandler): void {
  scanner.handler = fn;
}

(() => {
  let buf: { ch: string; key: string; code: string; shift: boolean; t: number }[] = [];
  let timer = 0;
  const REPLAY = "__gloryReplay";

  const isField = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");

  /** Pas un scan : on rejoue les touches retenues pour qu'elles agissent normalement (pavé, raccourcis). */
  const replay = () => {
    const keys = buf;
    buf = [];
    for (const k of keys) {
      const ev = new KeyboardEvent("keydown", { key: k.key, code: k.code, shiftKey: k.shift, bubbles: true, cancelable: true });
      (ev as unknown as Record<string, boolean>)[REPLAY] = true;
      (document.activeElement ?? document.body).dispatchEvent(ev);
    }
  };

  const emit = (code: string) => {
    buf = [];
    scanner.last = code;
    for (const l of scanner.listeners) l(code);
    if (document.querySelector(".overlay")) return; // une fenêtre est ouverte : on n'agit pas sur l'écran derrière
    (scanner.handler ?? scanner.fallback)?.(code);
  };

  const isFast = () => buf.length >= 2 && buf.every((k, i) => i === 0 || k.t - buf[i - 1].t <= SCAN_MAX_GAP_MS);

  window.addEventListener(
    "keydown",
    (e) => {
      if ((e as unknown as Record<string, boolean>)[REPLAY] || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isField(e.target)) return;
      if (e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter" || e.key === "Tab") {
        if (buf.length >= SCAN_MIN_LENGTH && isFast()) {
          e.preventDefault();
          e.stopPropagation();
          window.clearTimeout(timer);
          emit(buf.map((k) => k.ch).join(""));
          return;
        }
        window.clearTimeout(timer);
        replay();
        return;
      }
      const ch = scanChar(e);
      if (ch === null) {
        window.clearTimeout(timer);
        replay();
        return;
      }
      // On retient la touche un court instant pour voir si d'autres suivent très vite.
      e.preventDefault();
      e.stopPropagation();
      const now = performance.now();
      if (buf.length && now - buf[buf.length - 1].t > SCAN_MAX_GAP_MS) replay();
      buf.push({ ch, key: e.key, code: e.code, shift: e.shiftKey, t: now });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // Scanner réglé sans « Entrée » à la fin : une rafale rapide assez longue est un scan.
        if (buf.length >= 6 && isFast()) emit(buf.map((k) => k.ch).join(""));
        else replay();
      }, 80);
    },
    true
  );
})();
