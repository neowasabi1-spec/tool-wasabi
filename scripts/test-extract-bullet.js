// scripts/test-extract-bullet.js
//
// Test l'extractor sul bullet "Achilles Tendinitis:" isolato per capire
// QUALI testi cattura e quali perde.
const { extractAllTextsUniversal } = require('../worker-lib/text-extractor.js');

// Esempio realistico dalla pagina Nooro (struttura semplificata)
const html = `<!DOCTYPE html><html><body>
<div data-text="text" data-secondsdelay="" id="ioukdmt">
  <b data-text="text" data-secondsdelay="" id="i2rmc4r">
    <span draggable="true" id="ibx7431" class="cc-rte-styled">
      <b data-text="text" data-secondsdelay="">3</b>
    </span>
    <span>
      <span data-text="text" data-secondsdelay="">
        <b data-text="text" data-secondsdelay="" id="ih433ti">Achilles Tendinitis:</b>&nbsp;Overpronation can cause the Achilles tendon to twist slightly with each step, leading to irritation and inflammation.<br data-text="text" data-secondsdelay=""><br data-text="text" data-secondsdelay="">This often manifests as pain and stiffness in the back of the heel and lower calf.<br data-text="text" data-secondsdelay="">
      </span>
    </span>
  </b>
</div>
</body></html>`;

const texts = extractAllTextsUniversal(html);
console.log('Testi estratti: ' + texts.length + '\n');
texts.forEach((t, i) => {
  console.log((i + 1) + '. [' + t.context + '] (pos=' + t.position + ', len=' + t.text.length + ')');
  console.log('    "' + t.text + '"');
  console.log('');
});
