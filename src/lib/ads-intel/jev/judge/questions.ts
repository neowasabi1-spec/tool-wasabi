import type { QuestionSet } from './types';

/**
 * Gruppi di domande. Le istruzioni citano le sezioni dello state tra backtick:
 * `brand_context`, `brand_products`, `playbook`, `similar_reference_ads`, `ad`, `prompt`, `description`.
 */

export const HOOK_TYPES = {
  question: 'Apre con una domanda al pubblico',
  pattern_interrupt: 'Immagine o suono inatteso che rompe lo scroll',
  bold_claim: 'Affermazione forte o sorprendente',
  problem_callout: 'Nomina subito un problema del pubblico',
  demo: 'Mostra subito il prodotto in azione',
  face_to_camera: 'Una persona parla in camera in prima persona',
  story_open: 'Apre una storia o una confessione',
  social_proof: 'Apre con numeri, recensioni o persone reali',
  other: 'Nessuna delle precedenti',
} as const;

export const ANGLES = {
  problem_solution: 'Problema → soluzione',
  us_vs_them: 'Confronto con alternative o nemico comune',
  testimonial: 'Testimonianza o racconto di un cliente',
  mechanism: 'Spiega il meccanismo per cui funziona',
  fear_of_loss: 'Cosa rischi o perdi se non agisci',
  aspiration: 'Chi diventi o cosa ottieni',
  offer_urgency: 'Offerta, sconto o scadenza',
  education: 'Insegna qualcosa di utile',
  social_proof: 'Quante persone lo usano o lo approvano',
  other: 'Nessuna delle precedenti',
} as const;

export const AWARENESS = {
  unaware: 'Il pubblico non sa di avere il problema',
  problem_aware: 'Conosce il problema, non le soluzioni',
  solution_aware: 'Conosce le soluzioni, non questo prodotto',
  product_aware: 'Conosce il prodotto, non è convinto',
  most_aware: 'Pronto a comprare, serve solo l\'offerta',
} as const;

export const FORMATS = {
  broll_montage: 'Montaggio di stock / B-roll con voce fuori campo e sottotitoli grandi',
  narrative_broll: 'Storia raccontata su scene recitate o di repertorio',
  screen_ui: 'Registrazione di schermo: chat, notifica o form sul telefono',
  ugc_talking_head: 'Persona che parla in camera, stile UGC',
  demo: 'Dimostrazione del prodotto',
  before_after: 'Prima / dopo',
  green_screen: 'Persona davanti a uno screenshot o un contenuto',
  slideshow: 'Sequenza di immagini o slide con testo',
  skit: 'Scenetta recitata',
  animation: 'Animazione o motion graphic',
  static_product: 'Statica con prodotto in primo piano',
  static_ugc: 'Statica in stile post o screenshot nativo',
  meme: 'Meme o formato social riconoscibile',
  text_only: 'Solo testo',
  other: 'Nessuna delle precedenti',
} as const;

const VS_CORPUS = {
  closer_to_winners: 'Somiglia di più alle ads vincenti in `similar_reference_ads`',
  closer_to_losers: 'Somiglia di più alle ads perdenti in `similar_reference_ads`',
  no_clear_match: 'Nessuna somiglianza chiara o riferimenti assenti',
};

export const AD_QUESTIONS: QuestionSet = {
  angle_strength: {
    type: 'score',
    instructions: 'How distinctive is the creative angle in `ad`, judged against the conventions listed in `playbook` and the category?',
    criteria: [
      'Generic category execution — product shot plus a claim, could be any brand',
      'Competent but familiar — a recognised format executed well',
      'A specific idea you have not seen in this category',
    ],
  },
  positioning_fit: {
    type: 'score',
    instructions: 'How well does the angle in `ad` fit the brand described in `brand_context`?',
    criteria: [
      "Contradicts the brand's positioning or tone",
      'Neutral — could be adapted without conflict',
      'Directly reinforces what the brand already stands for',
    ],
  },
  reproducibility: {
    type: 'score',
    instructions: 'How easily could the approach in `ad` be reproduced with the products listed in `brand_products`?',
    criteria: [
      'Depends on assets or talent the brand does not have',
      'Reproducible with effort or substitution',
      'Reproducible directly with existing products',
    ],
  },
  borrowed_ip: {
    type: 'noul',
    instructions: 'Does the ad in `ad` depend on a licensed character, celebrity, or third-party IP?',
    criteria: {
      true: 'A named person, character, franchise or partner brand carries the creative idea',
      false: 'The idea works without any external IP',
    },
  },
};

