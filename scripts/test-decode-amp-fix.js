const { findStylesheetCandidates } = require('../worker-lib/inline-css');

const html = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&amp;amp;family=Roboto&amp;amp;display=swap">';
const out = findStylesheetCandidates(html, 'https://x.com/');
console.log('rawHref:', out[0]?.rawHref);
console.log('absUrl: ', out[0]?.absUrl);
const expected = 'https://fonts.googleapis.com/css2?family=Inter&family=Roboto&display=swap';
console.log('OK?    :', out[0]?.absUrl === expected ? 'YES ✓' : 'NO ✗ — expected ' + expected);
