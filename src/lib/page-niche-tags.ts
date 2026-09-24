/**
 * Infer searchable niche tags from a saved landing/advertorial.
 * Canonical tags are always English (weight loss, peptide, fat burn, brain, …)
 * even when the page copy is Italian/German/etc.
 */

type NicheDef = { tag: string; aliases: string[] };

const NICHES: NicheDef[] = [
  {
    tag: 'weight loss',
    aliases: [
      'weight loss', 'lose weight', 'lost weight', 'losing weight', 'fat loss', 'slim down',
      'belly fat', 'stubborn fat', 'overweight', 'obesity', 'diet pill', 'drop pounds',
      'dimagrire', 'dimagrimento', 'perdere peso', 'perdita di peso', 'perso peso', 'brucia grasso',
      'grasso addominale', 'sovrappeso', 'obesita', 'obesità',
      'abnehmen', 'gewichtsverlust', 'fettverlust', 'übergewicht', 'uebergewicht',
      'perder peso', 'perdida de peso', 'pérdida de peso', 'perte de poids',
    ],
  },
  {
    tag: 'fat burn',
    aliases: [
      'fat burn', 'fat burner', 'burn fat', 'burns fat', 'melt fat', 'melts fat', 'thermogenic',
      'brucia grassi', 'bruciagrassi', 'scioglie il grasso', 'brucia i grassi',
      'fettverbrennung', 'fettverbrenner', 'verbrennt fett',
    ],
  },
  {
    tag: 'peptide',
    aliases: [
      'peptide', 'peptides', 'peptidi', 'peptid',
      'bpc-157', 'bpc 157', 'semaglutide', 'tirzepatide', 'glp-1', 'glp1',
      'ozempic', 'wegovy', 'mounjaro', 'retatrutide', 'liraglutide',
      'abnehmspritze', 'injektion zum abnehmen',
    ],
  },
  {
    tag: 'brain',
    aliases: [
      'brain fog', 'nootropic', 'memory loss', 'mental clarity', 'cognitive', 'alzheimer',
      'dementia', 'focus and memory', 'brain health',
      'cervello', 'nebbia mentale', 'perdita di memoria', 'chiarezza mentale', 'nootropico',
      'demenza', 'alzheimer',
      'gehirn', 'gehirnnebel', 'gedächtnisverlust', 'geistige klarheit',
    ],
  },
  {
    tag: 'joint',
    aliases: [
      'joint pain', 'joints', 'arthritis', 'rusty hinge', 'knee pain', 'cartilage', 'stiff joints',
      'articolazioni', 'dolore articolare', 'dolori articolari', 'artrite', 'ginocchio',
      'cartilagine', 'articolazioni rigide',
      'gelenkschmerzen', 'gelenke', 'arthritis', 'knieschmerzen',
    ],
  },
  {
    tag: 'sciatica',
    aliases: ['sciatica', 'sciatic', 'piriformis', 'nervo sciatico', 'ischias', 'hüftnerv'],
  },
  {
    tag: 'constipation',
    aliases: [
      'constipation', 'constipated', 'bowel movement',
      'stitichezza', 'stitico', 'evacuazione',
      'verstopfung', 'verstopft',
    ],
  },
  {
    tag: 'gut',
    aliases: [
      'gut health', 'microbiome', 'probiotic', 'probiotics', 'bloating', 'leaky gut', 'ibs',
      'intestino', 'probiotici', 'gonfiore', 'microbiota', 'colon irritabile',
      'darmgesundheit', 'probiotika', 'blähungen', 'reizdarm',
    ],
  },
  {
    tag: 'psoriasis',
    aliases: ['psoriasis', 'psoriatic', 'psoriasi', 'schuppenflechte'],
  },
  {
    tag: 'skin',
    aliases: [
      'wrinkle', 'wrinkles', 'anti-aging', 'anti aging', 'skincare', 'collagen',
      'rughe', 'anti eta', 'anti età', 'antietà', 'collagene', 'cura della pelle',
      'falten', 'hautpflege', 'kollagen',
    ],
  },
  {
    tag: 'hair',
    aliases: [
      'hair loss', 'bald', 'balding', 'regrow hair', 'thinning hair', 'receding',
      'caduta dei capelli', 'calvizie', 'capelli sottili', 'ricrescita',
      'haarausfall', 'glatze', 'dünnes haar',
    ],
  },
  {
    tag: 'prostate',
    aliases: [
      'prostate', 'urologist', 'weak stream', 'frequent urination', 'bph',
      'prostata', 'urologo', 'minzione frequente',
      'prostatavergrößerung', 'prostataleiden',
    ],
  },
  {
    tag: 'blood sugar',
    aliases: [
      'blood sugar', 'blood glucose', 'diabetes', 'insulin resistance', 'type 2', 'a1c',
      'glicemia', 'diabete', 'insulino resistenza', 'insulino-resistenza',
      'blutzucker', 'zuckerkrankheit',
    ],
  },
  {
    tag: 'heart',
    aliases: [
      'blood pressure', 'cholesterol', 'cardiovascular', 'heart health',
      'pressione alta', 'colesterolo', 'cuore', 'cardiovascolare',
      'blutdruck', 'cholesterin', 'herzgesundheit',
    ],
  },
  {
    tag: 'bone density',
    aliases: [
      'bone density', 'osteoporosis', 'osteopenia', 'brittle bones',
      'densita ossea', 'densità ossea', 'osteoporosi', 'ossa fragili',
      'knochendichte', 'knochenschwund',
    ],
  },
  {
    tag: 'hormone',
    aliases: [
      'estrogen', 'testosterone', 'menopause', 'andropause', 'dht', 'hormone balance',
      'ormoni', 'estrogeno', 'menopausa', 'andropausa',
      'hormone', 'wechseljahre',
    ],
  },
  {
    tag: 'thyroid',
    aliases: [
      'thyroid', 'hashimoto', 'hypothyroid', 'hyperthyroid',
      'tiroide', 'ipotiroidismo', 'ipertiroidismo',
      'schilddrüse', 'schilddruese',
    ],
  },
  {
    tag: 'sleep',
    aliases: [
      'insomnia', 'sleep better', "can't sleep", 'melatonin', 'deep sleep',
      'insonnia', 'dormire meglio', 'non riesco a dormire', 'melatonina',
      'schlaflosigkeit', 'besser schlafen',
    ],
  },
  {
    tag: 'energy',
    aliases: [
      'chronic fatigue', 'always tired', 'adrenal', 'low energy',
      'stanchezza cronica', 'sempre stanco', 'mancanza di energia',
      'müdigkeit', 'muedigkeit', 'chronische erschöpfung',
    ],
  },
  {
    tag: 'liver',
    aliases: [
      'fatty liver', 'liver detox', 'liver health',
      'fegato grasso', 'detox fegato', 'salute del fegato',
      'fettleber', 'leberentgiftung',
    ],
  },
  {
    tag: 'vision',
    aliases: [
      'eyesight', 'macular', 'cataract', 'blurry vision',
      'vista', 'maculare', 'cataratta', 'vista offuscata',
      'sehkraft', 'grauer star', 'makula',
    ],
  },
  {
    tag: 'hearing',
    aliases: [
      'tinnitus', 'ringing in', 'hearing loss',
      'acufene', 'acufeni', 'perdita udito',
      'ohrenklingen', 'hörverlust', 'hoerverlust',
    ],
  },
  {
    tag: 'neuropathy',
    aliases: [
      'neuropathy', 'nerve pain', 'tingling feet', 'numb feet',
      'neuropatia', 'dolore nervoso', 'formicolio piedi',
      'neuropathie', 'nerven Schmerz', 'kribbeln in den füßen',
    ],
  },
  {
    tag: 'circulation',
    aliases: [
      'poor circulation', 'varicose', 'swollen legs', 'edema',
      'circolazione', 'vene varicose', 'gambe gonfie', 'edemi',
      'durchblutung', 'krampfadern', 'dicke beine',
    ],
  },
  {
    tag: 'anxiety',
    aliases: [
      'anxiety', 'cortisol', 'chronic stress', 'panic attack',
      'ansia', 'attacco di panico', 'stress cronico',
      'angst', 'panikattacke',
    ],
  },
  {
    tag: 'cbd',
    aliases: ['cbd', 'cannabinoid', 'hemp oil', 'olio di canapa', 'hanföl', 'hanfoel'],
  },
  {
    tag: 'nad',
    aliases: ['nad+', 'nadh', 'nmn', 'nicotinamide'],
  },
  {
    tag: 'longevity',
    aliases: ['longevity', 'lifespan', 'anti-aging', 'longevita', 'longevità', 'langlebigkeit'],
  },
  {
    tag: 'muscle',
    aliases: [
      'sarcopenia', 'muscle mass', 'build muscle',
      'massa muscolare', 'costruire muscoli',
      'muskelmasse', 'muskelaufbau',
    ],
  },
  {
    tag: 'dental',
    aliases: [
      'receding gums', 'gum disease', 'tooth decay',
      'gengive', 'carie', 'parodontite',
      'zahnfleisch', 'karies',
    ],
  },
  {
    tag: 'immune',
    aliases: [
      'immune system', 'immunity', 'cold and flu',
      'sistema immunitario', 'immunita', 'immunità',
      'immunsystem', 'abwehrkräfte',
    ],
  },
  {
    tag: 'menopause',
    aliases: [
      'menopause', 'hot flashes', 'hot flushes',
      'menopausa', 'vampate',
      'wechseljahre', 'hitzewallungen',
    ],
  },
  {
    tag: 'testosterone',
    aliases: [
      'low t', 'low testosterone', 'andropause',
      'testosterone basso', 'andropausa',
      'testosteronmangel',
    ],
  },
  {
    tag: 'keto',
    aliases: ['keto', 'ketosis', 'ketogenic', 'chetogenica', 'chetosi', 'ketose'],
  },
  {
    tag: 'pregnancy',
    aliases: [
      'pregnancy', 'pregnant', 'prenatal',
      'gravidanza', 'incinta', 'prenatale',
      'schwangerschaft', 'schwanger',
    ],
  },
];