export const HOOK_QUESTIONS: QuestionSet = {
  hook_type: { type: 'choice', instructions: 'What kind of opening does the hook in `ad` use?', criteria: HOOK_TYPES },
  stop_power: {
    type: 'score',
    instructions: 'How likely is the hook in `ad` to stop someone scrolling in the first seconds?',
    criteria: ['Easy to scroll past', 'Some pull', 'Hard to scroll past'],
  },
  text_on_screen: {
    type: 'noul',
    instructions: 'Does the hook in `ad` show text on screen?',
    criteria: { true: 'Readable text appears during the hook', false: 'No text on screen during the hook' },
  },
  vs_corpus: { type: 'choice', instructions: 'Compare the hook in `ad` with the hooks in `similar_reference_ads`.', criteria: VS_CORPUS },
};

export const MESSAGE_QUESTIONS: QuestionSet = {
  angle: { type: 'choice', instructions: 'What is the main angle of the message in `ad`?', criteria: ANGLES },
  awareness_level: { type: 'choice', instructions: 'Which awareness level is the message in `ad` written for?', criteria: AWARENESS },
  angle_strength: AD_QUESTIONS.angle_strength,
  positioning_fit: AD_QUESTIONS.positioning_fit,
  claim_risk: {
    type: 'score',
    instructions: 'What kind of claim does the message in `ad` make about the product?',
    criteria: [
      'No claim — mood, aesthetic or product presence only',
      'Subjective or comparative claim about taste, feel or preference',
      'Specific factual, health or performance claim that would need substantiation',
    ],
  },
  borrowed_ip: AD_QUESTIONS.borrowed_ip,
};

export const FORMAT_QUESTIONS: QuestionSet = {
  format: { type: 'choice', instructions: 'Which visual format does `ad` use?', criteria: FORMATS },
  reproducibility: AD_QUESTIONS.reproducibility,
  production_level: {
    type: 'score',
    instructions: 'What production level does the visual format in `ad` require?',
    criteria: ['Smartphone, one person, no editing skills', 'Some editing or props', 'Studio, crew or motion design'],
  },
  vs_corpus: { type: 'choice', instructions: 'Compare the visual format in `ad` with the formats in `similar_reference_ads`.', criteria: VS_CORPUS },
};

/**
 * Assegnazione ad → prodotto.
 * - same_product: l'ad deve pubblicizzare proprio quel prodotto
 * - same_benefit: basta che prometta lo stesso beneficio, qualunque sia il prodotto
 */
export function assignQuestions(products: { id: string; name: string; description: string; source_mode: string; benefit: string }[]): QuestionSet {
  const criteria: Record<string, string> = {};
  for (const p of products) {
    criteria[p.id] = p.source_mode === 'same_benefit'
      ? `Any product (from any brand) that promises this benefit: ${p.benefit || p.description.slice(0, 200)}`
      : `Exactly this product: ${p.name} — ${p.description.slice(0, 200)}`;
  }
  criteria.none = 'None of the above';
  return {
    product: {
      type: 'choice',
      instructions: 'Which option in `brand_products` best matches what `ad` is selling or promising?',
      criteria,
    },
  };
}

/** Fedeltà al NOSTRO prodotto: nessun attributo preso in prestito dal prodotto sorgente. */
export const PRODUCT_FIDELITY: QuestionSet = {
  product_fidelity: {
    type: 'noul',
    instructions: 'Does `prompt` attribute to our product any feature, ingredient, mechanism, result or proof that is NOT stated in `product_sheet`?',
    criteria: {
      true: 'It mentions at least one product fact that the product sheet does not contain',
      false: 'Every product fact it mentions is supported by the product sheet, or it mentions none',
    },
  },
};

