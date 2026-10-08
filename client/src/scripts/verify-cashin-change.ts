/**
 * Script de vérification en ligne de commande pour StartCashin/EndCashin/
 * Change — mêmes raisons d'être que verify-session-cycle.ts (indépendant
 * d'Electron, réutilise core/*), séparé de ce dernier car il couvre une
 * capacité additionnelle (paiement), pas le cycle de session de base.
 * Exécution : `node dist/scripts/verify-cashin-change.js`.
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

  const client = await FccSoapClient.create({
    endpoint: modelConfig.soapEndpoint,
    rejectUnauthorized: modelConfig.tls.rejectUnauthorized,
    logger: (direction, operation, payload) =>
      console.log(`[SOAP ${direction === "request" ? "→" : "←"}] ${operation}`, JSON.stringify(payload)),
  });

  stateMachine.assertCanOpen();
  const openResult = await client.open("posadmin", "", "glory-client-verify-cashin");
  if (openResult.result !== 0 || !openResult.sessionId) {
    throw new Error(`Échec Open : ${openResult.resultDescription}`);
  }
  const sessionId = openResult.sessionId;
  stateMachine.onOpened();

  stateMachine.assertCanRegisterEvent();
  await client.registerEvent({ sessionId, url: "192.168.0.1", port: modelConfig.eventListener.tcpPort });

  stateMachine.assertCanOccupy();
  const occupyResult = await client.occupy(sessionId);
  if (occupyResult.result !== 0) {
    throw new Error(`Échec Occupy : ${occupyResult.resultDescription}`);
  }
  stateMachine.onOccupied();

  stateMachine.assertCanTransact();
  console.log("\n--- StartCashin (aucun billet/pièce inséré, pas d'émulateur RBW/RCW actif) ---");
  const startResult = await client.startCashin(sessionId);
  console.log("StartCashin →", startResult);

  console.log("\n--- EndCashin ---");
  const endResult = await client.endCashin(sessionId);
  console.log("EndCashin →", endResult);

  console.log("\n--- Change(1000) ---");
  const changeResult = await client.change(sessionId, "1000");
  console.log("Change →", changeResult);

  stateMachine.assertCanRelease();
  await client.release(sessionId);
  stateMachine.onReleased();
  stateMachine.assertCanClose();
  await client.close(sessionId);
  stateMachine.onClosed();

  await eventListener.stop();
  console.log(`\nTerminé. État final : ${stateMachine.getState()}.`);
}

main().catch((err) => {
  console.error("ÉCHEC :", err);
  process.exit(1);
});
