/**
 * Script de vérification pour OpenExitCover/CloseExitCover — mêmes raisons
 * d'être que les autres scripts de ce dossier. Exécution :
 * `node dist/scripts/verify-exit-cover.js`.
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
  const openResult = await client.open("posadmin", "", "verify-exit-cover");
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

  console.log("\n--- Status AVANT ---");
  const statusBefore = await client.getStatus(sessionId);
  console.log("DevStatus =>", JSON.stringify((statusBefore.raw as any)?.Status?.DevStatus));

  console.log("\n--- OpenExitCover ---");
  console.log("OpenExitCover →", await client.openExitCover(sessionId));

  console.log("\n--- Status PENDANT (couvercle ouvert) ---");
  const statusDuring = await client.getStatus(sessionId);
  console.log("DevStatus =>", JSON.stringify((statusDuring.raw as any)?.Status?.DevStatus));

  console.log("\n--- CloseExitCover ---");
  console.log("CloseExitCover →", await client.closeExitCover(sessionId));

  console.log("\n--- Status APRÈS ---");
  const statusAfter = await client.getStatus(sessionId);
  console.log("DevStatus =>", JSON.stringify((statusAfter.raw as any)?.Status?.DevStatus));

  await client.release(sessionId);
  await client.close(sessionId);
  await eventListener.stop();
  console.log("\nTerminé.");
}

main().catch((err) => {
  console.error("ÉCHEC :", err);
  process.exit(1);
});