export const PROMPT_GATE: QuestionSet = {
  brand_rule_conflict: {
    type: 'noul',
    instructions: 'Does `prompt` ask for anything that `brand_rules` forbids?',
    criteria: {
      true: 'The prompt requests an element, tone or claim the rules explicitly prohibit',
      false: 'Nothing in the prompt conflicts with the rules',
    },
  },
  required_elements_present: {
    type: 'noul',
    instructions: 'Does `prompt` specify every element listed as mandatory in `brand_rules`?',
    criteria: {
      true: 'Every mandatory element appears in the prompt',
      false: 'At least one mandatory element is missing or left implicit',
    },
  },
  claim_risk: MESSAGE_QUESTIONS.claim_risk,
  brief_completeness: {
    type: 'score',
    instructions: 'Is `prompt` specific enough to produce a usable ad from without guessing?',
    criteria: [
      'Vague — subject, setting or composition left undefined',
      'Usable but underspecified in one area',
      'Fully specified: subject, setting, composition and product treatment',
    ],
  },
};

export const IMAGE_OUTPUT_GATE: QuestionSet = {
  logo_correct: {
    type: 'noul',
    instructions: 'Is the logo in `description` used in a way `brand_rules` permits?',
    criteria: {
      true: 'Placement, colourway and clear space match the rules',
      false: 'Logo is altered, wrongly coloured, cropped or absent where required',
    },
  },
  palette_on_brand: {
    type: 'noul',
    instructions: 'Are the dominant colours named in `description` among the brand colours named in `brand_rules`?',
    criteria: { true: 'The dominant colours match named brand colours', false: 'A dominant colour falls outside the named palette' },
  },
  tone_match: {
    type: 'score',
    instructions: 'How closely does the mood described in `description` match the tone in `brand_rules`?',
    criteria: ['Actively off — the mood contradicts the brand\'s tone', 'Neutral — inoffensive but not recognisably the brand', 'Unmistakably the brand\'s tone'],
  },
  unsupported_claim: {
    type: 'noul',
    instructions: 'Does any text visible in `description` make a factual, health or performance claim?',
    criteria: {
      true: 'On-image copy asserts a specific benefit, result or comparison',
      false: 'On-image copy is descriptive, brand-name only, or absent',
    },
  },
};

/** Per testi e specifiche video: il giudice legge direttamente il testo. */
export const TEXT_OUTPUT_GATE: QuestionSet = {
  brand_rule_conflict: { ...PROMPT_GATE.brand_rule_conflict, instructions: 'Does `description` contain anything that `brand_rules` forbids?' },
  required_elements_present: { ...PROMPT_GATE.required_elements_present, instructions: 'Does `description` include every element listed as mandatory in `brand_rules`?' },
  tone_match: { ...IMAGE_OUTPUT_GATE.tone_match, instructions: 'How closely does the voice of `description` match the tone in `brand_rules`?' },
  unsupported_claim: {
    type: 'noul',
    instructions: 'Does `description` make a factual, health or performance claim?',
    criteria: { true: 'It asserts a specific benefit, result or comparison', false: 'No specific factual claim' },
  },
};

export const POLICY_QUESTIONS: QuestionSet = {
  health_claim: {
    type: 'noul',
    instructions: 'Does `description` claim to treat, cure or prevent a health condition?',
    criteria: { true: 'A health outcome is promised', false: 'No health outcome is promised' },
  },
  personal_attributes: {
    type: 'noul',
    instructions: 'Does `description` assert or imply personal attributes of the viewer (e.g. "are you overweight?")?',
    criteria: { true: 'It addresses the viewer\'s body, health, finances or identity directly', false: 'It does not' },
  },
  before_after: {
    type: 'noul',
    instructions: 'Does `description` show or describe a before/after comparison of a person\'s body?',
    criteria: { true: 'A body before/after is shown or described', false: 'No body before/after' },
  },
};

