// Misura il tempo della regex text-node sull'HTML reale (1.6MB).
const fs = require('fs');
const html = fs.readFileSync('.tmp-gethirelief.html', 'utf8');
console.log('HTML len:', html.length);

const htmlForTextNodes = html
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '');
console.log('htmlForTextNodes len:', htmlForTextNodes.length, '\n');

function run(label, regex, maxLen) {
  const t = Date.now();
  let m, count = 0, kept = 0;
  regex.lastIndex = 0;
  let iter = 0;
  while ((m = regex.exec(htmlForTextNodes)) !== null) {
    iter++;
    const content = m[1];
    count++;
    if (maxLen && content.length > maxLen) continue;
    const trimmed = content.replace(/\s+/g, ' ').trim();
    if (trimmed.length < 4) continue;
    kept++;
    if (Date.now() - t > 30000) { console.log('   ABORT >30s'); break; }
  }
  console.log(`${label}: ${Date.now() - t}ms | matches=${count} | kept=${kept}`);
}

// v4.8 (lenta sospetta): range con newline ammesso
run('v4.8  />([^<>{}]{4,600})</g  ', /></g.constructor('>([^<>{}]{4,600})<', 'g'));
// v4.9 (lineare): + unbounded
run('v4.9  />([^<>{}]+)</g         ', />([^<>{}]+)</g, 2000);
// originale pre-fix: newline escluso, range
run('orig  />([^<>{}\\n]{4,300})</g', /></g.constructor('>([^<>{}\\n]{4,300})<', 'g'));
