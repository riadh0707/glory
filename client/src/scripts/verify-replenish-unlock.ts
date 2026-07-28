/**
 * Script de vérification pour StartReplenishmentFromEntrance/
 * EndReplenishmentFromEntrance, LockUnit/UnlockUnit, et Inventory — mêmes
 * raisons d'être que les autres scripts de ce dossier (indépendant
 * d'Electron, réutilise core/*). Exécution :
 * `node dist/scripts/verify-replenish-unlock.js`.
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
    logger: () => {},
  });
  await eventListener.start();

  const client = await FccSoapClient.create({
    endpoint: modelConfig.soapEndpoint,
    rejectUnauthorized: modelConfig.tls.rejectUnauthorized,
    logger: (direction, operation, payload) =>
      console.log(`[SOAP ${direction === "request" ? "→" : "←"}] ${operation}`, JSON.stringify(payload)),
  });

  stateMachine.assertCanOpen();
  const openResult = await client.open("posadmin", "", "verify-replenish-unlock");
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

  console.log("\n--- Inventory ---");
  console.log("Inventory →", await client.inventory(sessionId));

  console.log("\n--- LockUnit (RBW-100) ---");
  console.log("LockUnit →", await client.lockUnit(sessionId, 1));

  console.log("\n--- UnlockUnit (RBW-100) ---");
  console.log("UnlockUnit →", await client.unlockUnit(sessionId, 1));

  console.log("\n--- StartReplenishmentFromEntrance ---");
  console.log("StartReplenishmentFromEntrance →", await client.startReplenishmentFromEntrance(sessionId));

  console.log("\n--- EndReplenishmentFromEntrance ---");
  console.log("EndReplenishmentFromEntrance →", await client.endReplenishmentFromEntrance(sessionId));

  await client.release(sessionId);
  await client.close(sessionId);
  await eventListener.stop();
  console.log("\nTerminé.");
}

main().catch((err) => {
  console.error("ÉCHEC :", err);
  process.exit(1);
});