/** Regole di instradamento: quali domande bloccano e cosa è "buono". Claim e policy sono solo avvisi. */
export const BLOCKING_RULES: Record<string, { goodNoul?: boolean; minScore?: number; hardReject?: boolean; reviewOnly?: boolean }> = {
  brand_rule_conflict: { goodNoul: false, hardReject: true },
  required_elements_present: { goodNoul: true },
  brief_completeness: { minScore: 1.5 },
  logo_correct: { goodNoul: true },
  palette_on_brand: { goodNoul: true },
  tone_match: { minScore: 1 },
  // un fatto di prodotto non presente nella scheda manda in revisione, non scarta mai
  product_fidelity: { goodNoul: false, reviewOnly: true },
};

export const INFORMATIVE = new Set(['claim_risk', 'unsupported_claim', 'health_claim', 'personal_attributes', 'before_after']);

/**
 * EFFICACIA dell'output: quanto è probabile che funzioni, misurato rispetto alle ads che per questo prodotto
 * stanno davvero ricevendo delivery (`winning_ads`) e a quelle che non ne ricevono (`losing_ads`).
 * `output` = testo, specifica video, prompt immagine o descrizione dell'immagine reale.
 */
export const OUTPUT_QUALITY: QuestionSet = {
  thumb_stop: {
    type: 'score',
    instructions: 'In a fast-scrolling feed, how likely is the opening of `output` (headline and main visual, first line of copy, or first 2 seconds of video) to stop someone from `audience`?',
    criteria: ['Easy to scroll past', 'Some pull', 'Hard to scroll past'],
  },
  audience_callout: {
    type: 'noul',
    instructions: 'Does the headline or first line of `output` explicitly call out or unmistakably signal the audience described in `audience`?',
    criteria: { true: 'The target audience recognises itself immediately', false: 'The audience is not named or signalled in the opening' },
  },
  offer_clarity: {
    type: 'score',
    instructions: 'Within 3 seconds, can someone from `audience` understand what `output` offers them and what they get?',
    criteria: ['The offer is unclear or missing', 'Understandable with effort', 'Instantly clear'],
  },
  offer_desirability: {
    type: 'score',
    instructions: 'How strongly would someone from `audience` want the outcome promised in `output`, given the product facts in `offer`?',
    criteria: ['Weak or irrelevant outcome', 'Mildly interesting', 'A strong, personal reason to act'],
  },
  vs_winners: {
    type: 'choice',
    instructions: 'Compare the persuasion approach and style of `output` with `winning_ads` (currently getting the most delivery) and `losing_ads`.',
    criteria: {
      closer_to_winners: 'Uses the same kind of hook, offer framing and style as the winning ads',
      closer_to_losers: 'Resembles the ads that get little delivery',
      unlike_both: 'Different from both',
    },
  },
  native_style: {
    type: 'score',
    instructions: 'Does `output` look and read like the native, direct-response ads in `winning_ads`, rather than a polished brand or stock-photo ad?',
    criteria: ['Stock or brand-ad look, easy to recognise as a generic ad', 'Somewhat native', 'Feels native and direct-response like the winners'],
  },
  cta_urgency: {
    type: 'score',
    instructions: 'Does `output` give a clear next step and a reason to act now?',
    criteria: ['No clear next step', 'A next step but no reason to act now', 'Clear next step and a real reason to act now'],
  },
};

/** Peso di ogni dimensione nel punteggio di efficacia (somma 1). */
export const QUALITY_WEIGHTS: Record<string, number> = {
  thumb_stop: 0.2, audience_callout: 0.12, offer_clarity: 0.15, offer_desirability: 0.15,
  vs_winners: 0.2, native_style: 0.1, cta_urgency: 0.08,
};

export const QUALITY_LABEL: Record<string, string> = {
  thumb_stop: 'ferma lo scroll', audience_callout: 'chiama il pubblico', offer_clarity: 'offerta chiara',
  offer_desirability: 'offerta desiderabile', vs_winners: 'come i vincenti', native_style: 'stile nativo', cta_urgency: 'CTA e urgenza',
};

