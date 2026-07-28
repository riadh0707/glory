/**
 * Table des Result Codes SOAP — reprise intégrale de docs/error-codes.md
 * ("Table complète des codes (IF Spec p.238-239)"). Un seul point de vérité
 * pour l'interprétation des attributs `result` retournés par le FCC, utilisé
 * par core/soap-client pour ne jamais afficher un code brut sans sa
 * signification (exigence explicite du sprint).
 */
export const RESULT_CODES: Record<number, string> = {
  0: "success",
  1: "cancel",
  2: "reset",
  3: "occupied by other",
  4: "occupation not available",
  5: "not occupied",
  6: "designation denomination shortage",
  9: "cancel change shortage",
  10: "change shortage",
  11: "exclusive error",
  12: "dispensed change inconsistency",
  13: "auto recovery failure",
  15: "user authentication failure",
  16: "number of session over",
  17: "occupied by itself",
  20: "session not available",
  21: "invalid session",
  22: "session timeout",
  26: "manual deposit disagreement",
  32: "verify collect/replenish failed",
  33: "IF cassette illegal denomination",
  34: "shortage of capacity of stacker",
  35: "CI-Server communication error",
  36: "number of registration over",
  40: "invalid cassette number",
  41: "improper cassette",
  43: "exchange rate error",
  44: "Counted Category2",
  96: "Duplicate Transaction",
  98: "parameter error (type error)",
  99: "program inner error",
  100: "device error",
};

/**
 * Décrit un code résultat. Un code absent de la table (non documenté dans
 * docs/error-codes.md) est signalé explicitement comme tel plutôt que
 * silencieusement ignoré — voir docs/development-notes.md, "Ne jamais deviner".
 */
export function describeResultCode(code: number): string {
  const meaning = RESULT_CODES[code];
  if (meaning === undefined) {
    return `code ${code} NON DOCUMENTÉ dans docs/error-codes.md — à vérifier sur IF Spec p.238-239 et à ajouter à la table si confirmé`;
  }
  return `${code} (${meaning})`;
}
