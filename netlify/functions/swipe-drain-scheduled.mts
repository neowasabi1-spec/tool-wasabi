import { drainStalledSwipes } from '../../src/lib/chimera-swipe-resume';

/**
 * Every 2 minutes, restart Chimera/Clone-Swipe if the worker chain died.
 * The background function cannot reliably call itself on Netlify; this is
 * the watchdog that keeps copy and ChatGPT photos moving.
 */

export default async () => {
  try {
    const out = await drainStalledSwipes({ maxProjects: 3 });
    console.log('[swipe-drain]', JSON.stringify(out));
  } catch (e) {
    console.log('[swipe-drain]', (e as Error).message);
  }
};

export const config = { schedule: '*/2 * * * *' };
