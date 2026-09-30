export const SPRING_PRESETS = {
  /** Entrata morbida — testo, elementi UI */
  gentle: { mass: 1, stiffness: 80, damping: 14 },
  /** Entrata energica — hook, CTA */
  punchy: { mass: 0.8, stiffness: 200, damping: 12 },
  /** Bounce leggero — icone, badge */
  bouncy: { mass: 1, stiffness: 180, damping: 8 },
  /** Uscita lenta — fade out */
  slow: { mass: 1.5, stiffness: 60, damping: 20 },
} as const;
