const { chromium } = require('playwright');
const URL = process.argv[2] || 'https://bioma.health/weight-loss/quiz?question=1';
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(3000);
  const info = await p.evaluate(() => {
    function vis(el){const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>=24&&r.height>=20&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0';}
    function txt(el){return ((el.innerText||'')+'').replace(/\s+/g,' ').trim().slice(0,40);}
    const out = { radios: [], quizIds: [], pointerCards: [], nextBtns: [] };
    document.querySelectorAll('input[type=radio],input[type=checkbox],[role=radio]').forEach((r)=>{
      let n=r.parentElement, chain=[];
      for(let d=0;d<8&&n;d++,n=n.parentElement){const rc=n.getBoundingClientRect();chain.push((n.id||n.tagName)+'['+Math.round(rc.width)+'x'+Math.round(rc.height)+(getComputedStyle(n).cursor==='pointer'||n.getAttribute('cursor')==='pointer'?',ptr':'')+']');}
      out.radios.push({ id:r.id, chain: chain.join(' > ') });
    });
    document.querySelectorAll('[id^="quiz__"]').forEach((el)=>{const r=el.getBoundingClientRect();if(r.height<10)return;out.quizIds.push(el.id+' ['+Math.round(r.width)+'x'+Math.round(r.height)+'] "'+txt(el)+'"');});
    document.querySelectorAll('div,li,button,label').forEach((el)=>{const s=getComputedStyle(el);if(s.cursor!=='pointer'&&el.getAttribute('cursor')!=='pointer')return;if(!vis(el))return;const t=txt(el);if(!t||t.length<2)return;const r=el.getBoundingClientRect();out.pointerCards.push((el.id||el.tagName)+' ['+Math.round(r.width)+'x'+Math.round(r.height)+'] "'+t+'"');});
    document.querySelectorAll('button,a[href],[role=button]').forEach((el)=>{const t=txt(el);if(/next|continue|avanti/i.test(t)&&vis(el))out.nextBtns.push(t+' disabled='+(!!el.disabled));});
    return out;
  });
  console.log('RADIOS:', info.radios.length);
  info.radios.forEach((r)=>console.log('  id='+r.id+' chain: '+r.chain));
  console.log('\nquiz__ ids ('+info.quizIds.length+'):');
  info.quizIds.slice(0,20).forEach((x)=>console.log('  '+x));
  console.log('\npointer cards ('+info.pointerCards.length+'):');
  info.pointerCards.slice(0,25).forEach((x)=>console.log('  '+x));
  console.log('\nNext buttons:', info.nextBtns);
  await b.close();
})().catch((e)=>{console.error(e.message);process.exit(1);});
