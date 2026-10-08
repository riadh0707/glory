/**
 * Erreurs matérielles des modules Glory (billets RBW-100, pièces RCW-100).
 *
 * Le terminal envoie un code d'erreur numérique (eventError/ErrorCode, ou
 * l'attribut `val` de DevStatus). Écrit en hexadécimal sur 4 caractères, il
 * donne le « code détaillé » des spécifications Glory (TMB67121 billets,
 * TMB67114 pièces) : les 2 premiers caractères = famille de panne, les 2
 * suivants = endroit précis (capteur, moteur, compartiment).
 *
 * - glory-errors.json : table officielle du terminal (BBXErrorMessageList.xml)
 *   code → [message technique, animation d'aide servie par le terminal].
 * - FAMILIES : explications en français pour le commerçant, par famille.
 */
import table from "./glory-errors.json";

export interface DeviceErrorInfo {
  devid: string;
  /** « billets » ou « pièces ». */
  module: string;
  /** Code détaillé, 4 caractères hexadécimaux (ex. « 0501 »). */
  code: string;
  /** Titre court en français. */
  title: string;
  /** Ce qui se passe et où. */
  explanation: string;
  /** Marche à suivre. */
  steps: string[];
  /** true = intervention d'un technicien probablement nécessaire. */
  technician: boolean;
  /** Message technique Glory (anglais), avec le capteur / l'organe en cause. */
  detail: string;
  /** Chemin de l'animation d'aide sur le terminal (ex. /help/rcw100/rcw_anm_01.gif), vide si aucune. */
  helpPath: string;
}

type Family = { match: RegExp; title: string; explanation: string; steps: string[]; technician?: boolean };

const REMOVE_COIN = "Ouvrez la partie indiquée sur l'animation et retirez les pièces ou objets coincés (trombone, pièce étrangère…).";
const REMOVE_NOTE = "Ouvrez la partie indiquée sur l'animation et retirez les billets ou objets coincés (billet froissé, ticket, trombone…).";
const CLOSE_RESET = "Refermez correctement toutes les trappes, puis appuyez sur « Réinitialiser ».";
const RESET = "Appuyez sur « Réinitialiser ».";
const CALL = "Si l'erreur revient, notez le code et contactez votre technicien Glory.";