/** Cosa chiedere al riscrittore quando una dimensione è debole. */
export const QUALITY_FIX: Record<string, string> = {
  thumb_stop: 'Make the opening impossible to scroll past: huge legible headline, strong contrast, a pattern interrupt like the winning ads.',
  audience_callout: 'Name the audience in the headline or first line (e.g. start with who it is for), as the winning ads do.',
  offer_clarity: 'State plainly what the viewer gets, in the headline, in plain words.',
  offer_desirability: 'Lead with the strongest TRUE benefit from the product sheet for this audience; make it personal.',
  vs_winners: 'Move closer to the hook, offer framing and visual style of the winning ads.',
  native_style: 'Drop the polished stock/brand look: use the native direct-response style of the winning ads (bold text overlays, notification/chat/UGC formats).',
  cta_urgency: 'Add a clear next step and a truthful reason to act now.',
};

/** Valore 0..1 di una risposta di efficacia (noul → probabilità di sì; choice vs_winners → probabilità "vincenti"). */
export function qualityValue(key: string, a: { type: string; value: unknown; pTrue?: number; probs?: Record<string, number> }): number {
  if (a.type === 'noul') return a.pTrue ?? (a.value ? 1 : 0);
  if (a.type === 'choice' && key === 'vs_winning_hooks') return Number(a.probs?.stronger ?? 0) + 0.5 * Number(a.probs?.comparable ?? 0);
  if (a.type === 'choice') return Number(a.probs?.closer_to_winners ?? (a.value === 'closer_to_winners' ? 1 : 0));
  return Math.max(0, Math.min(1, Number(a.value) / 2));
}

/**
 * Efficacia dell'IMMAGINE REALE. Jev non vede l'immagine: `new_ad`, `winning_ads` e `losing_ads` sono schede JSON
 * di caratteristiche visive (descrizione neutra). I livelli più alti contengono esempi presi dai vincenti:
 * secondo TypeSafe, esempi simili agli input reali aumentano molto la confidenza.
 */
export function imageEffectivenessQuestions(winnerExamples: { firstSeen: string[]; styles: string[]; headlines: string[] }): QuestionSet {
  const ex = (xs: string[]) => xs.filter(Boolean).slice(0, 4);
  return {
    thumb_stop: {
      type: 'score',
      instructions: { question: 'In a fast-scrolling feed, how likely is `new_ad` to stop someone from `audience`?', focus: 'Use first_thing_seen, headline height_share and contrast, color_intensity and format. Compare with `winning_ads`.' },
      criteria: [
        { what: 'Small or low-contrast headline, calm or generic visual: easy to scroll past' },
        { what: 'Readable headline and some visual pull, but nothing forces a stop' },
        { what: 'Dominant high-contrast headline or pattern interrupt as strong as the winners', examples: ex(winnerExamples.firstSeen) },
      ],
    },
    audience_callout: {
      type: 'noul',
      instructions: 'Does `new_ad` name or unmistakably signal the audience in `audience` in its headline or first visible element?',
      criteria: { true: 'The audience recognises itself at first glance (headline.names_audience or strong audience_signals)', false: 'The audience is not named or signalled up front' },
    },
    offer_clarity: {
      type: 'score',
      instructions: 'Within 3 seconds, can someone from `audience` understand from `new_ad` what they get?',
      criteria: [{ what: 'Offer unclear or missing' }, { what: 'Understandable with effort' }, { what: 'Instantly clear offer_statement and headline' }],
    },
    offer_desirability: {
      type: 'score',
      instructions: 'How strongly would someone from `audience` want what `new_ad` promises, given `product_offer`?',
      criteria: [{ what: 'Weak or irrelevant outcome' }, { what: 'Mildly interesting' }, { what: 'A strong, personal reason to act', examples: ex(winnerExamples.headlines) }],
    },
    style_match: {
      type: 'score',
      instructions: { question: 'How close is the visual style of `new_ad` to `winning_ads`?', focus: 'Compare patriotic_elements, authority_elements, fake_ui_elements, color_intensity, reads_as and format — not the exact wording.' },
      criteria: [
        { what: 'A different visual language from the winners (e.g. calm stock or brand look)' },
        { what: 'Shares some elements with the winners' },
        { what: 'Same visual language as the winners', examples: ex(winnerExamples.styles) },
      ],
    },
    format_match: {
      type: 'noul',
      instructions: 'Does `new_ad` use the same format family as most of the `winning_ads`?',
      criteria: { true: 'Same format family as most winners', false: 'A format family the winners do not use' },
    },
    vs_winners: {
      type: 'choice',
      instructions: 'Overall, does `new_ad` look more like `winning_ads` or `losing_ads`?',
      criteria: {
        closer_to_winners: 'Its hook, offer framing and look match the winning ads',
        closer_to_losers: 'It resembles the ads that get little delivery',
        unlike_both: 'Different from both groups',
      },
    },
    cta_urgency: {
      type: 'score',
      instructions: 'Does `new_ad` give a clear next step and a reason to act now?',
      criteria: [{ what: 'No clear next step' }, { what: 'A next step but no reason to act now' }, { what: 'A button-like CTA and a truthful reason to act now' }],
    },
    readability: {
      type: 'score',
      instructions: { question: 'Is the amount of text and clutter in `new_ad` right for a fast scroll?', focus: 'Use text_amount and clutter, compared with `winning_ads`.' },
      criteria: [{ what: 'Too much text or clutter to read in a scroll' }, { what: 'Readable but busy' }, { what: 'Reads in one glance, like the winners' }],
    },
  };
}

