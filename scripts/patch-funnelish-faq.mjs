// One-shot patcher: takes a Funnelish-style cloned HTML and injects
// the wasabi-accordion-rescue CSS + JS so .faq-header / .faq-title
// clicks toggle .faq-content-wrapper. Useful for already-deployed
// pages that pre-date the spa-rescue.ts fix.
//
// Usage: node scripts/patch-funnelish-faq.mjs <input.html> <output.html>

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [, , inputArg, outputArg] = process.argv;
if (!inputArg || !outputArg) {
  console.error('Usage: node scripts/patch-funnelish-faq.mjs <input.html> <output.html>');
  process.exit(1);
}

const input = resolve(inputArg);
const output = resolve(outputArg);
const html = readFileSync(input, 'utf8');

const STYLE = `<style id="wasabi-accordion-rescue-style">
html[data-wasabi-rescue="1"] .faq .faq-content-wrapper,
html[data-wasabi-rescue="1"] .faq .faq-content,
html[data-wasabi-rescue="1"] .faq-wrapper .faq-content-wrapper,
html[data-wasabi-rescue="1"] .faq-wrapper .faq-content,
html[data-wasabi-rescue="1"] .faq-item .faq-body,
html[data-wasabi-rescue="1"] .faq-item .faq-answer{display:none}
html[data-wasabi-rescue="1"] .faq.is-open .faq-content-wrapper,
html[data-wasabi-rescue="1"] .faq.is-open .faq-content,
html[data-wasabi-rescue="1"] .faq-wrapper.is-open .faq-content-wrapper,
html[data-wasabi-rescue="1"] .faq-wrapper.is-open .faq-content,
html[data-wasabi-rescue="1"] .faq-item.is-open .faq-body,
html[data-wasabi-rescue="1"] .faq-item.is-open .faq-answer{display:block}
html[data-wasabi-rescue="1"] .faq-header,
html[data-wasabi-rescue="1"] .faq-title,
html[data-wasabi-rescue="1"] .faq-question,
html[data-wasabi-rescue="1"] .accordion-header,
html[data-wasabi-rescue="1"] .accordion-button,
html[data-wasabi-rescue="1"] .accordion-toggle,
html[data-wasabi-rescue="1"] .toggle-header{cursor:pointer}
html[data-wasabi-rescue="1"] .faq.is-open .faq-icon,
html[data-wasabi-rescue="1"] .faq-wrapper.is-open .faq-icon,
html[data-wasabi-rescue="1"] .faq-item.is-open .faq-icon{transform:rotate(180deg);transition:transform .2s}
html[data-wasabi-rescue="1"] li:empty,
html[data-wasabi-rescue="1"] li>br:only-child{display:none}
</style>`;

const SCRIPT = `<script id="wasabi-accordion-rescue">(function(){
function $(s,r){return (r||document).querySelectorAll(s)}
var TRIG='.faq-header,.faq-title,.faq-question,.accordion-header,.accordion-button,.accordion-toggle,.toggle-header,[data-accordion-trigger],[data-faq-toggle]';
var CONT='.faq,.faq-wrapper,.faq-item,.accordion-item,.accordion,.toggle-item,[data-faq],details';
var PANEL='.faq-content-wrapper,.faq-content,.accordion-content,.accordion-body,.accordion-collapse,.faq-body,.faq-answer,.toggle-content,.collapse-content';
function findPanel(trigger,container){
  var n=trigger.nextElementSibling;
  while(n){
    if(n.matches&&n.matches(PANEL))return n;
    n=n.nextElementSibling;
  }
  return container.querySelector(PANEL);
}
function once(){
  var hasShape=document.querySelector(TRIG)||document.querySelector('.faq-content-wrapper');
  if(hasShape){document.documentElement.setAttribute('data-wasabi-rescue','1');}
  document.addEventListener('click',function(ev){
    var t=ev.target;
    if(!(t instanceof Element))return;
    var actionable=t.closest('a[href]:not([href="#"]):not([href=""]),button[type="submit"],input,select,textarea');
    var btn=t.closest('[aria-expanded][aria-controls]');
    if(btn){
      if(actionable&&btn.contains(actionable)&&actionable!==btn)return;
      var open=btn.getAttribute('aria-expanded')==='true';
      btn.setAttribute('aria-expanded',open?'false':'true');
      var pid=btn.getAttribute('aria-controls');
      var p=pid?document.getElementById(pid):null;
      if(p){p.style.display=open?'none':'';p.hidden=open;}
      return;
    }
    var bs=t.closest('[data-bs-toggle="collapse"],[data-toggle="collapse"]');
    if(bs){
      if(actionable&&bs.contains(actionable)&&actionable!==bs)return;
      var sel=bs.getAttribute('data-bs-target')||bs.getAttribute('data-target')||bs.getAttribute('href');
      if(sel){var el=document.querySelector(sel);if(el){el.classList.toggle('show');}}
      return;
    }
    var gh=t.closest(TRIG);
    if(gh){
      if(actionable&&gh.contains(actionable)&&actionable!==gh)return;
      var item=gh.closest(CONT)||gh.parentElement;
      if(item){
        var willOpen=!item.classList.contains('is-open');
        item.classList.toggle('is-open',willOpen);
        item.classList.toggle('active',willOpen);
        item.classList.toggle('expanded',willOpen);
        if(item.tagName==='DETAILS'){
          if(willOpen)item.setAttribute('open','');else item.removeAttribute('open');
        }
        gh.setAttribute('aria-expanded',willOpen?'true':'false');
        var content=findPanel(gh,item);
        if(content){
          content.style.display='';
          var cs=getComputedStyle(content);
          if(willOpen&&cs.display==='none')content.style.display='block';
          if(!willOpen&&cs.display!=='none')content.style.display='none';
        }
        ev.preventDefault();ev.stopPropagation();
      }
    }
  },true);
  $('[aria-controls]').forEach(function(b){
    if(b.getAttribute('aria-expanded')==='false'){
      var pid=b.getAttribute('aria-controls');
      var p=pid?document.getElementById(pid):null;
      if(p){p.style.display='none';}
    }
  });
}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',once)}else{once()}
})();</script>`;

let out = html;

// Idempotent: skip if already patched.
if (out.includes('id="wasabi-accordion-rescue"')) {
  console.log('[patch] already patched — writing copy as-is');
  writeFileSync(output, out);
  process.exit(0);
}

if (/<\/head>/i.test(out)) {
  out = out.replace(/<\/head>/i, `${STYLE}\n</head>`);
} else if (/<head\b[^>]*>/i.test(out)) {
  out = out.replace(/(<head\b[^>]*>)/i, `$1\n${STYLE}`);
} else {
  out = `<head>${STYLE}</head>${out}`;
}
if (/<\/body>/i.test(out)) {
  out = out.replace(/<\/body>/i, `${SCRIPT}\n</body>`);
} else {
  out = `${out}${SCRIPT}`;
}

writeFileSync(output, out);
const sizeKb = (out.length / 1024).toFixed(1);
console.log(`[patch] wrote ${output} (${sizeKb} KB)`);