/** Familles du module PIÈCES (RCW-100, spécification TMB67114). */
const COIN_FAMILIES: Family[] = [
  { match: /^0501/, title: "Unité d'entrée des pièces mal fermée", explanation: "Le module pièces détecte que l'unité d'entrée (en haut) est ouverte ou mal enclenchée.", steps: ["Repoussez l'unité d'entrée des pièces jusqu'au clic.", RESET] },
  { match: /^0502/, title: "Unité de sortie des pièces mal fermée", explanation: "Le module pièces détecte que l'unité de sortie (sur le côté) est ouverte ou mal enclenchée.", steps: ["Repoussez l'unité de transport de sortie jusqu'au clic.", RESET] },
  { match: /^0503/, title: "Capot de tri des pièces ouvert", explanation: "Le capot de l'unité de tri (trappe de bourrage) est ouvert ou mal fermé.", steps: ["Refermez la trappe de bourrage du haut.", RESET] },
  { match: /^0504/, title: "Bac de débordement des pièces mal placé", explanation: "Le bac de débordement (pièces en trop) est retiré ou mal remis.", steps: ["Remettez le bac de débordement en place.", RESET] },
  { match: /^05/, title: "Une partie du module pièces est ouverte", explanation: "Une unité ou une trappe du module pièces n'est pas correctement fermée.", steps: [CLOSE_RESET] },
  { match: /^00/, title: "Moteur du module pièces bloqué", explanation: "Un moteur ne tourne pas normalement : le plus souvent des pièces ou un objet coincés dans l'entrée ou le circuit des pièces.", steps: [REMOVE_COIN, CLOSE_RESET, CALL] },
  { match: /^01/, title: "Pièces coincées sur un capteur", explanation: "Des pièces ou un objet sont restés sur un capteur du circuit des pièces.", steps: [REMOVE_COIN, CLOSE_RESET, CALL] },
  { match: /^02/, title: "Bourrage dans le circuit des pièces", explanation: "Des pièces sont bloquées entre deux capteurs du circuit (pièce abîmée, étrangère ou objet).", steps: [REMOVE_COIN, CLOSE_RESET, CALL] },
  { match: /^03/, title: "Capteur masqué / mauvais aiguillage des pièces", explanation: "Un capteur est masqué alors qu'il ne devrait pas l'être, ou une pièce n'a pas pris le bon chemin.", steps: [REMOVE_COIN, CLOSE_RESET, CALL] },
  { match: /^04/, title: "Aiguillage des pièces bloqué", explanation: "Une porte d'aiguillage interne ne s'ouvre ou ne se ferme pas correctement (pièce coincée).", steps: [REMOVE_COIN, CLOSE_RESET, CALL] },
  { match: /^09/, title: "Verrou du module pièces", explanation: "Le verrou électrique de la cassette ou de la porte ne fonctionne pas comme prévu.", steps: ["Vérifiez que la porte et la cassette de collecte sont bien en place.", RESET, CALL] },
  { match: /^2[0-4]/, title: "Capteur du module pièces en défaut", explanation: "Un capteur ne répond pas correctement : il peut être sale, masqué par une pièce, ou défectueux.", steps: [REMOVE_COIN, CLOSE_RESET, CALL] },
  { match: /^36/, title: "Problème électrique (module pièces)", explanation: "Connecteur débranché ou tension anormale dans le module pièces.", steps: ["Éteignez puis rallumez le terminal.", CALL], technician: true },
  { match: /^3[8B]/, title: "Unité de reconnaissance des pièces", explanation: "L'unité qui reconnaît les pièces ne répond pas ou est sale.", steps: [RESET, "Si l'erreur persiste, éteignez puis rallumez le terminal.", CALL], technician: true },
  { match: /^4401/, title: "Coupure de courant pendant une opération", explanation: "Le courant a été coupé pendant un mouvement de pièces : des pièces peuvent être restées dans le circuit.", steps: [REMOVE_COIN, RESET, "Vérifiez l'encaisse après la réinitialisation."] },
  { match: /^4[0-9]/, title: "Erreur interne du module pièces", explanation: "Erreur de programme ou de mémoire du module pièces.", steps: ["Éteignez puis rallumez le terminal.", CALL], technician: true },
  { match: /^A0/, title: "Porte de débordement des pièces bloquée", explanation: "La porte vers le bac de débordement ne s'ouvre ou ne se ferme pas (pièce coincée).", steps: [REMOVE_COIN, CLOSE_RESET, CALL] },
  { match: /^B001/, title: "Pièces restées dans le transport de dépôt", explanation: "Après un incident, des pièces sont restées dans le circuit qui mène les pièces déposées vers les stockeurs.", steps: [REMOVE_COIN, CLOSE_RESET] },
  { match: /^C001/, title: "Pièces restées dans l'entrée", explanation: "Des pièces ou un objet sont restés dans l'unité d'entrée des pièces.", steps: ["Retirez les pièces ou objets restés dans l'entrée des pièces.", RESET] },
  { match: /^D0/, title: "Porte de retour des pièces bloquée", explanation: "La porte qui rend les pièces refusées au client ne fonctionne pas correctement (pièce coincée).", steps: [REMOVE_COIN, CLOSE_RESET, CALL] },
  { match: /^E/, title: "Problème dans un stockeur de pièces", explanation: "Un stockeur (compartiment d'une valeur de pièce) n'arrive pas à distribuer correctement : pièces coincées ou comptage incohérent.", steps: [REMOVE_COIN, CLOSE_RESET, "Après la réinitialisation, vérifiez l'encaisse.", CALL] },
  { match: /^999/, title: "Vérification du module pièces", explanation: "Le module pièces signale un problème pendant sa vérification d'état.", steps: [CLOSE_RESET, CALL] },
];

