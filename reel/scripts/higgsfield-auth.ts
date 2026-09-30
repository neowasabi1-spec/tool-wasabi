/**
 * CLI standalone per fare l'OAuth flow Higgsfield la prima volta (o riautenticarsi
 * dopo che il refresh_token è scaduto).
 *
 * Usage:
 *   pnpm higgsfield:auth
 *
 * Apre il browser sul URL di autorizzazione Higgsfield. L'utente fa login +
 * autorizza, browser fa redirect a localhost (callback ricevuto da server
 * effimero su porta random). I tokens sono salvati in
 * ~/.config/ai-clienti/higgsfield-token.json (chmod 600).
 *
 * Dopo questo step, tutte le chiamate Higgsfield dal reel-engine usano i tokens
 * salvati con refresh automatico. Non serve riautenticarsi finché il
 * refresh_token resta valido (tipicamente 30-90 giorni).
 */

import { startAuthFlow, tokenFilePath } from "../src/services/higgsfield-auth.js";

async function main(): Promise<void> {
  try {
    await startAuthFlow();
    console.log("\n✅ Higgsfield autenticato. Token salvato in:");
    console.log(`   ${tokenFilePath()}\n`);
    console.log("   Ora puoi eseguire pnpm reel ... con engine Higgsfield (Seedance / Kling-HF)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Auth fallito: ${msg}\n`);
    process.exit(1);
  }
}

main();
