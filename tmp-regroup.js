const BASE = 'https://cute-cupcake-74bad8.netlify.app/api/debug-af?token=wsb-diag-8f3a1c6e2b';
const dry = process.argv[2] === 'dry';

async function main() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const r = await fetch(BASE + (dry ? '&dry=1' : ''), { method: 'POST' });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { j = null; }
      if (j && (j.candidates !== undefined || j.error)) {
        console.log(JSON.stringify(j, null, 2));
        return;
      }
      console.log(`attempt ${attempt}: status ${r.status}, not ready yet`);
    } catch (e) {
      console.log(`attempt ${attempt}: ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 20000));
  }
  console.log('gave up');
}
main();