/** Familles du module BILLETS (RBW-100, spécification TMB67121). */
const NOTE_FAMILIES: Family[] = [
  { match: /^0501|^0511/, title: "Porte de la cassette billets ouverte", explanation: "La porte de la cassette de collecte des billets est ouverte ou mal fermée.", steps: ["Refermez la porte de la cassette billets.", RESET] },
  { match: /^0502|^0512/, title: "Porte latérale du module billets ouverte", explanation: "La porte latérale (accès aux bourrages) du module billets est ouverte ou mal fermée.", steps: ["Refermez la porte latérale du module billets.", RESET] },
  { match: /^05/, title: "Une porte du module billets est ouverte", explanation: "Une porte ou une trappe du module billets n'est pas correctement fermée.", steps: [CLOSE_RESET] },
  { match: /^00/, title: "Moteur du module billets bloqué", explanation: "Un moteur ne tourne pas normalement, souvent à cause d'un billet froissé ou d'un objet coincé dans le circuit.", steps: [REMOVE_NOTE, CLOSE_RESET, CALL] },
  { match: /^01/, title: "Billet coincé sur un capteur", explanation: "Un billet ou un objet est resté sur un capteur du circuit des billets.", steps: [REMOVE_NOTE, CLOSE_RESET, CALL] },
  { match: /^02/, title: "Bourrage de billets", explanation: "Un billet est bloqué entre deux capteurs du circuit (billet froissé, déchiré, scotché ou objet).", steps: [REMOVE_NOTE, CLOSE_RESET, CALL] },
  { match: /^03/, title: "Capteur masqué (module billets)", explanation: "Un capteur est masqué alors qu'il ne devrait pas l'être, souvent par un morceau de billet ou un objet.", steps: [REMOVE_NOTE, CLOSE_RESET, CALL] },
  { match: /^04/, title: "Billet de longueur anormale", explanation: "Un billet trop court, trop long, plié ou deux billets collés ont été détectés.", steps: [REMOVE_NOTE, "Défroissez le billet ou séparez les billets collés avant de les réinsérer.", RESET] },
  { match: /^07/, title: "Aiguillage des billets bloqué", explanation: "Un aiguillage interne du circuit des billets ne bouge pas correctement.", steps: [REMOVE_NOTE, CLOSE_RESET, CALL] },
  { match: /^08/, title: "Volet de sortie des billets bloqué", explanation: "Le volet de la fente de sortie des billets ne s'ouvre ou ne se ferme pas.", steps: ["Retirez tout billet ou objet resté dans la fente de sortie.", RESET, CALL] },
  { match: /^09/, title: "Verrou du module billets", explanation: "Le verrou électrique de la cassette billets ne fonctionne pas comme prévu.", steps: ["Vérifiez que la cassette billets est bien en place et sa porte fermée.", RESET, CALL] },
  { match: /^1[0-3]/, title: "Nombre de billets incohérent", explanation: "Le nombre de billets distribués, collectés ou comptés ne correspond pas à ce qui était prévu.", steps: [REMOVE_NOTE, RESET, "Vérifiez l'encaisse et comptez l'argent rendu au client.", CALL] },
  { match: /^14/, title: "Billet douteux détecté", explanation: "Un billet suspect (catégorie 2/3 selon la BCE) a été détecté et conservé par la machine.", steps: ["Ne rendez pas ce billet au client.", "Signalez-le selon la procédure de votre banque.", RESET] },
  { match: /^2[0-4]/, title: "Capteur du module billets en défaut", explanation: "Un capteur ne répond pas correctement : il peut être sale, masqué par un billet, ou défectueux.", steps: [REMOVE_NOTE, CLOSE_RESET, CALL] },
  { match: /^36/, title: "Problème électrique (module billets)", explanation: "Connecteur débranché ou tension anormale dans le module billets.", steps: ["Éteignez puis rallumez le terminal.", CALL], technician: true },
  { match: /^3[8B]/, title: "Lecteur de billets", explanation: "Le lecteur qui authentifie les billets ne répond pas ou est sale.", steps: [RESET, "Si l'erreur persiste, éteignez puis rallumez le terminal.", CALL], technician: true },
  { match: /^4401/, title: "Coupure de courant pendant une opération", explanation: "Le courant a été coupé pendant un mouvement de billets : des billets peuvent être restés dans le circuit.", steps: [REMOVE_NOTE, RESET, "Vérifiez l'encaisse après la réinitialisation."] },
  { match: /^4[0-9]/, title: "Erreur interne du module billets", explanation: "Erreur de programme ou de mémoire du module billets.", steps: ["Éteignez puis rallumez le terminal.", CALL], technician: true },
  { match: /^E9A0/, title: "Cassette billets mal installée", explanation: "La cassette de collecte des billets n'est pas correctement insérée.", steps: ["Retirez puis réinsérez la cassette billets jusqu'au bout.", RESET] },
  { match: /^E9/, title: "Problème dans la cassette de collecte billets", explanation: "Bourrage ou défaut dans la cassette de collecte des billets.", steps: ["Retirez la cassette billets et enlevez les billets froissés en entrée.", "Réinsérez-la jusqu'au bout.", RESET, CALL] },
  { match: /^E[0-8]/, title: "Problème dans un stockeur de billets", explanation: "Un stockeur (compartiment d'une valeur de billet) a un bourrage ou un défaut de transport.", steps: [REMOVE_NOTE, CLOSE_RESET, "Après la réinitialisation, vérifiez l'encaisse.", CALL] },
  { match: /^999/, title: "Vérification du module billets", explanation: "Le module billets signale un problème pendant sa vérification d'état.", steps: [CLOSE_RESET, CALL] },
];

const GLORY = table as unknown as Record<string, Record<string, [string, string]>>;

/** Code numérique du terminal → code détaillé Glory sur 4 caractères hexadécimaux. */
export function errorCodeHex(n: number): string {
  return (n >>> 0).toString(16).toUpperCase().padStart(4, "0").slice(-4);
}

export function describeDeviceError(devid: string, numericCode: number): DeviceErrorInfo {
  const coin = devid === "2";
  const code = errorCodeHex(numericCode);
  const glory = GLORY[coin ? "RCW100" : "RBW100"]?.[code];
  const fam = (coin ? COIN_FAMILIES : NOTE_FAMILIES).find((f) => f.match.test(code));
  const module = coin ? "pièces" : "billets";
  return {
    devid,
    module,
    code,
    title: fam?.title ?? `Erreur du module ${module}`,
    explanation: fam?.explanation ?? `Le module ${module} signale une erreur.`,
    steps: fam?.steps ?? [CLOSE_RESET, CALL],
    technician: !!fam?.technician,
    detail: glory?.[0] ?? "",
    helpPath: glory?.[1] ?? "",
  };
}

/** Garde-fou : on ne télécharge que des animations d'aide du terminal. */
export function isHelpPath(p: string): boolean {
  return /^\/help\/[a-z0-9]+\/[A-Za-z0-9_]+\.gif$/.test(p);
}
