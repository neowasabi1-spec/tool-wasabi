// E2E sanity test for the quiz walker fix against bioma weight-loss.
// Replicates the NEW PASS 2a (radio -> climb to clickable card) plus a
// minimal CTA pass + fingerprint loop. Prints the URL/label per step.
const { chromium } = require('playwright');

const ENTRY = process.argv[2] || 'https://bioma.health/weight-loss';
const MAX = Number(process.argv[3] || 12);

const clickerSrc = async function () {
  const NEG = /^(skip|salta|indietro|back|prev|previous|cancel|annulla|chiudi|close|home|privacy|cookie|termini|terms|login|accedi|menu|languag)/i;
  const NEXT = /(continue|avanti|next|procedi|proceed|start|inizia|submit|conferma|confirm|get|see|risultat|result|finish|done|vai)/i;
  const viewportH = window.innerHeight || 800;
  function getText(el){return ((el.innerText||el.value||el.getAttribute('aria-label')||el.placeholder||'')+'').trim();}
  function isElVisible(el){const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>=24&&r.height>=20&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0'&&r.bottom>=0&&r.top<=viewportH*3;}
  function looksLikeCard(el){if(!el||el===document.body)return false;const s=getComputedStyle(el);const idc=((el.id||'')+' '+(typeof el.className==='string'?el.className:'')).toLowerCase();const ca=(el.getAttribute&&el.getAttribute('cursor'))||'';const c=s.cursor==='pointer'||ca==='pointer'||/option|answer|choice|quiz|select|card/.test(idc)||el.getAttribute('role')==='button'||el.getAttribute('role')==='radio';return c&&isElVisible(el);}
  function resolve(r){const id=r.getAttribute('id');if(id){const same=document.querySelectorAll('#'+(window.CSS&&CSS.escape?CSS.escape(id):id));if(same.length===1){const l=document.querySelector('label[for="'+id+'"]');if(l&&isElVisible(l))return l;}}const wl=r.closest('label');if(wl&&isElVisible(wl))return wl;let n=r.parentElement;for(let d=0;d<8&&n;d++,n=n.parentElement){if(looksLikeCard(n))return n;}n=r.parentElement;for(let d=0;d<8&&n;d++,n=n.parentElement){if(isElVisible(n))return n;}return r;}
  function labelSig(){return location.href+'|'+(((document.body.innerText||'').match(/\d+\s*(of|\/|su|di)\s*\d+/i)||[''])[0]);}
  const BAD_ID=/question|label|subtitle|secondary|progress|back|logo|title|header|footer|next|button|nav/i;
  function findNext(){let f=null;document.querySelectorAll('button,[role="button"],input[type="submit"],a[href]').forEach((el)=>{if(f)return;const t=getText(el);if(!t||t.length>80)return;if(NEG.test(t))return;if(!NEXT.test(t))return;if(el.disabled||el.getAttribute('aria-disabled')==='true')return;if(!isElVisible(el))return;f=el;});return f;}
  // PASS 0: quiz question -> select an answer, then click Next (if any)
  const cards=[];const seen=new Set();
  function pushCard(el){if(!el||seen.has(el))return;if(!isElVisible(el))return;const t=getText(el);if(!t||t.length>160)return;if(NEG.test(t))return;if(NEXT.test(t))return;if(BAD_ID.test((el.id||'')))return;const r=el.getBoundingClientRect();if(r.height<36)return;if(el.closest('header,nav,footer'))return;seen.add(el);cards.push({el,top:r.top});}
  document.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"]').forEach((r)=>pushCard(resolve(r)));
  if(!cards.length){document.querySelectorAll('[id*="answer"],[id*="option"],[class*="answer"],[class*="option"],[class*="choice"]').forEach((el)=>pushCard(el));}
  if(cards.length){
    cards.sort((a,b)=>a.top-b.top);
    const card=cards[0].el;const sig=labelSig();
    try{card.scrollIntoView({block:'center'});card.click();}catch(e){}
    for(let w=0;w<2200;w+=150){await new Promise(r=>setTimeout(r,150));if(labelSig()!==sig)return 'ANSWER-AUTOADV:"'+getText(card).slice(0,25)+'"';const n=findNext();if(n){try{n.scrollIntoView({block:'center'});n.click();return 'ANSWER+NEXT:"'+getText(card).slice(0,20)+'"->"'+getText(n).slice(0,15)+'"';}catch(e){}}}
    return 'ANSWER-ONLY:"'+getText(card).slice(0,25)+'"';
  }
  // PASS 1: explicit CTA
  const ctas=[];
  document.querySelectorAll('button,[role="button"],input[type="submit"],a[href]').forEach((el)=>{const t=getText(el);if(!t||t.length>80)return;if(NEG.test(t))return;if(!isElVisible(el))return;if(NEXT.test(t)||el.type==='submit')ctas.push(el);});
  if(ctas.length){try{ctas[0].scrollIntoView({block:'center'});ctas[0].click();return 'CTA:'+getText(ctas[0]).slice(0,30);}catch(e){}}
  return null;
};

async function fp(page){return page.evaluate(()=>{const t=(document.body.innerText||'').replace(/\s+/g,' ').slice(0,400);return location.href+'|'+t;});}

(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.goto(ENTRY,{waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForTimeout(2500);
  let prev=await fp(page);
  console.log('STEP 0:', (await page.url()));
  for(let i=1;i<=MAX;i++){
    let res=await page.evaluate(clickerSrc);
    for(let a=0;!res&&a<3;a++){await page.waitForTimeout([1000,1800,2500][a]);res=await page.evaluate(clickerSrc);}
    if(!res){console.log('STOP at step',i,'no_advance_button | url=',await page.url());break;}
    // wait for transition
    let changed=false;const dl=Date.now()+6000;let np=prev;
    while(Date.now()<dl){await page.waitForTimeout(150);np=await fp(page);if(np!==prev){changed=true;break;}}
    const label=await page.evaluate(()=>{const m=(document.body.innerText||'').match(/\d+\s*of\s*\d+/i);return m?m[0]:'';});
    console.log('STEP',i,'| click='+res+' | changed='+changed+' | '+(await page.url())+' | '+label);
    if(!changed){console.log('  (fingerprint unchanged)');}
    prev=np;
  }
  await browser.close();
})().catch((e)=>{console.error('ERR',e.message);process.exit(1);});
