/**
 * Script de vérification pour les opérations de supervision/diagnostic :
 * RomVersion, AdjustTime, GetSettingFile. Exécution :
 * `node dist/scripts/verify-supervision.js`.
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
  const openResult = await client.open("posadmin", "", "verify-supervision");
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

  console.log("\n--- RomVersion ---");
  const romVersion = await client.romVersion(sessionId);
  console.log(`result=${romVersion.result} (${romVersion.resultDescription})`);
  console.log(JSON.stringify(romVersion.raw, null, 2));

  console.log("\n--- AdjustTime (heure système) ---");
  const now = new Date();
  const adjustTime = await client.adjustTime(
    sessionId,
    { month: now.getMonth() + 1, day: now.getDate(), year: now.getFullYear() },
    { hour: now.getHours(), minute: now.getMinutes(), second: now.getSeconds() }
  );
  console.log(`result=${adjustTime.result} (${adjustTime.resultDescription})`);

  console.log("\n--- GetSettingFile(GloryCo.xml) ---");
  const settingFile = await client.getSettingFile(sessionId, "GloryCo.xml");
  console.log(`result=${settingFile.result} (${settingFile.resultDescription})`);
  console.log(settingFile.settingFile?.slice(0, 500));

  console.log("\n--- LoginUser/LogoutUser ---");
  console.log("LoginUser →", await client.loginUser("verify-supervision-user"));
  console.log("LogoutUser →", await client.logoutUser());

  await client.release(sessionId);
  await client.close(sessionId);
  await eventListener.stop();
  console.log("\nTerminé.");
}

main().catch((err) => {
  console.error("ÉCHEC :", err);
  process.exit(1);
});
