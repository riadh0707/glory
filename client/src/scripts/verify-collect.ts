/**
 * Script de vérification pour CollectOperation — utilise les billets EUR 500
 * déjà en stock (déposés lors des tests StartCashin/Change précédents,
 * confirmés par Inventory). Vérifie l'inventaire avant/après pour confirmer
 * que la quantité collectée correspond exactement à ce qui a été demandé.
 * Exécution : `node dist/scripts/verify-collect.js`.
 */
import { FccSoapClient } from "../core/soap-client";
import { SessionStateMachine } from "../core/session-state-machine";
import { EventListener } from "../core/event-listener";
import { getModelConfig, isConfirmedModel } from "../core/model-adapter";

function findPiece(raw: any, fv: string, devid: string): number | undefined {
  const cashArrays = Array.isArray(raw?.Cash) ? raw.Cash : raw?.Cash ? [raw.Cash] : [];
  for (const cash of cashArrays) {
    if (cash?.attributes?.["n:type"] !== "3") continue; // type 3 = nombre de pièces en cassette (IF Spec p.65)
    const denoms = Array.isArray(cash.Denomination) ? cash.Denomination : cash.Denomination ? [cash.Denomination] : [];
    for (const d of denoms) {
      if (d.attributes?.["n:fv"] === fv && d.attributes?.["n:devid"] === devid) {
        return d.Piece;
      }
    }
  }
  return undefined;
}

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
  const openResult = await client.open("posadmin", "", "verify-collect");
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

  console.log("\n--- Inventory AVANT collect ---");
  const before = await client.inventory(sessionId);
  const piecesBefore = findPiece(before.raw, "50000", "1");
  console.log(`Pièces EUR 500 (devid=1) en cassette AVANT : ${piecesBefore}`);

  console.log("\n--- Collect 2x EUR 500 (devid=1) vers cassette de collecte ---");
  const collectResult = await client.collect(
    sessionId,
    [{ cc: "EUR", fv: "50000", devid: "1", piece: 2 }],
    0 // vers cassette
  );
  console.log("Collect →", JSON.stringify(collectResult));

  console.log("\n--- Inventory APRÈS collect ---");
  const after = await client.inventory(sessionId);
  const piecesAfter = findPiece(after.raw, "50000", "1");
  console.log(`Pièces EUR 500 (devid=1) en cassette APRÈS : ${piecesAfter}`);
  console.log(
    piecesBefore !== undefined && piecesAfter !== undefined
      ? `Différence : ${piecesBefore - piecesAfter} pièce(s) collectée(s) (attendu: 2)`
      : "Impossible de comparer (valeur non trouvée)"
  );

  await client.release(sessionId);
  await client.close(sessionId);
  await eventListener.stop();
  console.log("\nTerminé.");
}

main().catch((err) => {
  console.error("ÉCHEC :", err);
  process.exit(1);
});
