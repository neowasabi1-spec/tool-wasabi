/**
 * Spoken languages offered for recreated videos. OpenAI TTS handles all of
 * these from plain text, so adding one is just adding a label here. Europe +
 * the Americas are covered; "Other…" lets the user type anything else.
 */
export const BUILD_LANGUAGES = [
  'English',
  'Spanish',
  'Portuguese',
  'French',
  'German',
  'Italian',
  'Dutch',
  'Polish',
  'Swedish',
  'Norwegian',
  'Danish',
  'Finnish',
  'Romanian',
  'Greek',
  'Czech',
  'Hungarian',
  'Bulgarian',
  'Croatian',
  'Slovak',
  'Slovenian',
  'Lithuanian',
  'Latvian',
  'Estonian',
  'Ukrainian',
  'Russian',
  'Turkish',
] as const;

/** Sentinel select value that reveals a free-text language input. */
export const LANGUAGE_OTHER = '__other__';
