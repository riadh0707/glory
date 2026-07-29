/**
 * Script de vérification pour CashinCancel (état normal), ReplenishmentFromEntranceCancel,
 * ReturnCash, Cashout. ChangeCancel non testé ici (précondition : Status.Code=23
 * "Waiting Cancellation", atteignable seulement pendant un appel Change() bloquant
 * en cours depuis une autre connexion — hors périmètre d'un script séquentiel simple,
 * voir docstring core/soap-client changeCancel()).
 * Exécution : `node dist/scripts/verify-cancel-cashout.js`.
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
  const openResult = await client.open("posadmin", "", "verify-cancel-cashout");
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

  console.log("\n--- CashinCancel (état normal, aucun StartCashin en cours) ---");
  console.log(await client.cashinCancel(sessionId));

  console.log("\n--- ReplenishmentFromEntranceCancel (état normal) ---");
  console.log(await client.replenishmentFromEntranceCancel(sessionId));

  console.log("\n--- ReturnCash (Coin) ---");
  console.log(await client.returnCash(sessionId, 2));

  console.log("\n--- Cashout (5€ x1, devid=1) ---");
  console.log(await client.cashout(sessionId, [{ cc: "EUR", fv: "500", devid: "1", piece: 1 }]));

  await client.release(sessionId);
  await client.close(sessionId);
  await eventListener.stop();
  console.log("\nTerminé.");
}

main().catch((err) => {
  console.error("ÉCHEC :", err);
  process.exit(1);
});
