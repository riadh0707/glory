/**
 * Machine à états du cycle de vie de session, telle que documentée dans
 * docs/session-lifecycle.md : Closed → Open → Occupied → (transactions en
 * boucle) → Released → Closed.
 *
 * Le "Transaction" mentionné dans la consigne du sprint n'est pas modélisé
 * comme un état distinct : docs/session-lifecycle.md (Sequence Spec §3.1,
 * "General Command Execution") montre que les opérations métier forment une
 * boucle *à l'intérieur* de l'état Occupied ("[Any Request]... boucle
 * transactions du jour"), pas une transition à sens unique. On matérialise
 * donc "Transaction" comme une action autorisée uniquement en état Occupied,
 * qui ne change pas l'état — fidèle au diagramme documenté plutôt qu'à une
 * lecture littérale isolée de l'énoncé.
 *
 * Toute opération métier doit passer par `assertCanTransact()` avant d'être
 * exécutée ; toute violation de séquence lève une erreur explicite plutôt que
 * d'être silencieusement ignorée.
 */
export type SessionState = "Closed" | "Open" | "Occupied" | "Released";

export class InvalidSessionTransitionError extends Error {
  constructor(action: string, currentState: SessionState) {
    super(`Action "${action}" refusée : état courant "${currentState}" ne le permet pas.`);
    this.name = "InvalidSessionTransitionError";
  }
}

export class SessionStateMachine {
  private state: SessionState = "Closed";

  getState(): SessionState {
    return this.state;
  }

  /** Avant OpenOperation (docs/session-lifecycle.md, enveloppe §3.1). */
  assertCanOpen(): void {
    if (this.state !== "Closed") {
      throw new InvalidSessionTransitionError("open", this.state);
    }
  }
  onOpened(): void {
    this.assertCanOpen();
    this.state = "Open";
  }

  /** RegisterEvent se fait après Open, avant Occupy (docs/session-lifecycle.md,
   * "Initial Process", étape 1) — ne change pas l'état. */
  assertCanRegisterEvent(): void {
    if (this.state !== "Open") {
      throw new InvalidSessionTransitionError("registerEvent", this.state);
    }
  }

  /** Avant OccupyOperation (docs/session-lifecycle.md, enveloppe §3.1). */
  assertCanOccupy(): void {
    if (this.state !== "Open") {
      throw new InvalidSessionTransitionError("occupy", this.state);
    }
  }
  onOccupied(): void {
    this.assertCanOccupy();
    this.state = "Occupied";
  }

  /** Toute opération métier (Status inclus dans ce sprint) requiert Occupy actif
   * — ordre imposé par la consigne du sprint : Open → RegisterEvent → Occupy →
   * Status → Release → Close. */
  assertCanTransact(): void {
    if (this.state !== "Occupied") {
      throw new InvalidSessionTransitionError("transact", this.state);
    }
  }

  /** Avant ReleaseOperation. */
  assertCanRelease(): void {
    if (this.state !== "Occupied") {
      throw new InvalidSessionTransitionError("release", this.state);
    }
  }
  onReleased(): void {
    this.assertCanRelease();
    this.state = "Released";
  }

  /** Avant CloseOperation. */
  assertCanClose(): void {
    if (this.state !== "Released") {
      throw new InvalidSessionTransitionError("close", this.state);
    }
  }
  onClosed(): void {
    this.assertCanClose();
    this.state = "Closed";
  }
}
