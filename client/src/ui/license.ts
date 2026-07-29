/**
 * Script de l'écran d'activation (license.html) — même contraintes de
 * compilation que renderer.ts (pas de système de module, voir
 * tsconfig.renderer.json), chargé uniquement quand `gateOnLicense()`
 * (main.ts) décide que la licence n'est pas valide.
 */
// Types partagés (LicenseStatus, LicenseStatusResponse, GloryClientApi,
// Window.api) déclarés dans global.d.ts — voir ce fichier pour la raison.

function reasonMessage(res: LicenseStatusResponse): string {
  if (res.status === "network-error") {
    return "Impossible de contacter le serveur de licence — vérifiez votre connexion internet, puis réessayez.";
  }
  switch (res.reason) {
    case "unknown_key":
      return "Clé de licence invalide ou inconnue.";
    case "revoked":
      return "Cette licence a été révoquée.";
    case "expired":
      return res.expiresAt
        ? `Cette licence a expiré le ${new Date(res.expiresAt).toLocaleDateString("fr-FR")}.`
        : "Cette licence a expiré.";
    case "malformed_request":
      return "Requête invalide.";
    default:
      return "Entrez votre clé de licence pour activer l'application.";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("license-status") as HTMLDivElement;
  const keyInput = document.getElementById("input-license-key") as HTMLInputElement;
  const activateBtn = document.getElementById("btn-activate") as HTMLButtonElement;
  const retryBtn = document.getElementById("btn-retry") as HTMLButtonElement;

  function render(res: LicenseStatusResponse): void {
    if (res.status === "checking") {
      statusEl.className = "license-status checking";
      statusEl.textContent = "Vérification en cours…";
      retryBtn.style.display = "none";
      return;
    }
    if (res.status === "valid") {
      statusEl.className = "license-status";
      statusEl.textContent = "Licence valide — ouverture de l'application…";
      retryBtn.style.display = "none";
      return;
    }
    statusEl.className = "license-status error";
    statusEl.textContent = reasonMessage(res);
    retryBtn.style.display = res.hasStoredKey ? "block" : "none";
  }

  async function pollUntilSettled(): Promise<void> {
    for (;;) {
      const res = await window.api.licenseGetStatus();
      render(res);
      if (res.status !== "checking") return;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  activateBtn.addEventListener("click", async () => {
    const key = keyInput.value.trim();
    if (!key) {
      statusEl.className = "license-status error";
      statusEl.textContent = "Entrez une clé de licence.";
      return;
    }
    activateBtn.disabled = true;
    statusEl.className = "license-status checking";
    statusEl.textContent = "Vérification en cours…";
    try {
      const res = await window.api.licenseActivate(key);
      render(res);
      // En cas de succès, le processus main charge déjà l'app principale
      // (voir handleLicenseActivate → loadMainApp()) — rien d'autre à faire
      // ici que refléter l'état pendant la transition.
    } finally {
      activateBtn.disabled = false;
    }
  });

  retryBtn.addEventListener("click", async () => {
    retryBtn.disabled = true;
    statusEl.className = "license-status checking";
    statusEl.textContent = "Vérification en cours…";
    try {
      const res = await window.api.licenseRetry();
      render(res);
    } finally {
      retryBtn.disabled = false;
    }
  });

  void pollUntilSettled();
});
