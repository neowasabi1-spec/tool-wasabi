// Smoke test: il regex country/currency picker matcha solo quello che
// deve matchare, senza falsi positivi su copy reale.

// Stretto: il trailing token DEVE essere o un simbolo non-lettera
// ($ € £ ¥ ₹ ...) o 2-5 lettere MAIUSCOLE (KM, CFA, FCFA). Quello
// esclude parole inglesi/italiane in minuscolo come "only" / "today"
// che generavano falsi positivi.
const RE = /^[A-ZÀÈÉÌÒÙÁÉÍÓÚÑ][A-Za-zÀ-ÿ\s&',()/.-]{3,55}\s[A-Z]{3,4}\s(?:[^\sa-zA-Z\d.!?:;]{1,6}|[A-Z]{2,5})$/;

function looksLikeCountryCurrencyPicker(s) {
  if (s.length < 8 || s.length > 70) return false;
  if (/[.!?:;]/.test(s)) return false;
  if (/\d/.test(s)) return false;
  return RE.test(s);
}

const cases = [
  // SHOULD MATCH (junk picker items)
  ['Bosnia & Herzegovina BAM KM', true],
  ['British Indian Ocean Territory USD $', true],
  ['British Virgin Islands USD $', true],
  ['Caribbean Netherlands USD $', true],
  ['Central African Republic XAF CFA', true],
  ['United States USD $', true],
  ['Italia EUR €', true],
  ['United Kingdom GBP £', true],
  ['Japan JPY ¥', true],
  // Versioni con currency-suffix lowercase ("kr", "zł"): non vengono
  // riconosciute dal regex stretto. Trade-off accettato per evitare
  // falsi positivi tipo "Pricing in USD only".
  ['Polska PLN zł', false],
  ['Sweden SEK kr', false],

  // SHOULD NOT MATCH (real copy)
  ['Get Metabolic Wave Now — Just $39 (Regular $297)', false],
  ['Order processing in USD.', false], // has period
  ['Pricing in USD only', false], // missing trailing symbol
  ['Welcome to BAM', false], // missing trailing symbol
  ['Quick! Only 3 left in stock', false], // has digits + !
  ['Why choose us?', false], // has ?
  ['Special offer: $39 today', false], // has digits + :
  ['Former NASA Physicist Reveals: The 9-Minute Audio Signal', false],
  ['BAM KM', false], // too short (< 8 chars)
  ['United States', false], // missing currency+symbol
  ['The world\'s best deal in EUR right now', false], // trailing word not 1-6 char
];

let fail = 0;
for (const [text, expected] of cases) {
  const got = looksLikeCountryCurrencyPicker(text);
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗ FAIL'} ${expected ? 'JUNK' : 'KEEP'} | ${text.padEnd(60)} → ${got}`);
}
console.log(`\n${fail === 0 ? '✓ ALL PASS' : `✗ ${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