const ENGLISH_TAGS = new Set(NICHES.map((n) => n.tag));

/** alias (normalized) → English canonical tag */
const ALIAS_TO_EN: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const n of NICHES) {
    m.set(normTag(n.tag), n.tag);
    for (const a of n.aliases) m.set(normTag(a), n.tag);
  }
  return m;
})();

function htmlToSearchText(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24000);
}

function hayHas(hay: string, phrase: string): boolean {
  const p = phrase
    .toLowerCase()
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  if (p.length < 3) return false;
  return new RegExp(`(?:^|[^a-zàèéìòùäöüß0-9])${p}(?:$|[^a-zàèéìòùäöüß0-9])`, 'i').test(hay);
}

function normTag(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 40);
}

function looksEnglish(tag: string): boolean {
  return /^[a-z0-9][a-z0-9 +\-]{1,39}$/.test(tag);
}

/** Map any extra/known label onto the English canonical tag when possible. */
export function toEnglishTag(raw: string): string | null {
  const t = normTag(raw);
  if (!t) return null;
  if (ENGLISH_TAGS.has(t)) return t;
  const mapped = ALIAS_TO_EN.get(t);
  if (mapped) return mapped;
  if (looksEnglish(t)) return t;
  return null;
}

export function inferPageTags(opts: {
  title?: string;
  html?: string;
  extra?: string[];
  known?: string[];
  max?: number;
}): string[] {
  const title = String(opts.title || '');
  const body = htmlToSearchText(String(opts.html || ''));
  const hay = `${title} ${title} ${body}`.toLowerCase();
  const max = Math.min(10, Math.max(1, opts.max ?? 6));
  const scored = new Map<string, number>();

  const bump = (tag: string, pts: number) => {
    const t = toEnglishTag(tag);
    if (!t) return;
    scored.set(t, (scored.get(t) || 0) + pts);
  };

  for (const n of NICHES) {
    let hit = 0;
    for (const alias of n.aliases) {
      if (hayHas(hay, alias)) hit = Math.max(hit, alias.length);
    }
    if (hit) bump(n.tag, hit);
  }

  for (const k of opts.known || []) {
    const t = toEnglishTag(k);
    if (t && t.length >= 3 && hayHas(hay, t)) bump(t, t.length + 4);
  }

  for (const e of opts.extra || []) bump(e, 100);

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t]) => t);
}
