/**
 * Mises à jour automatiques (version installée uniquement).
 *
 * Source : dépôt GitHub public « riadh0707/medacash-updates » (Releases),
 * qui ne contient que les installateurs et latest.yml (empreinte SHA-512
 * vérifiée par electron-updater avant installation).
 *
 * Vérification 1 minute après le démarrage puis toutes les 4 heures ; la
 * mise à jour est téléchargée en arrière-plan et installée à la fermeture
 * du logiciel (jamais pendant une vente), ou tout de suite à la demande.
 */
import { app } from "electron";
import { autoUpdater } from "electron-updater";

export type UpdateState =
  | { state: "disabled"; version: string; message: string }
  | { state: "idle" | "checking" | "none" | "error"; version: string; message: string; checkedAt?: string }
  | { state: "downloading"; version: string; message: string; percent: number; next: string }
  | { state: "ready"; version: string; message: string; next: string };

export class Updater {
  private current: UpdateState;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly notify: (s: UpdateState) => void, private readonly log: (line: string) => void) {
    const version = app.getVersion();
    this.current = app.isPackaged
      ? { state: "idle", version, message: "Pas encore vérifié." }
      : { state: "disabled", version, message: "Mises à jour automatiques désactivées (version de développement)." };
    if (!app.isPackaged) return;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;

    autoUpdater.on("checking-for-update", () => this.set({ state: "checking", version, message: "Recherche de mise à jour…" }));
    autoUpdater.on("update-not-available", () => this.set({ state: "none", version, message: "Le logiciel est à jour.", checkedAt: new Date().toISOString() }));
    autoUpdater.on("update-available", (info) => this.set({ state: "downloading", version, message: `Téléchargement de la version ${info.version}…`, percent: 0, next: info.version }));
    autoUpdater.on("download-progress", (p) => {
      if (this.current.state === "downloading") this.set({ ...this.current, percent: Math.round(p.percent), message: `Téléchargement de la version ${this.current.next}… ${Math.round(p.percent)} %` });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.log(`Mise à jour ${info.version} téléchargée : installée à la fermeture du logiciel.`);
      this.set({ state: "ready", version, message: `Version ${info.version} prête : elle s'installera à la fermeture du logiciel.`, next: info.version });
    });
    autoUpdater.on("error", (err) => {
      // Pas d'internet, GitHub indisponible… : on réessaiera au prochain contrôle.
      this.log(`Mise à jour : ${err?.message ?? err}`);
      if (this.current.state !== "ready") this.set({ state: "error", version, message: "Vérification impossible (internet ?). Nouvel essai plus tard.", checkedAt: new Date().toISOString() });
    });
  }

  start(): void {
    if (!app.isPackaged) return;
    setTimeout(() => void this.check(), 60_000);
    this.timer = setInterval(() => void this.check(), 4 * 3600_000);
  }

  status(): UpdateState {
    return this.current;
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged || this.current.state === "downloading" || this.current.state === "ready") return this.current;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      /* l'événement « error » a déjà mis l'état à jour */
    }
    return this.current;
  }

  /** Installe tout de suite la mise à jour téléchargée (le logiciel redémarre). */
  installNow(): boolean {
    if (this.current.state !== "ready") return false;
    if (this.timer) clearInterval(this.timer);
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  }

  private set(s: UpdateState): void {
    this.current = s;
    this.notify(s);
  }
}
