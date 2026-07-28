/**
 * Script de vérification en ligne de commande, indépendant d'Electron :
 * exécute le cycle exact Open → RegisterEvent → Occupy → Status → Release →
 * Close contre le FCC configuré, en réutilisant telles quelles les mêmes
 * classes core/* que le processus main (aucune duplication de logique).
 *
 * Raison d'être : core/soap-client, core/session-state-machine et
 * core/event-listener ne dépendent d'aucune API Electron — ce script permet
 * de les valider contre la VM simulateur sans passer par l'UI (utile en CI ou
 * pour un diagnostic rapide). Exécution : `node dist/scripts/verify-session-cycle.js`.
 */
import { FccSoapClient } from "../core/soap-client";
import { SessionStateMachine } from "../core/session-state-machine";
import { EventListener } from "../core/event-listener";
import { getModelConfig, isConfirmedModel } from "../core/model-adapter";

async function main(): Promise<void> {
  const modelConfig = getModelConfig("CI-10");
  if (!isConfirmedModel(modelConfig) || !modelConfig.soapEndpoint) {
    throw new Error("Modèle CI-10 non configuré avec un endpoint SOAP.");
  }

  const stateMachine = new SessionStateMachine();

  const eventListener = new EventListener({
    mode: modelConfig.eventListener.mode,
    tcpPort: modelConfig.eventListener.tcpPort,
    logger: (source, raw) => console.log(`[TCP EVENT] ${source} ${raw}`),
  });
  await eventListener.start();
  console.log(`Écouteur TCP démarré sur le port ${modelConfig.eventListener.tcpPort}.`);

  const client = await FccSoapClient.create({
    endpoint: modelConfig.soapEndpoint,
    rejectUnauthorized: modelConfig.tls.rejectUnauthorized,
    logger: (direction, operation, payload) =>
      console.log(`[SOAP ${direction === "request" ? "→" : "←"}] ${operation}`, JSON.stringify(payload)),
  });

  stateMachine.assertCanOpen();
  const openResult = await client.open("posadmin", "", "glory-client-verify-script");
  console.log("Open →", openResult);
  if (openResult.result !== 0 || !openResult.sessionId) {
    throw new Error(`Échec Open : ${openResult.resultDescription}`);
  }
  const sessionId = openResult.sessionId;
  stateMachine.onOpened();

  stateMachine.assertCanRegisterEvent();
  // 127.0.0.1 ne fonctionne pas : le FCC est une machine distincte, voir
  // main.ts pour le détail. IP de l'hôte de dev sur le sous-réseau VM.
  const registerResult = await client.registerEvent({
    sessionId,
    url: "192.168.0.1",
    port: modelConfig.eventListener.tcpPort,
  });
  console.log("RegisterEvent →", registerResult);

  stateMachine.assertCanOccupy();
  const occupyResult = await client.occupy(sessionId);
  console.log("Occupy →", occupyResult);
  if (occupyResult.result !== 0) {
    throw new Error(`Échec Occupy : ${occupyResult.resultDescription}`);
  }
  stateMachine.onOccupied();

  stateMachine.assertCanTransact();
  const statusResult = await client.getStatus(sessionId);
  console.log("GetStatus →", statusResult);

  stateMachine.assertCanRelease();
  const releaseResult = await client.release(sessionId);
  console.log("Release →", releaseResult);
  stateMachine.onReleased();

  stateMachine.assertCanClose();
  const closeResult = await client.close(sessionId);
  console.log("Close →", closeResult);
  stateMachine.onClosed();

  await eventListener.stop();
  console.log(`Cycle complet OK. État final : ${stateMachine.getState()}.`);
}

main().catch((err) => {
  console.error("ÉCHEC :", err);
  process.exit(1);
});