export const IMAGE_QUALITY_WEIGHTS: Record<string, number> = {
  thumb_stop: 0.18, audience_callout: 0.1, offer_clarity: 0.12, offer_desirability: 0.12,
  style_match: 0.12, format_match: 0.06, vs_winners: 0.16, cta_urgency: 0.07, readability: 0.07,
};

Object.assign(QUALITY_LABEL, { style_match: 'stile come i vincenti', format_match: 'formato come i vincenti', readability: 'leggibile in un attimo' });
Object.assign(QUALITY_FIX, {
  style_match: 'Adopt the visual language of the winning ads (their patriotic/authority cues, UI elements, colour intensity), not a calm stock or brand look.',
  format_match: 'Use the same format family as most winning ads.',
  readability: 'Cut the text: fewer blocks and words, one glance to read, like the winners.',
});

/**
 * Test degli hook video: ogni hook nuovo è giudicato contro gli hook dei video vincenti (`winning_hooks`),
 * sapendo su quale corpo verrà montato (`body`).
 */
export const HOOK_TEST_QUESTIONS: QuestionSet = {
  thumb_stop: {
    type: 'score',
    instructions: { question: 'In the first 2 seconds, how likely is `hook` to stop someone from `audience` scrolling?', focus: 'First frame, first spoken line, on-screen text. Compare with `winning_hooks`.' },
    criteria: [{ what: 'Easy to scroll past' }, { what: 'Some pull' }, { what: 'As strong as the best winning hooks' }],
  },
  audience_callout: {
    type: 'noul',
    instructions: 'Does `hook` name or unmistakably signal the audience in `audience` within its first seconds?',
    criteria: { true: 'The audience recognises itself immediately', false: 'The audience is not signalled in the opening' },
  },
  curiosity: {
    type: 'score',
    instructions: 'How strongly does `hook` open a question or tension the viewer needs the rest of the video to resolve?',
    criteria: [{ what: 'No open loop' }, { what: 'Mild curiosity' }, { what: 'Strong open loop that pulls into the body' }],
  },
  body_fit: {
    type: 'score',
    instructions: 'How naturally does `hook` lead into `body` without a jarring change of tone, person or format?',
    criteria: [{ what: 'Does not connect to the body' }, { what: 'Connects with some friction' }, { what: 'Flows straight into the body' }],
  },
  vs_winning_hooks: {
    type: 'choice',
    instructions: 'Compared with `winning_hooks`, how does `hook` rank?',
    criteria: {
      stronger: 'Stronger opening than most winning hooks',
      comparable: 'About as strong as the winning hooks',
      weaker: 'Weaker than most winning hooks',
    },
  },
};

export const HOOK_TEST_WEIGHTS: Record<string, number> = { thumb_stop: 0.35, audience_callout: 0.15, curiosity: 0.2, body_fit: 0.15, vs_winning_hooks: 0.15 };
Object.assign(QUALITY_LABEL, { curiosity: 'apre una curiosità', body_fit: 'si aggancia al corpo', vs_winning_hooks: 'rispetto agli hook vincenti' });
