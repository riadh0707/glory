/**
 * Script de vérification pour la gestion des dénominations : EnableDenom,
 * DisableDenom, SetExchangeRate, SetRestriction. Exécution :
 * `node dist/scripts/verify-denom-management.js`.
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
  const openResult = await client.open("posadmin", "", "verify-denom-mgmt");
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

  // Dénomination billet 20€, devid=1 (RBW-100) — même convention que les
  // autres scripts (voir docs/soap-operations.md, exemples IF Spec).
  const denom = { cc: "EUR", fv: "2000", devid: "1" };

  console.log("\n--- DisableDenom (20€ RBW-100) ---");
  console.log(await client.disableDenom(sessionId, [{ ...denom, piece: 0 }]));

  console.log("\n--- EnableDenom (ré-autorise 20€ RBW-100) ---");
  console.log(await client.enableDenom(sessionId, [{ ...denom, piece: 0 }]));

  console.log("\n--- SetExchangeRate (USD→EUR=0.9) ---");
  console.log(await client.setExchangeRate(sessionId, [{ from: "USD", to: "EUR", rate: "0.9" }]));

  console.log("\n--- SetRestriction (réservé RBW-200/RBG-200, sans objet ici, voir docstring core) ---");
  console.log(await client.setRestriction(sessionId, [1]));

  await client.release(sessionId);
  await client.close(sessionId);
  await eventListener.stop();
  console.log("\nTerminé.");
}

main().catch((err) => {
  console.error("ÉCHEC :", err);
  process.exit(1);
});
