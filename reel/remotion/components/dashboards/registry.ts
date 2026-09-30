import React from "react";
import { DemoCard } from "./DemoCard";

/**
 * Registry delle dashboard animate riusabili come SCENE di reel.
 *
 * Le dashboard BI/CRM complesse (funnel, scheda cliente, inbox, kanban) hanno
 * layout bespoke che non si serializzano in JSON → si esprimono come componenti
 * React. Lo script.json referenzia il componente per `dashboardComponent: "<id>"`,
 * BasicReel lo monta full-frame (nessun Kling, nessun PNG, sync col voiceover).
 *
 * Per aggiungere una dashboard (recipe in reel-engine/CLAUDE.md → "Dashboard animate"):
 *   1. crea il componente in remotion/components/dashboards/<Nome>.tsx usando le
 *      primitive di ../../utils/dashboard-motion (così è animato per costruzione)
 *      — parti da DemoCard.tsx come template
 *   2. importalo e aggiungi una entry qui sotto con un id kebab-case
 *   3. nello script.json: scena con `dashboardComponent: "<id>"` + durationSec/voiceoverSegment
 */
import { CopyChatCard } from "./CopyChatCard";

export const DASHBOARD_REGISTRY: Record<string, React.FC> = {
  "copy-chat-card": CopyChatCard,
  "demo-card": DemoCard,
};

export const getDashboardComponent = (id: string): React.FC | undefined =>
  DASHBOARD_REGISTRY[id];
