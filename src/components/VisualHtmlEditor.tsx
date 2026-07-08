'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  X, Download, Copy, Undo2, Redo2, Eye, Code, Paintbrush,
  Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Link, Image, Trash2, MoveUp, MoveDown, CopyPlus, Palette,
  Maximize2, Minimize2, Layers, PanelRightClose, PanelRightOpen,
  Type, Save, MousePointer, Heading1, Heading2, Heading3,
  CheckCircle, Strikethrough, List, ListOrdered, Minus,
  Sparkles, Loader2, Wand2, ImagePlus, Bot, Zap, RotateCcw, Send,
  Smartphone, Monitor, Upload, Film, Paperclip,
  BookmarkPlus, Library, Tag, Clock, FileCode, Search,
  BookOpen, ArrowDownToLine, Eye as EyeIcon,
  Link2, Link2Off, ChevronDown,
  // Icona del pulsante "Tracking" nella toolbar — apre il popup per
  // inserire uno snippet (es. Meta Pixel, GA, tracker custom) che
  // viene piazzato subito dopo il tag <head>.
  Activity,
} from 'lucide-react';
import { SavedSection, SECTION_TYPE_OPTIONS, OUTPUT_STACK_OPTIONS, type OutputStack } from '@/types';
import { createClient } from '@supabase/supabase-js';
import { recolorPage } from '@/lib/recolor-page';
import { useStore } from '@/store/useStore';
import { extractSectionContent } from '@/lib/project-sections';
import { stripNonCarouselScripts } from '@/lib/spa-rescue';

/* ── Direct browser → Supabase Storage upload (bypasses Vercel 4.5MB body limit) ── */
const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
  'video/quicktime': 'mov',
};
const UPLOAD_MAX_SIZE = 20 * 1024 * 1024; // 20MB

/* ── Preview-only scroll fix ──
 * Nelle pagine dinamiche (live-stream) teniamo gli script attivi in Preview
 * così i commenti si ri-animano "a tempo". Il rovescio è che il player video
 * (es. Vidalytics/YouTube/Vimeo) inietta un <iframe> che occupa gran parte del
 * viewport: la rotella del mouse finisce nell'iframe del video e la pagina non
 * scrolla, quindi non si arriva ai commenti sotto.
 * Iniettiamo uno <style>+<script> (solo nello snapshot di anteprima, mai
 * nell'HTML salvato) che: (1) forza lo scroll verticale su html/body,
 * (2) rende gli iframe dei video "trasparenti" alla rotella con
 * pointer-events:none (ri-applicato via MutationObserver perché il player
 * inietta l'iframe in modo asincrono). */
function injectPreviewScrollFix(html: string): string {
  const marker = '__prev_scroll_fix';
  if (html.indexOf(marker) !== -1) return html;
  const snippet =
    '<style id="' + marker + '">' +
    'html,body{overflow-y:auto!important;height:auto!important;}' +
    'iframe[src*="vidalytics"],iframe[src*="youtube"],iframe[src*="youtu.be"],' +
    'iframe[src*="vimeo"],iframe[src*="wistia"],iframe[data-src*="vidalytics"],' +
    '[id*="video"] iframe,[class*="video"] iframe,[class*="player"] iframe' +
    '{pointer-events:none!important;}' +
    '</style>' +
    '<script>(function(){function fix(){try{var fs=document.querySelectorAll("iframe");' +
    'for(var i=0;i<fs.length;i++){var f=fs[i];var s=((f.getAttribute("src")||"")+" "+' +
    '(f.getAttribute("data-src")||""));var p=f.parentElement;var pc=p?((p.className||"")+" "+(p.id||"")):"";' +
    'if(/vidalytics|youtube|youtu\\.be|vimeo|wistia/i.test(s)||/video|player/i.test(pc)){' +
    'f.style.setProperty("pointer-events","none","important");}}}catch(e){}}' +
    'fix();try{new MutationObserver(fix).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}' +
    'var n=0,iv=setInterval(function(){fix();if(++n>20)clearInterval(iv);},500);})();<\/script>';
  if (html.indexOf('</body>') !== -1) return html.replace('</body>', snippet + '</body>');
  return html + snippet;
}

async function directSupabaseUpload(file: File): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase not configured');

  if (!ALLOWED_UPLOAD_TYPES[file.type]) {
    throw new Error(`Unsupported file type: ${file.type}`);
  }
  if (file.size > UPLOAD_MAX_SIZE) {
    throw new Error(`File too large (max ${UPLOAD_MAX_SIZE / 1024 / 1024}MB)`);
  }

  const sb = createClient(url, key);
  const ts = Date.now();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80);
  const path = `editor-uploads/${ts}_${safeName}`;

  const { error } = await sb.storage.from('media').upload(path, file, {
    contentType: file.type,
    upsert: false,
  });

  if (error) {
    if (error.message?.includes('Bucket not found')) {
      throw new Error('Storage bucket "media" not found. Create it in Supabase → Storage.');
    }
    throw new Error(error.message);
  }

  const { data } = sb.storage.from('media').getPublicUrl(path);
  return data.publicUrl;
}

/* ─────────── Types ─────────── */

interface ElementInfo {
  path: string;
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  innerHTML: string;
  outerHTML: string;
  href: string;
  src: string;
  alt: string;
  childImg?: { src: string; alt: string } | null;
  childImgs?: { src: string; alt: string }[] | null;
  childBg?: { src: string } | null;
  isTextNode: boolean;
  hasChildren: boolean;
  childCount: number;
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
}

interface SectionInfo {
  index: number;
  tagName: string;
  id: string;
  className: string;
  textPreview: string;
  path: string;
}

interface VisualHtmlEditorProps {
  initialHtml: string;
  initialMobileHtml?: string;
  onSave: (html: string, mobileHtml?: string) => void;
  /** Opzionale: salva la pagina corrente direttamente in un Progetto/Funnel
   *  (stessa logica del modal "Save" in front-end-funnel). Se fornita, in
   *  toolbar compare il pulsante "Salva nel progetto". Riceve l'HTML appena
   *  flushato dall'iframe cosi' salva sempre l'ultima versione editata. */
  onSaveToProject?: (html: string, mobileHtml?: string) => void;
  onClose: () => void;
  pageTitle?: string;
  /** URL originale da cui è stata clonata/swipata la pagina. Usato per:
   *  1) Iniettare `<base href>` dentro l'iframe srcdoc così le URL
   *     relative dell'HTML (es. `/brain_waves.png`) si risolvono contro
   *     l'origin sorgente invece che contro `about:srcdoc` (broken) o
   *     contro il dominio della nostra Netlify (404).
   *  2) Riscrivere a runtime qualunque src/href che sia accidentalmente
   *     finito puntato al nostro dominio editor invece che al sorgente. */
  sourceUrl?: string;
  /** Project context: passato dal parent (front-end-funnel) e usato per
   *  pre-compilare il prompt quando l'utente clicca "Swipe for Product"
   *  su un video. Senza questo, il bottone esiste comunque e usa solo
   *  il contesto della pagina (alt del video + heading vicino). */
  productContext?: {
    name?: string;
    description?: string;
    brief?: string;
    /** Testo estratto dal blocco "Market Research" del Project (multi-file blob).
     *  Usato dal bottone "Brand Colors" per inferire la palette dal positioning
     *  emotivo/strategico del prodotto quando il brief non contiene hex code. */
    marketResearch?: string;
    /** URL di una foto del prodotto (es. logo[0].url del Project).
     *  Quando presente, "Swipe for Product" parte in modalità FULLY AUTO:
     *  l'AI usa direttamente questa immagine come prima frame, scrive il
     *  prompt da sola, lancia Seedance 2.0 e sostituisce il <video>
     *  senza nessun altro click dell'utente.
     *  È anche la prima fonte usata da "Brand Colors" per estrarre la palette
     *  via vision quando il brief/research non contengono colori espliciti. */
    imageUrl?: string;
  };
  /** Lista prodotti (My Projects) per il selettore dentro la modale AI.
   *  Permette di scegliere su quale prodotto basare il prompt anche quando
   *  la pagina è solo clonata (senza productId assegnato) — così lo Swipe
   *  e la generazione hanno sempre un prodotto di riferimento. */
  availableProducts?: Array<{
    id: string;
    name: string;
    description?: string;
    brief?: string;
    marketResearch?: string;
    imageUrl?: string;
  }>;
  /** productId attualmente assegnato alla pagina: preseleziona il menu. */
  currentProductId?: string;
  /** Chiamato quando l'utente sceglie un prodotto dal menu nella modale.
   *  Il parent lo assegna alla pagina (persistente) così lo swipe funziona
   *  anche dopo, su pagine solo clonate. */
  onProductChange?: (productId: string) => void;
}

/* ─────────── Brand Colors ─────────── */

interface BrandPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  mood?: string;
  source: 'text-hex' | 'text-llm' | 'image-llm';
}

type EditorMode = 'visual' | 'code' | 'preview';

/* ─────────── Iframe Editor Script ─────────── */

const EDITOR_SCRIPT = `
(function(){
  var sel=null,hover=null,editing=false,editEl=null;
  var HS='2px dashed rgba(59,130,246,0.4)',SS='2px solid #3b82f6',ES='2px solid #f59e0b';

  function gp(el){
    var p=[];var c=el;
    while(c&&c!==document.documentElement){
      var s=c.tagName.toLowerCase();
      if(c.id){s+='#'+c.id}
      else if(c.parentElement){
        var sibs=Array.from(c.parentElement.children).filter(function(x){return x.tagName===c.tagName});
        if(sibs.length>1)s+=':nth-of-type('+(sibs.indexOf(c)+1)+')';
      }
      p.unshift(s);c=c.parentElement;
    }
    return p.join(' > ');
  }

  /* Dato un elemento (anche una singola slide o <img>), risale al contenitore
     del carosello/slider piu' ESTERNO (Replo, slick, swiper, glide, splide,
     flickity, owl). Serve perche' cliccando una slide/immagine vogliamo poter
     elencare e sostituire TUTTE le immagini del carosello, non solo quella.
     NB: nell'editor gli script sono rimossi, quindi slick/swiper NON aggiungono
     le loro classi runtime: ci appoggiamo alle classi/attributi gia' presenti
     nello snapshot statico (Replo: data-replo-carousel/.left-slider/.slider-for). */
  function carScope(el){
    if(!el||el.nodeType!==1)return null;
    var SEL='[data-replo-carousel],.slick-slider,.slick-list,.slick-slide,.slider-for,.left-slider,.swiper,.swiper-container,.carousel,.glide,.splide,.flickity-enabled,.owl-carousel';
    var p=el,d=0,found=null;
    while(p&&p.nodeType===1&&d<14){
      try{if(p.matches&&p.matches(SEL))found=p;}catch(e){}
      p=p.parentElement;d++;
    }
    return found;
  }

  /* fitMedia — quando cambia la sorgente di un media (<img>/<video>) il
     blocco deve ADATTARSI al nuovo file e mostrarlo INTERO alla sua
     proporzione naturale, senza ritagli. Le pagine clonate spesso
     impongono object-fit:cover + height/aspect-ratio fissi (sull'elemento
     stesso o su un wrapper "solo-media"): qui li neutralizziamo cosi'
     l'altezza del blocco cresce/diminuisce per contenere tutto il media. */
  /* relaxAncestors — risale dai wrapper "solo-media" (senza testo) e ne
     libera l'altezza cosi' crescono NEL FLUSSO: quando il media si
     ingrandisce il contenitore si allunga e spinge in basso il contenuto
     successivo, invece di far sbordare l'immagine sopra i testi.
     NB: niente overflow:visible (causava lo sbordamento). */
  function relaxAncestors(el){
    var p=el.parentElement,d=0;
    while(p&&p.nodeType===1&&d<4){
      if((p.textContent||'').replace(/\s+/g,'').length>0)break;
      var ps=p.style;
      ps.setProperty('height','auto','important');
      ps.setProperty('max-height','none','important');
      ps.setProperty('min-height','0','important');
      ps.removeProperty('aspect-ratio');
      p=p.parentElement;d++;
    }
  }
  /* normalizeMedia — porta un singolo <img>/<video> a comportarsi da
     elemento fluido: altezza automatica (ratio naturale), niente crop,
     mai piu' largo del contenitore (max-width:100% → niente sbordo
     laterale sopra il testo). */
  function normalizeMedia(el){
    if(!el||el.nodeType!==1)return;
    el.style.setProperty('object-fit','contain','important');
    el.style.setProperty('height','auto','important');
    el.style.setProperty('max-height','none','important');
    el.style.setProperty('min-height','0','important');
    el.style.removeProperty('aspect-ratio');
    if(!el.style.width)el.style.setProperty('max-width','100%','important');
  }
  function fitMedia(el){
    if(!el||el.nodeType!==1)return;
    var tag=(el.tagName||'').toLowerCase();
    if(tag!=='img'&&tag!=='video')return;
    try{
      normalizeMedia(el);
      relaxAncestors(el);
    }catch(e){}
  }

  function gi(el){
    if(!el)return null;
    var cs=getComputedStyle(el),r=el.getBoundingClientRect();
    return{
      path:gp(el),tagName:el.tagName.toLowerCase(),id:el.id||'',
      className:typeof el.className==='string'?el.className:'',
      textContent:el.childNodes.length<=3?(el.textContent||'').substring(0,300):'',
      innerHTML:el.innerHTML?(el.innerHTML).substring(0,2000):'',
      outerHTML:el.outerHTML?(el.outerHTML).substring(0,300):'',
      /* IMPORTANTE: per i media usiamo le proprietà DOM (.currentSrc/.src/.href)
         che il browser absolutizza automaticamente rispetto al baseURI.
         getAttribute('src') restituirebbe la stringa raw (può essere relativa
         es. "/img/foo.jpg") che poi il server non riesce a fetchare. */
      href:(el.tagName==='A'?(el.href||''):'')||el.getAttribute('href')||'',
      src:(el.tagName==='IMG'||el.tagName==='VIDEO'||el.tagName==='SOURCE'||el.tagName==='AUDIO'||el.tagName==='IFRAME')
        ? (el.currentSrc||el.src||el.getAttribute('src')||'')
        : (el.getAttribute('src')||''),
      alt:el.getAttribute('alt')||'',
      /* Fallback per i wrapper: se l'elemento selezionato NON e' un media
         ma contiene un <img> (tipico ClickFunnels/Funnelish: il click
         prende il div .elImage / un overlay invece dell'<img>), esponiamo
         il src del primo <img> discendente cosi' il pannello mostra
         comunque il controllo "cambia immagine". */
      childImg:(function(){
        if(el.tagName==='IMG'||el.tagName==='VIDEO')return null;
        /* Scegliamo l'<img> PIU' GRANDE (per area renderizzata) dentro il
           blocco, non il primo nel DOM: cosi' "cambia immagine" agisce
           sull'immagine principale (es. hero in alto) e non su una piccola
           icona dei bullet che capita prima nel markup. */
        var im=null;try{
          var _imgs=el.querySelectorAll('img');var _ba=-1;
          for(var _i=0;_i<_imgs.length;_i++){var _r=_imgs[_i].getBoundingClientRect();var _a=_r.width*_r.height;if(_a>_ba){_ba=_a;im=_imgs[_i];}}
          if(!im)im=el.querySelector('img');
        }catch(e){}
        if(im)return{src:(im.currentSrc||im.src||im.getAttribute('src')||''),alt:im.getAttribute('alt')||''};
        return null;
      })(),
      /* Background-image NEL BLOCCO: spesso l'hero/sezione ha l'immagine
         come CSS background su SE STESSO o su un DIV figlio (non un <img>),
         quindi il click seleziona il wrapper e non si riesce a cambiarla.
         Cerchiamo l'elemento (self o discendente) con l'area piu' grande che
         abbia un background-image url(...), ed esponiamo la sua URL cosi' il
         pannello mostra "Immagine di sfondo (nel blocco)". */
      /* TUTTE le <img> nel blocco — serve per caroselli/gallery/Swiper dove
         ci sono N slide e modificarne "una" col selettore singolo sembra
         "scollegato" (cambia la slide sbagliata o invisibile). Esponiamo la
         lista così l'utente sostituisce ogni immagine per indice (stabile in
         ordine DOM). Solo se >1 (per 1 sola basta childImg). */
      childImgs:(function(){
        /* 1) Se siamo dentro un carosello/slider (self o antenato), elenchiamo
              TUTTE le immagini del contenitore: cosi' anche cliccando una sola
              slide o l'immagine visibile, l'utente puo' sostituirle tutte.
           2) Altrimenti, se il blocco selezionato (non-img) contiene piu' <img>,
              usiamo il blocco stesso (gallery/griglia generica). */
        var scope=carScope(el)||(el.tagName!=='IMG'?el:null);
        if(!scope)return null;
        var out=[];try{
          var ims=scope.querySelectorAll('img');
          for(var i=0;i<ims.length&&i<60;i++){
            var s=ims[i].currentSrc||ims[i].src||ims[i].getAttribute('src')||'';
            out.push({src:s,alt:ims[i].getAttribute('alt')||''});
          }
        }catch(e){}
        return out.length>1?out:null;
      })(),
      childBg:(function(){
        try{
          var cand=[el].concat(Array.prototype.slice.call(el.querySelectorAll('*')));
          var best=null,bestSrc='',ba=-1;
          for(var i=0;i<cand.length;i++){
            var c=cand[i];var bi='';try{bi=getComputedStyle(c).backgroundImage||'';}catch(e){continue;}
            if(!bi||bi==='none'||bi.indexOf('url(')<0)continue;
            var mm=bi.match(/url[(]['"]?([^'")]*)['"]?[)]/i);if(!mm||!mm[1])continue;
            /* Salta gradienti/data-uri minuscoli e spacer */
            var u=mm[1];if(u.indexOf('data:image/svg')===0)continue;
            var rr=c.getBoundingClientRect();var ar=rr.width*rr.height;
            if(ar>ba){ba=ar;best=c;bestSrc=u;}
          }
          if(best)return{src:bestSrc};
        }catch(e){}
        return null;
      })(),
      videoAttrs:(el.tagName==='VIDEO'?{
        controls:el.hasAttribute('controls'),
        autoplay:el.hasAttribute('autoplay'),
        loop:el.hasAttribute('loop'),
        muted:el.hasAttribute('muted'),
        playsinline:el.hasAttribute('playsinline')||el.hasAttribute('webkit-playsinline'),
        preload:el.getAttribute('preload')||'metadata',
        /* el.poster è la prop DOM absolutizzata (vs getAttribute che è raw). */
        poster:el.poster||el.getAttribute('poster')||'',
      }:null),
      rect:{x:r.x,y:r.y,width:r.width,height:r.height},
      isTextNode:el.childNodes.length===1&&el.childNodes[0].nodeType===3,
      hasChildren:el.children.length>0,childCount:el.children.length,
      styles:{
        color:cs.color,backgroundColor:cs.backgroundColor,
        fontSize:cs.fontSize,fontWeight:cs.fontWeight,fontFamily:cs.fontFamily,
        fontStyle:cs.fontStyle,textDecoration:cs.textDecoration,
        textAlign:cs.textAlign,lineHeight:cs.lineHeight,
        padding:cs.padding,margin:cs.margin,borderRadius:cs.borderRadius,
        paddingTop:cs.paddingTop,paddingRight:cs.paddingRight,paddingBottom:cs.paddingBottom,paddingLeft:cs.paddingLeft,
        marginTop:cs.marginTop,marginRight:cs.marginRight,marginBottom:cs.marginBottom,marginLeft:cs.marginLeft,
        border:cs.border,display:cs.display,opacity:cs.opacity,
        backgroundImage:cs.backgroundImage,
        width:cs.width,height:cs.height,
        maxWidth:cs.maxWidth,minWidth:cs.minWidth,
        maxHeight:cs.maxHeight,minHeight:cs.minHeight,
        overflow:cs.overflow,position:cs.position,
        gap:cs.gap,flexDirection:cs.flexDirection,
        justifyContent:cs.justifyContent,alignItems:cs.alignItems,
      }
    };
  }

  function co(el){if(el){el.style.outline='';el.style.outlineOffset='';}}
  function sk(el){
    if(!el||el===document.documentElement||el===document.body||el===document.head)return true;
    var t=el.tagName&&el.tagName.toLowerCase();
    return!t||t==='html'||t==='head'||t==='style'||t==='link'||t==='meta'||t==='script'||t==='noscript';
  }

  var plusBtn=document.createElement('div');
  plusBtn.setAttribute('data-editor-ui','1');
  plusBtn.innerHTML='+';
  plusBtn.style.cssText='position:absolute;z-index:999999;width:32px;height:32px;border-radius:50%;background:#3b82f6;color:#fff;font-size:20px;line-height:32px;text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);display:none;pointer-events:auto;transition:transform .15s;user-select:none;';
  plusBtn.onmouseenter=function(){plusBtn.style.transform='scale(1.15)';};
  plusBtn.onmouseleave=function(){plusBtn.style.transform='scale(1)';};
  var insertTarget=null;
  plusBtn.onclick=function(e){e.preventDefault();e.stopPropagation();
    window.parent.postMessage({type:'request-insert-after'},'*');};
  document.body.appendChild(plusBtn);

  var delBtn=document.createElement('div');
  delBtn.setAttribute('data-editor-ui','1');
  delBtn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  delBtn.style.cssText='position:absolute;z-index:999999;width:28px;height:28px;border-radius:6px;background:#ef4444;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:auto;transition:transform .15s,background .15s;user-select:none;opacity:0;transition:opacity .15s,transform .15s;';
  delBtn.onmouseenter=function(){delBtn.style.transform='scale(1.15)';delBtn.style.background='#dc2626';};
  delBtn.onmouseleave=function(){delBtn.style.transform='scale(1)';delBtn.style.background='#ef4444';};
  var delTarget=null;
  delBtn.onclick=function(e){e.preventDefault();e.stopPropagation();
    var toDelete=delTarget||sel;
    if(toDelete){
      if(sel===toDelete){co(sel);sel=null;insertTarget=null;plusBtn.style.display='none';window.parent.postMessage({type:'element-deselected'},'*');}
      if(hover===toDelete)hover=null;
      hideResize();
      toDelete.remove();delTarget=null;delBtn.style.opacity='0';
      sendHtml();
    }
  };
  document.body.appendChild(delBtn);

  function positionDel(el){
    if(!el||sk(el)){delBtn.style.opacity='0';return;}
    var r=el.getBoundingClientRect();
    delBtn.style.left=(r.right-34+window.scrollX)+'px';
    delBtn.style.top=(r.top+6+window.scrollY)+'px';
    delBtn.style.opacity='1';
    delTarget=el;
  }
  function hideDel(){delBtn.style.opacity='0';delTarget=null;}

  /* ── Maniglie di ridimensionamento ──
     Tre maniglie su OGNI blocco/sezione selezionata:
       • angolo in basso a destra (SE) → larghezza+altezza (proporzionale
         se il target e' una foto/video);
       • lato destro (E) → solo larghezza;
       • lato inferiore (S) → solo altezza.
     Trascinandole si ingrandisce/rimpicciolisce; i contenitori crescono
     nel flusso spingendo giu' il contenuto (niente sovrapposizioni). */
  function makeHandle(axis,cursor,icon){
    var h=document.createElement('div');
    h.setAttribute('data-editor-ui','1');
    if(icon)h.innerHTML=icon;
    h.style.cssText='position:absolute;z-index:999999;width:20px;height:20px;border-radius:6px;background:#3b82f6;display:none;align-items:center;justify-content:center;cursor:'+cursor+';box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:auto;touch-action:none;user-select:none;border:2px solid #fff;';
    document.body.appendChild(h);
    h.addEventListener('pointerdown',function(e){startResize(e,axis,h);});
    h.addEventListener('pointermove',moveResize);
    h.addEventListener('pointerup',endResize);
    h.addEventListener('pointercancel',endResize);
    return h;
  }
  var rzSE=makeHandle('se','nwse-resize','<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v6h-6"/><path d="M3 9V3h6"/><path d="M21 21 3 3"/></svg>');
  var rzE=makeHandle('e','ew-resize','');
  var rzS=makeHandle('s','ns-resize','');
  var rzHandles=[rzSE,rzE,rzS];

  var resizeTarget=null;
  /* pickResizeTarget — le maniglie agiscono SEMPRE sull'elemento
     effettivamente selezionato: se selezioni l'immagine ridimensioni
     l'immagine, se selezioni un blocco/contenitore esterno ridimensioni
     quel blocco. Cosi' funzionano su qualsiasi livello (interno o esterno). */
  function pickResizeTarget(el){
    if(!el||el.nodeType!==1||sk(el))return null;
    return el;
  }
  function positionResize(el){
    var m=pickResizeTarget(el);
    if(!m){hideResize();return;}
    resizeTarget=m;
    var r=m.getBoundingClientRect();
    var L=r.left+window.scrollX,T=r.top+window.scrollY;
    /* SE = angolo basso-destra; E = meta' lato destro; S = meta' lato basso. */
    rzSE.style.left=(L+r.width-14)+'px';rzSE.style.top=(T+r.height-14)+'px';
    rzE.style.left=(L+r.width-12)+'px';rzE.style.top=(T+r.height/2-10)+'px';
    rzS.style.left=(L+r.width/2-10)+'px';rzS.style.top=(T+r.height-12)+'px';
    for(var i=0;i<rzHandles.length;i++)rzHandles[i].style.display='flex';
  }
  function hideResize(){for(var i=0;i<rzHandles.length;i++)rzHandles[i].style.display='none';resizeTarget=null;}

  var resizing=false,rzAxis='',rzStartLeft=0,rzStartTop=0,rzParentW=0,rzStartW=0,rzStartH=0,rzIsMedia=false;
  function startResize(e,axis,h){
    var el=pickResizeTarget(sel);
    if(!el)return;
    e.preventDefault();e.stopPropagation();
    resizing=true;rzAxis=axis;resizeTarget=el;
    var r=el.getBoundingClientRect();
    rzStartLeft=r.left;rzStartTop=r.top;rzStartW=r.width;rzStartH=r.height;
    /* Larghezza del contenitore: la larghezza viene salvata in % di questo,
       cosi' la stessa modifica si adatta sia su desktop che su mobile. */
    var _par=el.parentElement;
    rzParentW=_par?(_par.clientWidth||_par.getBoundingClientRect().width):r.width;
    if(!rzParentW)rzParentW=r.width||1;
    var tag=(el.tagName||'').toLowerCase();
    rzIsMedia=(tag==='img'||tag==='video');
    if(rzIsMedia){
      el.style.setProperty('max-width','100%','important');
      if(axis==='se'){
        /* Angolo su media = scala l'intera immagine mantenendo il rapporto
           naturale (larghezza in %, altezza automatica → responsive). */
        normalizeMedia(el);
      }else{
        /* Un solo asse su media = frame con object-fit cover; la FORMA e'
           gestita da aspect-ratio (relativo) invece che da px fissi, cosi'
           resta responsive tra desktop e mobile. */
        el.style.setProperty('object-fit','cover','important');
        el.style.setProperty('max-height','none','important');
        el.style.setProperty('height','auto','important');
        el.style.setProperty('width',(rzStartW/rzParentW*100).toFixed(2)+'%','important');
        el.style.setProperty('aspect-ratio',Math.round(rzStartW)+' / '+Math.round(rzStartH),'important');
      }
    }else{
      /* Blocco/collage/sezione: libera altezza e normalizza le immagini
         interne cosi' scalano col blocco senza sbordare. */
      el.style.setProperty('max-height','none','important');
      el.style.removeProperty('aspect-ratio');
      el.style.setProperty('max-width','100%','important');
      var _inner=el.querySelectorAll('img,video');
      for(var _im=0;_im<_inner.length;_im++)normalizeMedia(_inner[_im]);
    }
    /* Libera l'altezza dei contenitori: crescendo spingono giu' il resto. */
    relaxAncestors(el);
    try{h.setPointerCapture(e.pointerId);}catch(_e){}
  }
  function moveResize(e){
    if(!resizing||!resizeTarget)return;
    e.preventDefault();
    if(rzAxis==='e'||rzAxis==='se'){
      var newW=e.clientX-rzStartLeft;
      if(newW<40)newW=40;
      if(newW>rzParentW)newW=rzParentW;
      var pct=newW/rzParentW*100;if(pct>100)pct=100;
      /* Larghezza in % → responsive su desktop e mobile. */
      resizeTarget.style.setProperty('width',pct.toFixed(2)+'%','important');
      resizeTarget.style.setProperty('max-width','100%','important');
      if(rzIsMedia&&rzAxis==='e'){
        /* Solo larghezza su media: aggiorna la forma (aspect-ratio) mantenendo
           l'altezza attuale, restando in unita' relative. */
        resizeTarget.style.setProperty('aspect-ratio',Math.round(newW)+' / '+Math.round(rzStartH),'important');
        resizeTarget.style.setProperty('height','auto','important');
      }
    }
    if(rzAxis==='s'||rzAxis==='se'){
      if(rzIsMedia){
        if(rzAxis==='se'){
          /* Angolo su media: rapporto naturale (nessun aspect-ratio forzato). */
          resizeTarget.style.setProperty('height','auto','important');
          resizeTarget.style.removeProperty('aspect-ratio');
        }else{
          /* Solo altezza su media: cambia la forma via aspect-ratio, la
             larghezza (%) resta invariata → responsive. */
          var newHm=e.clientY-rzStartTop;if(newHm<20)newHm=20;
          resizeTarget.style.setProperty('aspect-ratio',Math.round(rzStartW)+' / '+Math.round(newHm),'important');
          resizeTarget.style.setProperty('height','auto','important');
        }
      }else{
        /* Blocchi non-media: l'altezza resta in px (contenuto variabile). */
        var newH=e.clientY-rzStartTop;
        if(newH<20)newH=20;
        resizeTarget.style.setProperty('height',Math.round(newH)+'px','important');
      }
    }
    positionResize(sel);
    positionPlus();positionDel(sel);
  }
  function endResize(e){
    if(!resizing)return;
    resizing=false;
    try{e.target.releasePointerCapture(e.pointerId);}catch(_e){}
    sendHtml();
    if(sel)window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');
    positionResize(sel);
  }

  function positionPlus(){
    if(!sel){plusBtn.style.display='none';return;}
    var r=sel.getBoundingClientRect();
    plusBtn.style.left=(r.left+r.width/2-16+window.scrollX)+'px';
    plusBtn.style.top=(r.bottom+6+window.scrollY)+'px';
    plusBtn.style.display='block';
  }

  function selectEl(el){
    if(sk(el)||isUI(el))return;
    if(sel)co(sel);sel=el;insertTarget=el;
    el.style.outline=SS;el.style.outlineOffset='2px';
    window.parent.postMessage({type:'element-selected',data:gi(el)},'*');
    positionPlus();positionDel(el);positionResize(el);
  }

  // sendHtml fa outerHTML del documento intero + structuredClone via
  // postMessage. Su landing grandi (centinaia di KB) blocca il main thread
  // ad ogni operazione. Coalesco con debounce: se in 200ms arrivano altre
  // mutazioni (typing, MutationObserver, plusBtn drag, ecc.) faccio un solo
  // invio. Per save/finishEdit espongo sendHtmlNow() che bypassa il debounce.
  var __sendHtmlTimer=null;
  function _sendHtmlImmediate(){
    var saved=null,so=null;
    if(sel){saved=sel.style.outline;so=sel.style.outlineOffset;sel.style.outline='';sel.style.outlineOffset='';}
    if(editEl){editEl.contentEditable='false';}
    plusBtn.style.display='none';var delVis=delBtn.style.opacity;delBtn.style.opacity='0';
    delBtn.style.display='none';plusBtn.style.display='none';
    var rzVis=[];for(var _rh=0;_rh<rzHandles.length;_rh++){rzVis.push(rzHandles[_rh].style.display);rzHandles[_rh].style.display='none';}
    var h='<!DOCTYPE html>'+document.documentElement.outerHTML;
    delBtn.style.display='';plusBtn.style.display='';for(var _rh2=0;_rh2<rzHandles.length;_rh2++){rzHandles[_rh2].style.display=rzVis[_rh2];}
    if(sel){sel.style.outline=saved;sel.style.outlineOffset=so;positionPlus();positionResize(sel);}
    delBtn.style.opacity=delVis;
    if(editEl){editEl.contentEditable='true';}
    window.parent.postMessage({type:'html-updated',data:h},'*');
  }
  function sendHtml(){
    if(__sendHtmlTimer) clearTimeout(__sendHtmlTimer);
    __sendHtmlTimer=setTimeout(function(){__sendHtmlTimer=null;_sendHtmlImmediate();},200);
  }
  function sendHtmlNow(){
    if(__sendHtmlTimer){clearTimeout(__sendHtmlTimer);__sendHtmlTimer=null;}
    _sendHtmlImmediate();
  }

  function finishEdit(){
    if(!editEl)return;
    editEl.contentEditable='false';co(editEl);
    if(sel===editEl){editEl.style.outline=SS;editEl.style.outlineOffset='2px';}
    window.parent.postMessage({type:'editing-finished',data:gi(editEl)},'*');
    editing=false;editEl=null;sendHtml();
  }

  // Block native image/link drag so click events fire normally
  window.addEventListener('scroll',function(){positionPlus();if(sel){positionDel(sel);positionResize(sel);}else if(hover)positionDel(hover);},true);
  window.addEventListener('resize',function(){positionPlus();if(sel){positionDel(sel);positionResize(sel);}else if(hover)positionDel(hover);});

  document.addEventListener('dragstart',function(e){e.preventDefault();},true);

  // Disable draggable on all images and future images.
  // L'observer skippa <img> che hanno gia' draggable=false: senza skip,
  // setAttribute scatena una nuova mutation → l'observer si auto-richiama,
  // potenzialmente in loop su DOM molto dinamici (slider/swiper che
  // ri-creano img). Disconnect su unload per non lasciare lavoro pendente.
  document.querySelectorAll('img').forEach(function(img){
    if(img.getAttribute('draggable')!=='false') img.setAttribute('draggable','false');
  });
  var __imgObs=new MutationObserver(function(muts){
    for(var mi=0;mi<muts.length;mi++){
      var m=muts[mi];
      for(var ai=0;ai<m.addedNodes.length;ai++){
        var n=m.addedNodes[ai];
        if(n.nodeType!==1)continue;
        if(n.tagName==='IMG'){
          if(n.getAttribute('draggable')!=='false') n.setAttribute('draggable','false');
        }
        if(n.querySelectorAll){
          var imgs=n.querySelectorAll('img');
          for(var ii=0;ii<imgs.length;ii++){
            if(imgs[ii].getAttribute('draggable')!=='false') imgs[ii].setAttribute('draggable','false');
          }
        }
      }
    }
  });
  __imgObs.observe(document.body,{childList:true,subtree:true});
  window.addEventListener('unload',function(){ try{__imgObs.disconnect();}catch(_){} },{once:true});

  function isUI(el){
    if(el===plusBtn||el===delBtn||plusBtn.contains(el)||delBtn.contains(el))return true;
    for(var i=0;i<rzHandles.length;i++){if(el===rzHandles[i]||rzHandles[i].contains(el))return true;}
    return false;
  }

  /* ── FAQ/ACCORDION CLICK DELEGATE (editor) ─────────────────────────
   * Toggle reale apri/chiudi DENTRO l'editor anche per accordion senza
   * classi note. Riusiamo la stessa euristica del rescue script in
   * preview (vedi src/lib/spa-rescue.ts): elenco di selettori "buoni"
   * + fuzzy match per classe + ispezione strutturale (fratello dopo il
   * trigger, primo figlio panel-like).
   *
   * Cosi' funzionano:
   *   - .faq-question / .accordion-header e simili noti
   *   - <details>/<summary>
   *   - <label for="x"> + <input type="checkbox" id="x"> (CSS-only)
   *   - container ".elBlock"/"faq__row"/qualsiasi cosa con "faq",
   *     "accordion", "toggle", "collaps", "expand", "question",
   *     "dropdown" nel className + un figlio panel-shaped.
   *
   * Lo stato chiuso viene applicato inline con display:none !important
   * sul pannello: vince sulle regole "force-open" del CSS editor e su
   * eventuali !important della pagina originale. */
  var FAQ_TRIG='.faq-header,.faq-title,.faq-question,.faq-trigger,.faq-toggle,.faq__question,.faq__title,'+
    '.accordion-header,.accordion-button,.accordion-toggle,.accordion-trigger,.accordion-title,.toggle-header,'+
    '.elFAQItemQuestion,.elementor-tab-title,.e-n-accordion-item-title,'+
    '.uk-accordion-title,.wp-block-coblocks-accordion-item__title,.kt-accordion-header,'+
    '[data-accordion-trigger],[data-faq-toggle],[data-faq-trigger],[data-faq-question],'+
    '[aria-controls],summary,label[for]';
  var FAQ_ITEM_SEL='.faq,.faq-wrapper,.faq-item,.accordion-item,.accordion,.toggle-item,.elFAQItem,[data-faq],details';
  var FAQ_PANEL='.faq-content-wrapper,.faq-content,.accordion-content,.accordion-body,.accordion-collapse,'+
    '.faq-body,.faq-answer,.elFAQItemAnswer,.toggle-content,.collapse-content,[data-accordion-content]';
  var FAQ_ITEM_RE=/(faq|accordion|toggle|collaps|expand|question|drop.?down)/i;
  var FAQ_PANEL_RE=/(content|answer|body|panel|collaps|detail|inner|text|wrapper)/i;
  function _faqCls(el){if(!el)return '';var c=el.className;if(c&&typeof c==='object'&&'baseVal'in c)return c.baseVal;return ''+(c||'');}
  function _isPanelLike(el){return el&&el.nodeType===1&&(FAQ_PANEL_RE.test(_faqCls(el))||(el.matches&&el.matches(FAQ_PANEL)));}
  function _findFaqPanel(trigger,item){
    /* 1) FRATELLO immediato dopo il trigger (struttura flat header→panel) */
    var n=trigger&&trigger.nextElementSibling;
    while(n){if(_isPanelLike(n))return n;n=n.nextElementSibling;}
    /* 2) Pannello esplicito dentro l'item */
    try{var p=item&&item.querySelector(FAQ_PANEL);if(p)return p;}catch(e){}
    /* 3) Primo figlio panel-like, oppure ultimo figlio come fallback */
    if(item&&item.children){
      for(var i=0;i<item.children.length;i++){var k=item.children[i];if(k!==trigger&&_isPanelLike(k))return k;}
      if(item.children.length>=2){var last=item.children[item.children.length-1];if(last!==trigger&&!(trigger&&last.contains&&last.contains(trigger)))return last;}
    }
    return null;
  }
  function _findFaqItem(t){
    var el=t,depth=0;
    while(el&&el.nodeType===1&&depth<10){
      try{if(el.matches&&el.matches(FAQ_ITEM_SEL))return el;}catch(_){}
      if(FAQ_ITEM_RE.test(_faqCls(el))&&_findFaqPanel(null,el))return el;
      el=el.parentElement;depth++;
    }
    return null;
  }
  function _faqTriggerFor(t){
    if(!t||t.nodeType!==1)return null;
    try{
      /* Non considerare actionable form fields (l'utente clicca un input
         vero, non un accordion) tranne i <label> che spesso fanno da
         trigger di checkbox accordion. */
      var actionable=t.closest('a[href]:not([href="#"]):not([href=""]):not([href^="#"]),button[type="submit"],select,textarea');
      if(actionable)return null;
      var direct=t.closest(FAQ_TRIG);
      if(direct){
        var dt=direct.tagName&&direct.tagName.toLowerCase();
        if(dt==='input'&&direct.type!=='checkbox')return null;
        if(dt==='select'||dt==='textarea')return null;
        return direct;
      }
      /* Fuzzy: dentro un item-shaped, considera trigger il PRIMO figlio
         (tipico header senza class nota). */
      var it=_findFaqItem(t);
      if(it&&it.children.length>=2){
        var first=it.children[0];
        if(first&&(first===t||(first.contains&&first.contains(t))))return first;
      }
    }catch(e){}
    return null;
  }
  function _setFaqOpen(panel,open){
    if(!panel)return;
    try{
      if(open){
        panel.style.setProperty('display','block','important');
        panel.style.setProperty('max-height','none','important');
        panel.style.setProperty('height','auto','important');
        panel.style.setProperty('overflow','visible','important');
        panel.style.setProperty('visibility','visible','important');
        panel.style.setProperty('opacity','1','important');
        panel.style.setProperty('pointer-events','auto','important');
      }else{
        panel.style.setProperty('display','none','important');
      }
    }catch(e){panel.style.display=open?'block':'none';}
    panel.setAttribute('data-wasabi-open',open?'1':'0');
  }
  function _faqPanelOpen(p){
    if(!p)return false;
    if(p.hasAttribute('data-wasabi-open'))return p.getAttribute('data-wasabi-open')==='1';
    try{return getComputedStyle(p).display!=='none';}catch(e){return true;}
  }
  function _toggleFaq(target){
    var trigger=_faqTriggerFor(target);
    if(!trigger)return null;
    var item=_findFaqItem(trigger)||trigger.parentElement;
    if(!item)return null;
    var panel=_findFaqPanel(trigger,item);
    if(!panel)return null;
    /* Click DENTRO un pannello aperto = lascia passare (l'utente sta
       cercando di selezionare/editare il contenuto, non chiudere). */
    var inPanel=target.closest&&target.closest(FAQ_PANEL);
    if(inPanel&&_faqPanelOpen(inPanel))return null;
    /* I <details> sono gestiti dal browser nativamente. prepareEditorHtml
       ha gia' rimosso onclick="return false" e l'attributo open, quindi
       click su summary fa il toggle UA-shadow-DOM perfetto. Il bypass
       'sumDet' nel click delegate principale ferma il dispatch qui PRIMA
       che _toggleFaq venga chiamato. Se per qualche motivo arriviamo qui
       con un <details> (target non-summary dentro details), ritorniamo
       null cosi' il browser continua col flow nativo senza interferenze. */
    if(item&&item.tagName==='DETAILS')return null;
    var willOpen=!_faqPanelOpen(panel);
    _setFaqOpen(panel,willOpen);
    if(item&&item!==panel&&item.classList){
      item.classList.toggle('is-open',willOpen);
      item.classList.toggle('active',willOpen);
      item.classList.toggle('expanded',willOpen);
      item.classList.toggle('open',willOpen);
    }
    try{
      var aria=item.querySelectorAll('[aria-expanded]');
      for(var i=0;i<aria.length;i++)aria[i].setAttribute('aria-expanded',willOpen?'true':'false');
    }catch(e){}
    /* Accordion CSS-only basati su <input type="checkbox">: sincronizza
       lo stato del box (sia se il trigger e' <label for> sia se l'input
       e' un fratello/figlio dell'item). */
    try{
      var box=null;
      if(trigger.tagName==='LABEL'&&trigger.htmlFor)box=document.getElementById(trigger.htmlFor);
      if(!box)box=item.querySelector('input[type="checkbox"],input[type="radio"]');
      if(box){box.checked=willOpen;}
    }catch(e){}
    return trigger;
  }

  /* ── CAROUSEL RESCUE (editor) ──────────────────────────────────────
   * Identico a spa-rescue.ts: gli script di slick/swiper/replo sono
   * stati strippati dall'editor, quindi i carousel restano statici
   * (tutte le slide impilate o solo la prima visibile). Qui ricostruiamo
   * un mini-carousel: show(k) mostra una slide alla volta, le frecce
   * prev/next e le thumbs scorrono.
   *
   * Idempotente via track.__wbCar e bound solo se trova controlli
   * (frecce o thumbs); senza controlli rinuncia e lascia che la CSS
   * di stacking impilata (vedi prepareEditorHtml) faccia vedere tutte
   * le slide. */
  var CAR_PREV='.lc-arrow-prev,.slick-prev,.slider-prev,.swiper-button-prev,[aria-label="Previous slide"]';
  var CAR_NEXT='.lc-arrow-next,.slick-next,.slider-next,.swiper-button-next,[aria-label="Next slide"]';
  var CAR_NAV='.slider-nav,.slick-dots,.slider-nav-thumbnails,.swiper-pagination';
  var CAR_SCOPE='[data-replo-carousel],.left-slider,.carousel,.swiper,.slick-slider,.r-16fpy55';
  var CAR_TRACK='.slider-for,.swiper-wrapper';
  function _wbSlides(track){
    var out=[];
    for(var i=0;i<track.children.length;i++){
      var c=track.children[i];
      if(!c||c.nodeType!==1||c.tagName==='BUTTON')continue;
      var hasImg=(c.querySelector&&c.querySelector('img'))||c.tagName==='IMG';
      var clsSlide=/r-ldsnaw|slick-slide|swiper-slide/i.test(''+(c.className||''));
      if(hasImg||clsSlide)out.push(c);
    }
    return out;
  }
  function _bindCarousel(track){
    if(!track||track.__wbCar)return null;
    var slides=_wbSlides(track);
    if(slides.length<2)return null;
    var scope=(track.closest&&track.closest(CAR_SCOPE))||track.parentElement||track;
    var prev=scope.querySelector(CAR_PREV);
    var next=scope.querySelector(CAR_NEXT);
    var nav=scope.querySelector(CAR_NAV);
    var thumbs=[];
    if(nav){for(var n=0;n<nav.children.length;n++){var tc=nav.children[n];if(tc&&tc.nodeType===1&&((tc.querySelector&&tc.querySelector('img'))||tc.tagName==='IMG'))thumbs.push(tc);}}
    /* Bind SEMPRE se ci sono >=2 slide. Anche senza controlli espliciti,
       mostriamo una slide alla volta cosi' l'editor corrisponde al
       preview. Se la pagina non ha frecce/thumbs riconosciute, l'utente
       puo' navigare in altro modo (es. usando il pannello laterale
       delle immagini), ma almeno non vede 5+ slide impilate. */
    track.__wbCar={idx:0,slides:slides,prev:prev,next:next,thumbs:thumbs};
    var car=track.__wbCar;
    car.show=function(k){
      car.idx=(k%slides.length+slides.length)%slides.length;
      for(var i=0;i<slides.length;i++){
        /* !important obbligatorio: l'editorCss e/o regole della pagina
           hanno display:block !important sulle .swiper-slide /
           .slick-slide. Senza !important inline qui, show() viene
           ignorata e le slide restano tutte visibili. */
        if(i===car.idx){slides[i].style.removeProperty('display');}
        else{slides[i].style.setProperty('display','none','important');}
        /* Reset transform/position per-slide: Slick/Swiper lasciano
           inline-transforms che spostano la slide visibile fuori-vista. */
        try{
          slides[i].style.setProperty('transform','none','important');
          slides[i].style.setProperty('position','relative','important');
          slides[i].style.setProperty('left','auto','important');
        }catch(e){}
      }
      for(var j=0;j<thumbs.length;j++){
        var on=(j===car.idx);
        thumbs[j].style.opacity=on?'1':'0.5';
        try{thumbs[j].classList.toggle('r-19wtxcv',on);thumbs[j].classList.toggle('slick-current',on);thumbs[j].classList.toggle('slick-active',on);thumbs[j].classList.toggle('swiper-pagination-bullet-active',on);}catch(e){}
      }
    };
    /* Neutralizza il translate3d/transform che slick/swiper originali
       hanno lasciato sul TRACK. Senza JS attivo, il translate sposta
       il wrapper fuori-vista o su una slide sbagliata. */
    try{
      track.style.setProperty('transform','none','important');
      track.style.setProperty('-webkit-transform','none','important');
      track.style.setProperty('transition','none','important');
      track.style.setProperty('width','auto','important');
      track.style.setProperty('left','auto','important');
      track.style.setProperty('display','block','important');
    }catch(e){}
    if(prev){prev.style.cursor='pointer';prev.setAttribute('data-wb-car-ctl','prev');}
    if(next){next.style.cursor='pointer';next.setAttribute('data-wb-car-ctl','next');}
    for(var t=0;t<thumbs.length;t++){thumbs[t].style.cursor='pointer';thumbs[t].setAttribute('data-wb-car-ctl','thumb');thumbs[t].setAttribute('data-wb-car-thumb-idx',String(t));}
    car.show(0);
    return car;
  }
  function _initCarousels(){
    try{
      var tracks=document.querySelectorAll(CAR_TRACK);
      for(var i=0;i<tracks.length;i++){
        var tr=tracks[i];
        /* Se Swiper/Slick nativi della pagina hanno gia' inizializzato
           il carousel (verifichiamo via classe), non sostituirsi: il
           bind nativo e' pixel-perfect. Il nostro _bindCarousel e' un
           FALLBACK per pagine in cui la library non e' presente. */
        var par=tr.parentElement;
        var alreadyInit=(par&&(par.classList.contains('swiper-initialized')||par.classList.contains('slick-initialized')))||tr.classList.contains('swiper-initialized')||tr.classList.contains('slick-initialized');
        if(alreadyInit)continue;
        _bindCarousel(tr);
      }
    }catch(e){}
  }
  /* Gestisce click su una freccia/thumb di un carousel: trova il track
     legato, sposta la slide, ritorna lo scope da selezionare. Null se
     non e' un controllo carousel riconosciuto. */
  function _handleCarouselClick(t){
    if(!t||t.nodeType!==1)return null;
    var ctl=t.closest('[data-wb-car-ctl]');
    if(!ctl)return null;
    var scope=ctl.closest(CAR_SCOPE)||ctl.parentElement;
    if(!scope)return null;
    var track=scope.querySelector(CAR_TRACK);
    if(!track||!track.__wbCar)return null;
    var car=track.__wbCar;
    var kind=ctl.getAttribute('data-wb-car-ctl');
    if(kind==='prev')car.show(car.idx-1);
    else if(kind==='next')car.show(car.idx+1);
    else if(kind==='thumb'){
      var idx=parseInt(ctl.getAttribute('data-wb-car-thumb-idx')||'0',10);
      car.show(idx);
    }
    return scope;
  }

  document.addEventListener('mouseover',function(e){
    if(editing)return;var el=e.target;if(sk(el)||el===sel||isUI(el))return;
    if(hover&&hover!==sel)co(hover);hover=el;el.style.outline=HS;el.style.outlineOffset='1px';
    positionDel(el);
  },true);

  document.addEventListener('mouseout',function(e){
    var el=e.target;if(isUI(el))return;if(el!==sel)co(el);if(hover===el)hover=null;
    var related=e.relatedTarget;
    if(!related||(!isUI(related)&&related!==el)){
      setTimeout(function(){if(!hover&&!delBtn.matches(':hover'))hideDel();},100);
    }
  },true);

  // mousedown on images/svg/video/canvas as primary selection (click may not fire due to residual drag)
  document.addEventListener('mousedown',function(e){
    var el=e.target;
    if(!el||!el.tagName||isUI(el))return;
    var t=el.tagName.toLowerCase();
    if(t==='img'||t==='svg'||t==='video'||t==='canvas'||t==='picture'||t==='iframe'||t==='object'||t==='embed'){
      e.preventDefault();e.stopPropagation();
      if(editing&&editEl)finishEdit();
      selectEl(el);
    }
  },true);

  document.addEventListener('click',function(e){
    if(isUI(e.target))return;
    if(editing&&editEl&&!editEl.contains(e.target)){finishEdit();}
    if(editing&&editEl&&editEl.contains(e.target))return;
    /* NATIVE CAROUSEL CONTROLS: se ho cliccato una freccia/dot/thumb di
       Swiper/Slick/etc., lascia che il LIBRARY NATIVE handler scorra
       il carousel. Non preventDefault, non stopPropagation, non
       selectEl: il delegate dell'editor non deve rubare questi click. */
    var nativeCtl=e.target.closest&&e.target.closest(
      '.swiper-button-prev,.swiper-button-next,.swiper-pagination-bullet,'+
      '.slick-prev,.slick-next,.slick-dots button,.slick-dots li,'+
      '.glide__arrow,.glide__bullet,'+
      '.splide__arrow,.splide__pagination__page,'+
      '.flickity-prev-next-button,.flickity-page-dot,'+
      '.owl-prev,.owl-next,.owl-dot,'+
      '[data-wb-car-ctl]'
    );
    if(nativeCtl){
      /* Lascia passare al library; non selezionare il bottone. */
      return;
    }
    /* CAROUSEL FALLBACK (solo per pagine senza Swiper/Slick/etc. che il
       nostro _bindCarousel ha legato manualmente): scorri e seleziona
       lo scope. _handleCarouselClick ritorna null se non c'e' binding. */
    var carScopeEl=_handleCarouselClick(e.target);
    if(carScopeEl){
      e.preventDefault();e.stopPropagation();
      selectEl(carScopeEl);
      return;
    }
    /* <details>+<summary>: il browser gestisce il toggle nativamente
       (l'HTML ha gia' avuto onclick="return false" e 'open' rimossi in
       prepareEditorHtml). NON facciamo preventDefault: bloccherebbe il
       toggle. Selezioniamo il summary per consentire styling dell'header
       e lasciamo che il browser apra/chiuda il details da solo. */
    var sumDet=e.target.closest&&e.target.closest('summary');
    if(sumDet){
      e.stopPropagation();
      selectEl(sumDet);
      return; // NIENTE preventDefault - il browser fa il toggle nativo
    }
    /* FAQ/accordion non-details: prova il toggle custom. Se restituisce
       il trigger, blocchiamo l'evento (niente href="#"/submit/altri
       side-effect) e selezioniamo l'header cosi' l'utente puo' anche
       stilizzarlo. */
    var faqTrig=_toggleFaq(e.target);
    if(faqTrig){
      e.preventDefault();e.stopPropagation();
      selectEl(faqTrig);
      return;
    }
    e.preventDefault();e.stopPropagation();
    var el=e.target;if(sk(el))return;
    selectEl(el);
  },true);

  document.addEventListener('dblclick',function(e){
    e.preventDefault();e.stopPropagation();
    var el=e.target;if(sk(el))return;
    if(editing&&editEl)finishEdit();
    editing=true;editEl=el;sel=el;
    el.contentEditable='true';el.style.outline=ES;el.style.outlineOffset='2px';
    el.focus();
    var range=document.createRange();range.selectNodeContents(el);
    var s=window.getSelection();s.removeAllRanges();s.addRange(range);
    window.parent.postMessage({type:'editing-started',data:gi(el)},'*');
  },true);

  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'){if(editing)finishEdit();else if(sel){co(sel);sel=null;window.parent.postMessage({type:'element-deselected'},'*');}}
    if(editing&&e.key==='Enter'&&!e.shiftKey){
      var t=editEl&&editEl.tagName&&editEl.tagName.toLowerCase();
      if(t&&['h1','h2','h3','h4','h5','h6','span','a','button','li','label'].indexOf(t)>=0){e.preventDefault();finishEdit();}
    }
  });

  document.addEventListener('submit',function(e){e.preventDefault();},true);

  window.addEventListener('message',function(e){
    if(!e.data||!e.data.type)return;var m=e.data;
    switch(m.type){
      case 'cmd-exec':{
        // Formattazione robusta. Cliccando un pulsante della toolbar (che vive
        // nel parent) l'iframe perde il focus e la selezione collassa, quindi
        // document.execCommand non aveva nulla su cui agire ("a volte non fa il
        // grassetto"). Qui: 1) prendiamo come target l'elemento in editing o,
        // se non si sta editando, quello semplicemente selezionato; 2) lo
        // rendiamo editabile e gli ridiamo il focus; 3) se la selezione non è
        // più dentro al target, selezioniamo tutto il suo contenuto. Così
        // bold/italic/underline/heading/align si applicano sempre.
        var __ce=(editing&&editEl)?editEl:sel;
        if(__ce){
          var __wasEditing=!!(editing&&editEl&&editEl===__ce);
          var __prevCE=__ce.getAttribute('contenteditable');
          if(!__wasEditing){try{__ce.contentEditable='true';}catch(_e){}}
          try{__ce.focus();}catch(_e2){}
          var __s=window.getSelection?window.getSelection():null;
          if(__s&&(!__s.rangeCount||__s.isCollapsed||(__s.anchorNode&&!__ce.contains(__s.anchorNode)))){
            try{var __r=document.createRange();__r.selectNodeContents(__ce);__s.removeAllRanges();__s.addRange(__r);}catch(_e3){}
          }
          document.execCommand(m.command,false,m.value||null);
          if(!__wasEditing){
            if(__prevCE===null)__ce.removeAttribute('contenteditable');else __ce.contentEditable=__prevCE;
          }
        }else{
          document.execCommand(m.command,false,m.value||null);
        }
        sendHtml();
        if(sel)window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');
        break;
      }
      case 'cmd-set-style':if(sel){
        var _csKebab=String(m.property||'').replace(/[A-Z]/g,function(c){return '-'+c.toLowerCase();});
        if(_csKebab){
          if(m.value===''||m.value==null){sel.style.removeProperty(_csKebab);}
          else{sel.style.setProperty(_csKebab,m.value,'important');}
        }
        sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-remove-attr':if(sel){sel.removeAttribute(m.name);sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-set-attr':if(sel){sel.setAttribute(m.name,m.value);
        /* Quando cambiamo l'immagine (src), eliminiamo TUTTI gli attributi
           lazy-load (data-src, data-original, srcset, data-srcset, ...).
           Altrimenti prepareEditorHtml alla RIAPERTURA ripromuove quei
           valori VECCHI dentro src e l'immagine torna a quella di prima. */
        if(m.name==='src'){var _LZA=['srcset','data-src','data-original','data-original-src','data-orig-src','data-lazy-src','data-lazy','data-lazyload','data-lazy-load','data-url','data-image-src','data-image','data-thumb','data-cfsrc','data-cmplz-src','data-wf-src','data-echo','data-defer-src','data-hi-res-src','data-actual','data-srcfallback','data-srcset','data-lazy-srcset','data-cfsrcset','data-cmplz-srcset','data-wf-srcset'];for(var _zz=0;_zz<_LZA.length;_zz++){sel.removeAttribute(_LZA[_zz]);}fitMedia(sel);}
        sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-set-shape':if(sel){
        /* Trova i target: se sel e' un <img> agiamo su quello; altrimenti
           cerchiamo le <img> nel blocco (scope='all' -> tutte; 'main' ->
           solo la piu' grande, coerente con childImg). Se non ci sono <img>
           trattiamo sel come elemento con background-image. */
        var _shp=m.shape;var _scope=m.scope||'main';var _tgts=[];var _asBg=false;
        var _stag=(sel.tagName||'').toLowerCase();
        if(_stag==='img'){_tgts=[sel];}
        else{
          var _sscope=(typeof carScope==='function'&&carScope(sel))||sel;
          var _simgs=_sscope.querySelectorAll('img');
          if(_simgs.length){
            if(_scope==='all'){for(var _si=0;_si<_simgs.length;_si++)_tgts.push(_simgs[_si]);}
            else{var _sba=0,_sbest=null;for(var _sj=0;_sj<_simgs.length;_sj++){var _sr=_simgs[_sj].getBoundingClientRect();var _sa=_sr.width*_sr.height;if(_sa>=_sba){_sba=_sa;_sbest=_simgs[_sj];}}if(_sbest)_tgts=[_sbest];}
          }
        }
        if(!_tgts.length){_tgts=[sel];_asBg=true;}
        var _applyShape=function(elx,asBg){
          elx.style.removeProperty('border-radius');
          elx.style.removeProperty('aspect-ratio');
          if(!asBg)elx.style.removeProperty('object-fit');
          if(_shp==='rect'){elx.style.setProperty('border-radius','0','important');}
          else if(_shp==='rounded'){elx.style.setProperty('border-radius','16px','important');}
          else if(_shp==='pill'){elx.style.setProperty('border-radius','9999px','important');}
          else if(_shp==='circle'||_shp==='square'){
            elx.style.setProperty('border-radius',_shp==='circle'?'50%':'0','important');
            elx.style.setProperty('aspect-ratio','1 / 1','important');
            if(asBg){elx.style.setProperty('background-size','cover','important');elx.style.setProperty('background-position','center','important');}
            else{elx.style.setProperty('object-fit','cover','important');}
          }
          if(asBg){elx.style.setProperty('overflow','hidden','important');}
        };
        for(var _ti2=0;_ti2<_tgts.length;_ti2++)_applyShape(_tgts[_ti2],_asBg);
        sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-set-child-img-src':if(sel){var _ci=null;try{
        /* Stessa euristica di gi().childImg: prendiamo l'<img> PIU' GRANDE
           del blocco, cosi' sostituiamo l'immagine principale (hero) e non
           la prima icona dei bullet. */
        var _cim=sel.querySelectorAll('img');var _cba=-1;
        for(var _ck=0;_ck<_cim.length;_ck++){var _cr=_cim[_ck].getBoundingClientRect();var _ca=_cr.width*_cr.height;if(_ca>_cba){_cba=_ca;_ci=_cim[_ck];}}
        if(!_ci)_ci=sel.querySelector('img');
      }catch(e){}
        if(_ci){_ci.setAttribute('src',m.value);
        /* Vedi cmd-set-attr: togliamo TUTTI gli attributi lazy così la
           promozione alla riapertura non ripristina l'immagine vecchia. */
        var _LZB=['srcset','data-src','data-original','data-original-src','data-orig-src','data-lazy-src','data-lazy','data-lazyload','data-lazy-load','data-url','data-image-src','data-image','data-thumb','data-cfsrc','data-cmplz-src','data-wf-src','data-echo','data-defer-src','data-hi-res-src','data-actual','data-srcfallback','data-srcset','data-lazy-srcset','data-cfsrcset','data-cmplz-srcset','data-wf-srcset'];for(var _zb=0;_zb<_LZB.length;_zb++){_ci.removeAttribute(_LZB[_zb]);}fitMedia(_ci);
        sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}}break;
      case 'cmd-set-child-img-src-at':if(sel){var _scp=carScope(sel)||sel;var _ima=_scp.querySelectorAll('img');var _ti=_ima[m.index];
        if(_ti){_ti.setAttribute('src',m.value);
        var _LZD=['srcset','data-src','data-original','data-original-src','data-orig-src','data-lazy-src','data-lazy','data-lazyload','data-lazy-load','data-url','data-image-src','data-image','data-thumb','data-cfsrc','data-cmplz-src','data-wf-src','data-echo','data-defer-src','data-hi-res-src','data-actual','data-srcfallback','data-srcset','data-lazy-srcset','data-cfsrcset','data-cmplz-srcset','data-wf-srcset'];for(var _zd=0;_zd<_LZD.length;_zd++){_ti.removeAttribute(_LZD[_zd]);}fitMedia(_ti);
        sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}}break;
      case 'cmd-set-child-bg-image':if(sel){
        /* Trova l'elemento (self o discendente) con l'area piu' grande che
           ha un background-image url(...) — stessa euristica di gi().childBg
           — e gli imposta la nuova immagine di sfondo. */
        var _bgEl=null,_bba=-1;try{
          var _bc=[sel].concat(Array.prototype.slice.call(sel.querySelectorAll('*')));
          for(var _bi=0;_bi<_bc.length;_bi++){var _bs='';try{_bs=getComputedStyle(_bc[_bi]).backgroundImage||'';}catch(e){continue;}
            if(!_bs||_bs==='none'||_bs.indexOf('url(')<0)continue;
            var _bm=_bs.match(/url[(]['"]?([^'")]*)['"]?[)]/i);if(!_bm||!_bm[1])continue;
            if(_bm[1].indexOf('data:image/svg')===0)continue;
            var _br=_bc[_bi].getBoundingClientRect();var _bar=_br.width*_br.height;
            if(_bar>_bba){_bba=_bar;_bgEl=_bc[_bi];}}
        }catch(e){}
        if(_bgEl){_bgEl.style.setProperty('background-image','url("'+m.value+'")','important');
          /* assicura che lo sfondo sia visibile (alcune sezioni hanno
             background-size:0 o image:none inline che vince) */
          if(!_bgEl.style.backgroundSize)_bgEl.style.backgroundSize='cover';
          if(!_bgEl.style.backgroundPosition)_bgEl.style.backgroundPosition='center';
          sendHtml();
          window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}}break;
      case 'cmd-set-text':if(sel){sel.textContent=m.value;sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-set-inner-html':if(sel){sel.innerHTML=m.value;sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-delete':if(sel){sel.remove();sel=null;sendHtml();
        plusBtn.style.display='none';hideDel();hideResize();
        window.parent.postMessage({type:'element-deselected'},'*');}break;
      case 'cmd-duplicate':if(sel&&sel.parentElement){
        var cl=sel.cloneNode(true);sel.parentElement.insertBefore(cl,sel.nextSibling);
        co(sel);sel=cl;sel.style.outline=SS;sel.style.outlineOffset='2px';sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-move-up':if(sel&&sel.previousElementSibling){
        sel.parentElement.insertBefore(sel,sel.previousElementSibling);sendHtml();}break;
      case 'cmd-move-down':if(sel&&sel.nextElementSibling){
        sel.parentElement.insertBefore(sel.nextElementSibling,sel);sendHtml();}break;
      case 'cmd-get-html':
        if(sel)co(sel);if(editEl){editEl.contentEditable='false';co(editEl);}
        var ch='<!DOCTYPE html>'+document.documentElement.outerHTML;
        if(sel){sel.style.outline=SS;sel.style.outlineOffset='2px';}
        window.parent.postMessage({type:'clean-html',data:ch},'*');break;
      case 'cmd-flush-html':
        // Forza l'invio sincrono dell'HTML correntemente nell'iframe,
        // bypassando il debounce di sendHtml. Usato da handleSave per non
        // perdere le ultime mutazioni in coda.
        sendHtmlNow();break;
      case 'cmd-deselect':if(editing)finishEdit();if(sel)co(sel);sel=null;hover=null;
        plusBtn.style.display='none';hideDel();hideResize();
        window.parent.postMessage({type:'element-deselected'},'*');break;
      case 'cmd-select-path':try{var found=document.querySelector(m.path);
        if(found){if(sel)co(sel);sel=found;found.style.outline=SS;found.style.outlineOffset='2px';
        found.scrollIntoView({behavior:'smooth',block:'center'});
        window.parent.postMessage({type:'element-selected',data:gi(found)},'*');}}catch(x){}break;
      case 'cmd-get-context-text':
        if(sel){
          var ctx='';
          var par=sel.parentElement||document.body;
          var sibs=par.children;
          for(var ci=0;ci<sibs.length;ci++){
            var sib=sibs[ci];if(sib===sel||sib===plusBtn||sib===delBtn)continue;
            var st=(sib.textContent||'').trim();if(st.length>5)ctx+=st.substring(0,300)+' ';
          }
          if(!ctx.trim()){var gpar=par.parentElement;if(gpar){
            var gs=gpar.children;for(var gi2=0;gi2<gs.length;gi2++){
              var gsib=gs[gi2];if(gsib===par||gsib===plusBtn||gsib===delBtn)continue;
              var gst=(gsib.textContent||'').trim();if(gst.length>5)ctx+=gst.substring(0,300)+' ';
            }
          }}
          window.parent.postMessage({type:'context-text',data:ctx.trim().substring(0,800)},'*');
        }break;
      case 'cmd-get-swipe-context':
        /* Contesto strutturato attorno al media selezionato:
           - heading più vicino (h1/h2/h3 SOPRA l'elemento, escludendo i navi)
           - testo della sezione parent (paragrafi)
           - prima CTA della stessa sezione (button o link "compra/order/get")
           - posizione approssimativa nella pagina (above/mid/below) */
        if(sel){
          var swH='',swT='',swC='',swPos='mid';
          /* Heading più vicino — risali fino alla section/article/main e cerca h1-h3 */
          var sec=sel;var hops=0;
          while(sec&&hops<6&&!/^(section|article|main|header|footer)$/i.test(sec.tagName||'')){sec=sec.parentElement;hops++;}
          if(!sec)sec=sel.parentElement||document.body;
          var hCand=sec.querySelectorAll&&sec.querySelectorAll('h1,h2,h3');
          if(hCand&&hCand.length>0){
            for(var hi=0;hi<hCand.length;hi++){
              var ht=(hCand[hi].textContent||'').trim();
              if(ht.length>3&&ht.length<200){swH=ht;break;}
            }
          }
          /* Paragrafi della sezione (escluso il testo dei figli del selezionato) */
          var pCand=sec.querySelectorAll&&sec.querySelectorAll('p,li,blockquote');
          var pBuf=[];
          if(pCand){
            for(var pi=0;pi<pCand.length&&pBuf.length<3;pi++){
              if(sel.contains(pCand[pi]))continue;
              var pt=(pCand[pi].textContent||'').trim();
              if(pt.length>15)pBuf.push(pt.substring(0,250));
            }
          }
          swT=pBuf.join(' • ');
          /* CTA — primo button/link della section con testo tipico CTA */
          var btnCand=sec.querySelectorAll&&sec.querySelectorAll('a,button');
          if(btnCand){
            for(var bi=0;bi<btnCand.length;bi++){
              var bt=(btnCand[bi].textContent||'').trim();
              if(bt.length>2&&bt.length<80&&/buy|order|get|claim|start|begin|try|shop|add|join|continue|next|sign|purchase|compra|ordina|inizia/i.test(bt)){
                swC=bt;break;
              }
            }
          }
          /* Posizione: above-fold se y < viewportHeight, below-fold se > 2*viewportHeight */
          try{
            var rr=sel.getBoundingClientRect();
            var sy=window.scrollY||document.documentElement.scrollTop||0;
            var top=rr.top+sy;
            var vh=window.innerHeight||720;
            if(top<vh*0.9)swPos='above-fold';
            else if(top>vh*2)swPos='below-fold';
            else swPos='mid';
          }catch(_e){}
          window.parent.postMessage({type:'swipe-context',data:{heading:swH.substring(0,200),nearbyText:swT.substring(0,800),cta:swC.substring(0,80),position:swPos}},'*');
        }break;
      case 'cmd-get-sections':
        var b=document.body,secs=[];
        for(var i=0;i<b.children.length;i++){var c=b.children[i];var tg=c.tagName.toLowerCase();
          if(['style','script','link','meta','noscript'].indexOf(tg)>=0)continue;
          secs.push({index:i,tagName:tg,id:c.id||'',
            className:typeof c.className==='string'?c.className.substring(0,100):'',
            textPreview:(c.textContent||'').substring(0,80).trim(),path:gp(c)});}
        window.parent.postMessage({type:'sections-list',data:secs},'*');break;
      case 'cmd-get-selected-full-html':
        if(sel){
          var savedO=sel.style.outline,savedOO=sel.style.outlineOffset;
          sel.style.outline='';sel.style.outlineOffset='';
          var fullOuter=sel.outerHTML;
          sel.style.outline=savedO;sel.style.outlineOffset=savedOO;
          window.parent.postMessage({type:'selected-full-html',data:fullOuter},'*');
        }break;
      case 'cmd-get-element-html-for-ai':
        if(sel){
          var sO2=sel.style.outline,sOO2=sel.style.outlineOffset;
          sel.style.outline='';sel.style.outlineOffset='';
          var fh=sel.outerHTML;
          sel.style.outline=sO2;sel.style.outlineOffset=sOO2;
          window.parent.postMessage({type:'element-html-for-ai',data:fh},'*');
        }break;
      case 'cmd-replace-outer-html':
        if(sel&&m.html){
          var p=sel.parentElement;
          if(p){
            var w=document.createElement('div');w.innerHTML=m.html;
            var ne=w.firstElementChild;
            if(ne){p.replaceChild(ne,sel);sel=ne;sel.style.outline=SS;sel.style.outlineOffset='2px';sendHtml();
              window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}
          }
        }break;
      case 'cmd-convert-iframe-to-video':
        // Sostituisce un <iframe> embed (YouTube/Vimeo) con un <video> nativo.
        // Se m.src e' fornito, lo imposta direttamente sul <video> (caso
        // upload-first dalla sidebar: video pronto a partire). Altrimenti
        // crea un placeholder vuoto col poster che invita all'upload.
        // Gestisce il wrapper 16:9 (position:relative; padding-bottom:56.25%;
        // height:0): senza rimuoverlo il <video> sarebbe invisibile.
        if(sel && sel.tagName==='IFRAME'){
          var civ_target=sel;
          var civ_p=sel.parentElement;
          if(civ_p){
            var civ_pb=(civ_p.style.paddingBottom||'').trim();
            var civ_pos=(civ_p.style.position||'').trim();
            var civ_h=(civ_p.style.height||'').trim();
            if(civ_pos==='relative' && /\d+(\.\d+)?\s*%/.test(civ_pb) && (civ_h==='0'||civ_h==='0px'||civ_h==='')){
              civ_target=civ_p;
            }
          }
          var civ_src=m.src||'';
          var civ_srcAttr=civ_src?' src="'+civ_src.replace(/"/g,'&quot;')+'"':'';
          var civ_poster=civ_src?'':' poster="https://placehold.co/1280x720/0f172a/94a3b8?text=Click+the+video%2C+then+%22Upload+Video%22+in+the+sidebar"';
          var civ_html='<video controls preload="metadata" playsinline'+civ_srcAttr+civ_poster+' style="width:100%;max-width:800px;aspect-ratio:16/9;border-radius:8px;background:#000;display:block;margin:0 auto;cursor:pointer"></video>';
          var civ_w=document.createElement('div');civ_w.innerHTML=civ_html;
          var civ_ne=civ_w.firstElementChild;
          if(civ_ne && civ_target.parentElement){
            civ_target.parentElement.replaceChild(civ_ne,civ_target);
            sel=civ_ne;sel.style.outline=SS;sel.style.outlineOffset='2px';sendHtml();
            window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');
          }
        }break;
      case 'cmd-insert-section':
        if(m.html){
          var tmp=document.createElement('div');tmp.innerHTML=m.html;
          var nodes=Array.from(tmp.children);
          var target=sel||document.body.lastElementChild;
          if(target&&target.parentElement){
            nodes.forEach(function(n){target.parentElement.insertBefore(n,target.nextSibling);});
          }else{
            nodes.forEach(function(n){document.body.appendChild(n);});
          }
          sendHtml();
          window.parent.postMessage({type:'section-inserted',data:true},'*');
        }break;
      case 'cmd-insert-after-selected':
        if(m.html){
          var ia_tmp=document.createElement('div');ia_tmp.innerHTML=m.html;
          var ia_nodes=Array.from(ia_tmp.children);
          var ia_target=insertTarget||sel||document.body.lastElementChild;
          if(ia_target&&ia_target.parentElement){
            var ia_ref=ia_target.nextSibling;
            for(var ii=0;ii<ia_nodes.length;ii++){ia_target.parentElement.insertBefore(ia_nodes[ii],ia_ref);}
            if(ia_nodes.length>0){if(sel)co(sel);sel=ia_nodes[0];sel.style.outline=SS;sel.style.outlineOffset='2px';positionPlus();}
          }else{
            for(var ii2=0;ii2<ia_nodes.length;ii2++){document.body.appendChild(ia_nodes[ii2]);}
          }
          insertTarget=null;
          sendHtml();
          window.parent.postMessage({type:'section-inserted',data:true},'*');
        }break;
    }
  });

  // Remove transparent overlay divs that block click on images
  document.querySelectorAll('div,span').forEach(function(el){
    var cs=getComputedStyle(el);
    if(cs.position==='absolute'||cs.position==='fixed'){
      var bg=cs.backgroundColor;var op=parseFloat(cs.opacity);
      if((bg==='transparent'||bg==='rgba(0, 0, 0, 0)'||op===0)&&el.children.length===0&&(el.textContent||'').trim()===''){
        el.style.pointerEvents='none';
      }
    }
  });

  // Disable pointer-events on iframes/embeds so clicks hit parent containers
  document.querySelectorAll('iframe,object,embed').forEach(function(el){
    el.style.pointerEvents='none';
    el.style.userSelect='none';
  });

  /* CHIUDI TUTTI I <details> ALL'AVVIO. Alcune landing (FunnelKit,
     Rosabella) spediscono <details open onclick="return false"> per
     ogni FAQ: il loro runtime JS poi le chiude e gestisce il toggle
     via attributo 'open'. Noi abbiamo strippato/non-eseguito quel
     runtime (l'iframe e' srcDoc, window.location.href = about:srcdoc,
     il loader di /index.js fallisce). Risultato senza fix: tutte le
     FAQ aperte e il primo click le chiude. Removendo 'open' iniziale
     allineamo lo stato di partenza al comportamento atteso. */
  try{
    document.querySelectorAll('details').forEach(function(d){
      d.removeAttribute('open');
      var wDO=d.closest&&d.closest('[data-open]');
      if(wDO)wDO.setAttribute('data-open','false');
    });
  }catch(e){}

  /* Inizializza i carousel ORA + retry differiti: alcune landing
     popolano dinamicamente le slide via inline-script (rimosso) o
     via lazy-loader; un secondo init a 400/1200ms cattura anche
     quei casi. _bindCarousel e' idempotente (guard track.__wbCar). */
  _initCarousels();
  setTimeout(_initCarousels,400);
  setTimeout(_initCarousels,1200);

  window.parent.postMessage({type:'editor-ready'},'*');
})();
`;

/* ─────────── Helpers ─────────── */

function prepareEditorHtml(html: string, sourceUrl?: string): string {
  let clean = html;
  clean = clean.replace(/<meta[^>]*content-security-policy[^>]*>/gi, '');
  clean = clean.replace(/loading=["']lazy["']/gi, 'loading="eager"');

  // ── BASE HREF: garantisce che le URL RELATIVE nell'HTML clonato
  // si risolvano contro l'origin del sito sorgente, non contro
  // about:srcdoc (= broken) o contro il dominio del nostro editor
  // (= 404 perché le immagini non esistono lì).
  //
  // Senza questa fix: `<img src="/brain_waves.png">` nell'HTML clonato
  // → iframe srcdoc cerca about:srcdoc/brain_waves.png oppure
  // cute-cupcake-74bad8.netlify.app/brain_waves.png → 404 → broken icon.
  //
  // Lo applichiamo SOLO se `<base href>` non c'è gia' (stabilizeClonedHtml
  // lo inietta di solito ma cloni vecchi o swipe-generated potrebbero
  // non averlo).
  if (sourceUrl) {
    try {
      const sourceOrigin = new URL(sourceUrl).origin;
      const baseHrefVal = sourceOrigin + '/';
      const hasBase = /<base\b[^>]*\bhref\s*=/i.test(clean);
      if (!hasBase) {
        const baseTag = `<base href="${baseHrefVal}">`;
        if (/<head\b[^>]*>/i.test(clean)) {
          clean = clean.replace(/<head\b([^>]*)>/i, `<head$1>${baseTag}`);
        } else if (/<html\b[^>]*>/i.test(clean)) {
          clean = clean.replace(/<html\b([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
        } else {
          clean = `<head>${baseTag}</head>${clean}`;
        }
      }

      // RIPARA URL ASSOLUTE puntate per errore al dominio del nostro editor
      // (es. https://cute-cupcake-74bad8.netlify.app/brain_waves.png) →
      // rewrite all'origin sorgente. Capita quando la pipeline di clone
      // più vecchia non assolutizzava le URL relative e il save successivo
      // ha "congelato" la risoluzione contro window.location.origin.
      if (typeof window !== 'undefined') {
        const editorOrigin = window.location.origin;
        if (editorOrigin && editorOrigin !== sourceOrigin) {
          const escaped = editorOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const reAttr = new RegExp(`(["'(])${escaped}(?=\\/|["'\\s)])`, 'gi');
          clean = clean.replace(reAttr, `$1${sourceOrigin}`);
        }
      }

      // ASSOLUTIZZA URL ROOT-RELATIVE (es. src="/brain_waves.png",
      // src="/brain_activation.mp4", url(/img/foo.png)). Iframe srcdoc
      // ha origin null e anche con <base href> certi browser hanno
      // comportamenti inconsistenti — assolutizzare nell'HTML stesso è
      // l'unico modo deterministico per fare sempre risolvere queste
      // URL contro l'origin sorgente.
      //
      // Coperto: src= / href= / poster= / action= / data-src / data-poster /
      // data-original / data-bg* / data-image* / srcset / data-srcset /
      // url(...) dentro <style> e inline style.
      const SINGLE_URL_ATTRS =
        '(?:src|href|poster|action|formaction|data-src|data-poster|data-original|data-original-src|data-orig-src|data-image|data-image-src|data-thumb|data-bg|data-background|data-background-image|data-bg-src|data-lazy-bg|data-cfsrc|data-cmplz-src|data-wf-src|data-echo|data-defer-src|data-hi-res-src|data-actual|data-lazy|data-lazy-src|data-lazyload|data-lazy-load|data-url)';
      const SRCSET_ATTRS =
        '(?:srcset|data-srcset|data-lazy-srcset|data-cfsrcset|data-cmplz-srcset|data-wf-srcset|data-bgset)';

      // 1) Single-URL attributes
      const singleRe = new RegExp(
        `\\s(${SINGLE_URL_ATTRS})\\s*=\\s*(["'])(\\/[^"'/][^"']*)\\2`,
        'gi',
      );
      clean = clean.replace(singleRe, (_full, attr, q, val) => {
        return ` ${attr}=${q}${sourceOrigin}${val}${q}`;
      });

      // 2) srcset: ogni token può iniziare con /
      const srcsetRe = new RegExp(
        `\\s(${SRCSET_ATTRS})\\s*=\\s*(["'])([^"']+)\\2`,
        'gi',
      );
      clean = clean.replace(srcsetRe, (_full, attr, q, val) => {
        const fixed = val.split(',').map((part: string) => {
          const trimmed = part.trim();
          if (!trimmed) return part;
          const parts = trimmed.split(/\s+/);
          const url = parts[0];
          const rest = parts.slice(1);
          if (url.startsWith('/') && !url.startsWith('//')) {
            return [sourceOrigin + url, ...rest].join(' ');
          }
          return part;
        }).join(', ');
        return ` ${attr}=${q}${fixed}${q}`;
      });

      // 3) url(...) dentro <style> blocks e inline style=""
      // Catch url(/foo.png), url('/foo.png'), url("/foo.png")
      const urlInStyleRe = /url\(\s*(['"]?)(\/[^)'"\s][^)'"]*)\1\s*\)/g;
      clean = clean.replace(urlInStyleRe, (_full, q, val) => {
        return `url(${q}${sourceOrigin}${val}${q})`;
      });
    } catch { /* sourceUrl invalido — skip */ }
  }
  // ── BLOCCA SOLO I 404-RETRY-LOOP CHECKOUTCHAMP, NON LE IMMAGINI ────
  // Il problema originale era: alcuni script Taboola/CKC polling fanno
  // fetch/XHR a checkoutchamp.com in loop infinito se rispondono 404 →
  // console flood + memory leak.
  //
  // ⚠️ FIX storico SBAGLIATO: sostituiva TUTTE le src= di img/video con
  //    una GIF trasparente, "rompendo" tutte le foto prodotto, stelline
  //    recensioni, badge garanzia, tick verdi ecc. che vengono caricate
  //    legittimamente dal CDN CKC (es. Nooro Metabolic Wave usa
  //    assets.checkoutchamp.com/.../stars.png, greentick.png, prodotto
  //    1.webp). Risultato: editor mostrava una landing "vuota".
  //
  // Ora interveniamo SOLO a livello di fetch/XHR (i veri responsabili
  // dei loop) e installiamo un onerror listener che nasconde
  // silenziosamente eventuali immagini che davvero falliscono.
  // Le src/href/srcset/url() restano intatte → tutte le immagini
  // del CDN che funzionano vengono mostrate normalmente.
  {
    const CKC_RX = /(?:assets|cdn|images?|api)\.checkoutchamp\.com/i;
    if (CKC_RX.test(clean)) {
      const noRetryGuard = `<script data-editor-ckc-noretry>(function(){try{
        document.addEventListener('error', function(ev){var t=ev.target; if(!t)return;
          if(t.tagName==='IMG'||t.tagName==='SOURCE'||t.tagName==='VIDEO'){t.onerror=null; t.style.visibility='hidden';}
        }, true);
        var BLOCK_RX=/(?:api)\\.checkoutchamp\\.com/i; // SOLO api.*, non assets/cdn/images
        var origFetch=window.fetch;
        if(typeof origFetch==='function'){window.fetch=function(u){var url=(typeof u==='string')?u:(u&&u.url)||'';
          if(BLOCK_RX.test(url))return Promise.resolve(new Response('',{status:204}));
          return origFetch.apply(this,arguments);};}
        var OrigXHR=window.XMLHttpRequest;
        if(OrigXHR&&OrigXHR.prototype&&OrigXHR.prototype.open){var origOpen=OrigXHR.prototype.open;
          OrigXHR.prototype.open=function(method,url){this.__ckcBlocked=(typeof url==='string'&&BLOCK_RX.test(url));return origOpen.apply(this,arguments);};
          var origSend=OrigXHR.prototype.send;
          OrigXHR.prototype.send=function(){if(this.__ckcBlocked){try{this.abort();}catch(_){}return;}return origSend.apply(this,arguments);};}
      }catch(_){}})();</` + `script>`;
      if (clean.includes('<head>')) clean = clean.replace('<head>', '<head>' + noRetryGuard);
      else clean = noRetryGuard + clean;
    }
  }
  // Strip server/client fallback init che installano click-delegate FAQ/Swiper
  // e un HUD: dentro l'editor visuale rubano i click di selezione.
  clean = clean.replace(/<script\b[^>]*data-fallback=[^>]*>[\s\S]*?<\/script>/gi, '');
  clean = clean.replace(/<style\b[^>]*data-fallback=[^>]*>[\s\S]*?<\/style>/gi, '');
  // ── STRIP SELETTIVO DEGLI SCRIPT DELLA PAGINA ────────────────────
  // In modalita' EDITOR l'utente sta modificando copy/stili. Strippiamo
  // analytics/popup/sticky/A-B test/tracking/retargeting/etc. perche':
  //   - intercettano i click con stopPropagation/preventDefault e
  //     impediscono al nostro click-delegate selectEl() di vedere il
  //     target -> "clicco e non si seleziona niente"
  //   - aprono popup/modal che coprono la pagina
  //   - rilanciano fetch a CDN morti -> errori in console
  //   - in alcuni casi sostituiscono il body via JS riscrivendo la
  //     pagina e cancellando il nostro EDITOR_SCRIPT al volo
  //
  // MA manteniamo le librerie di CAROUSEL/SLIDER (Swiper, Slick,
  // Flickity, Glide, Splide, OwlCarousel, jQuery dep) + i loro init
  // inline. Solo cosi' un carousel Swiper della pagina (es. Rosabella
  // .mySwiper con autoplay+pagination) si comporta PIXEL-PERFECT
  // identico al sito originale, sia in editor che in preview.
  // (vedi stripNonCarouselScripts in src/lib/spa-rescue.ts)
  clean = stripNonCarouselScripts(clean);
  // Toglie anche noscript: contengono spesso pixel di tracking che
  // diventano visibili se i loro <script> wrapper sono spariti.
  clean = clean.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // NEUTRALIZZA <details onclick="return false" open>. Pattern FunnelKit
  // (Rosabella, ecc.): blocca il toggle nativo per delegarlo al loro
  // runtime JS - che noi non eseguiamo. Rimuoviamo onclick e `open`
  // cosi' il browser fa il toggle nativo perfetto: FAQ chiuse al load,
  // click su summary apre/chiude via shadow DOM nativo, la CSS della
  // pagina basata su details[open] funziona al 100%. Zero JS custom
  // necessario. Stesso approccio del preview (injectInteractivityRescue).
  clean = clean.replace(
    /<details\b([^>]*)>/gi,
    (_full: string, attrs: string) => {
      const out = attrs
        .replace(/\sonclick\s*=\s*(?:"[^"]*return\s+false[^"]*"|'[^']*return\s+false[^']*')/gi, '')
        .replace(/\sopen(?=\s|=|>|$)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
      return `<details${out}>`;
    },
  );

  // ── PROMOZIONE STATICA LAZY-LOAD ────────────────────────────────────
  // Avendo strippato tutti gli script, le librerie lazy-load (LazyLoad.js,
  // lozad, vanilla-lazyload, WP "a3 Lazy Load", Funnelish lazy,
  // Cloudflare Rocket Loader, echo.js, ecc.) non girano piu' e
  // img/video/iframe con `data-src=...` (o varianti) restano vuoti =>
  // l'editor mostra spazi grigi/placeholder SVG al posto di immagini e
  // video. Promuoviamo staticamente i piu' comuni attributi data-* nei
  // loro veri `src`/`srcset`/`poster` cosi' il browser li carica subito,
  // senza bisogno di JS.
  //
  // Coperti: img, source, iframe, video, audio.
  // Pattern lazy-loader supportati: LazyLoad.js, lozad, jQuery.lazy,
  // unveil.js, echo.js, vanilla-lazyload, WP a3-Lazy-Load, Cloudflare
  // Rocket Loader (data-cfsrc), Complianz (data-cmplz-src),
  // Webflow (data-wf-src), Shopify lazysizes (data-orig-src),
  // ed un buon numero di builder custom (data-image-src, data-thumb...).
  {
    const MEDIA_TAG_RE = /<(img|source|iframe|video|audio)\b([^>]*)>/gi;
    const LAZY_SRC_ATTRS = [
      'data-src', 'data-original', 'data-original-src', 'data-orig-src',
      'data-lazy-src', 'data-lazy', 'data-lazyload', 'data-lazy-load',
      'data-url', 'data-image-src', 'data-image', 'data-thumb',
      'data-cfsrc', 'data-cmplz-src', 'data-wf-src', 'data-echo',
      'data-defer-src', 'data-hi-res-src', 'data-actual', 'data-srcfallback',
    ];
    const LAZY_SRCSET_ATTRS = [
      'data-srcset', 'data-lazy-srcset', 'data-cfsrcset',
      'data-cmplz-srcset', 'data-wf-srcset',
    ];
    const LAZY_POSTER_ATTRS = ['data-poster', 'data-lazy-poster', 'data-cfsrc-poster'];
    // src "placeholder" che andrebbero sempre rimpiazzati anche se non
    // c'e' un data-src — sono blur/svg/spacer tipici dei lazy-loader.
    const isPlaceholderSrc = (s: string): boolean => {
      if (!s) return true;
      const v = s.trim().toLowerCase();
      if (v.startsWith('data:image/svg')) return true;
      if (v.startsWith('data:image/gif;base64,r0lgodlh')) return true; // 1x1 transparent gif
      if (/\/(?:placeholder|spacer|blank|pixel|loader|lazyload|lqip)\.(?:gif|png|jpe?g|svg|webp)/i.test(v)) return true;
      return false;
    };
    const pickAttr = (attrs: string, names: string[]): string | null => {
      for (const n of names) {
        // Allow any of: data-src="x" | data-src='x' | data-src=x (no quotes for legacy)
        const re = new RegExp(`\\s${n}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, 'i');
        const m = attrs.match(re);
        if (m) return m[1] || m[2] || m[3] || null;
      }
      return null;
    };
    const setAttr = (attrs: string, name: string, value: string): string => {
      const safe = value.replace(/"/g, '&quot;');
      const re = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
      if (re.test(attrs)) return attrs.replace(re, ` ${name}="${safe}"`);
      return attrs + ` ${name}="${safe}"`;
    };
    const getAttr = (attrs: string, name: string): string | null => {
      const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
      const m = attrs.match(re);
      if (!m) return null;
      return m[1] || m[2] || m[3] || '';
    };
    clean = clean.replace(MEDIA_TAG_RE, (_full, tag, attrs: string) => {
      let a = attrs;
      // Promuoviamo i data-* nel src SOLO se il src attuale manca o è un
      // placeholder. CRITICO: se l'utente ha sostituito l'immagine
      // nell'editor, il src è già quello nuovo (reale) mentre i vecchi
      // data-src/data-original/srcset possono essere rimasti col valore
      // PRECEDENTE. Senza questo controllo la promozione sovrascriverebbe
      // il src nuovo con quello vecchio → l'immagine torna a prima.
      const existingSrc = getAttr(a, 'src');
      const srcIsReal = !!existingSrc && !isPlaceholderSrc(existingSrc);
      const lazySrc = pickAttr(a, LAZY_SRC_ATTRS);
      if (lazySrc && !srcIsReal) a = setAttr(a, 'src', lazySrc);
      const lazySrcset = pickAttr(a, LAZY_SRCSET_ATTRS);
      if (lazySrcset && !srcIsReal) a = setAttr(a, 'srcset', lazySrcset);
      if (tag.toLowerCase() === 'video') {
        const lazyPoster = pickAttr(a, LAZY_POSTER_ATTRS);
        if (lazyPoster) a = setAttr(a, 'poster', lazyPoster);
      }
      // Se il src corrente e' mancante / vuoto / placeholder e c'e' un
      // srcset (o data-srcset) valido, prova a estrarne la prima URL e
      // usala come src. Copre: <img srcset="x.jpg 1x"> senza src, <source
      // data-srcset="..."> dentro <picture>, e img il cui src e' uno
      // spacer/lqip ma srcset ha l'immagine vera.
      const currentSrc = getAttr(a, 'src');
      if (!currentSrc || isPlaceholderSrc(currentSrc)) {
        const srcset = getAttr(a, 'srcset') || pickAttr(a, LAZY_SRCSET_ATTRS);
        if (srcset) {
          const firstUrl = srcset.trim().split(',')[0]?.trim().split(/\s+/)[0];
          if (firstUrl && !isPlaceholderSrc(firstUrl)) {
            a = setAttr(a, 'src', firstUrl);
          }
        }
      }
      return `<${tag}${a}>`;
    });

    // Background images con data-bg / data-background / data-bgset:
    // promuovi a inline style background-image. Se l'elemento ha gia'
    // un background-image inline ma e' un placeholder data: URI o un
    // file palesemente placeholder, sovrascrivi.
    clean = clean.replace(
      /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*\sdata-(?:bg|bgset|background|background-image|bg-src|lazy-bg)\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*)>/g,
      (full, tag, attrs: string, dq, sq) => {
        const rawUrl = (dq || sq || '').trim();
        if (!rawUrl) return full;
        // data-bgset puo' avere piu' URL: prendi la prima.
        const url = rawUrl.split(',')[0]?.trim().split(/\s+/)[0] || rawUrl;
        if (!url || isPlaceholderSrc(url)) return full;
        const styleMatch = attrs.match(/\sstyle\s*=\s*(["'])([^"']*)\1/i);
        const existingBg = styleMatch ? (styleMatch[2].match(/background-image\s*:\s*url\(([^)]+)\)/i)?.[1] || '').replace(/^["']|["']$/g, '') : '';
        if (existingBg && !isPlaceholderSrc(existingBg)) return full;
        const inject = `background-image:url('${url.replace(/'/g, "\\'")}');background-size:cover;background-position:center;`;
        let newAttrs;
        if (styleMatch) {
          // se c'era un background-image placeholder, rimuovilo prima di iniettare quello nuovo
          const cleanedStyle = styleMatch[2].replace(/background-image\s*:[^;]+;?/gi, '');
          newAttrs = attrs.replace(/\sstyle\s*=\s*(["'])([^"']*)\1/i, ` style="${inject}${cleanedStyle}"`);
        } else {
          newAttrs = attrs + ` style="${inject}"`;
        }
        return `<${tag}${newAttrs}>`;
      }
    );
  }
  // Strip <li> vuoti orfani (punti senza testo). Loop finche stabile per
  // gestire bullet annidate e <li> che diventano vuoti dopo aver tolto altri.
  {
    const emptyLiRe = /<li\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?\s*>|<(?:span|i|b|em|strong|small|font|p)\b[^>]*>\s*(?:&nbsp;|&#160;)?\s*<\/(?:span|i|b|em|strong|small|font|p)>)*\s*<\/li>/gi;
    let prev = '';
    let guard = 0;
    while (clean !== prev && guard < 4) {
      prev = clean;
      clean = clean.replace(emptyLiRe, '');
      guard++;
    }
  }
  if (!clean.includes('referrer')) {
    const referrerMeta = '<meta name="referrer" content="no-referrer">';
    if (clean.includes('<head>')) clean = clean.replace('<head>', '<head>' + referrerMeta);
    else if (clean.includes('<head ')) clean = clean.replace(/<head\s/, '<head>' + referrerMeta + '</head><head ');
    else clean = referrerMeta + clean;
  }
  const editorCss = `<style data-editor-override>
    * { pointer-events: auto !important; }
    img, svg, video, canvas, picture { 
      cursor: pointer !important; 
      position: relative; 
      z-index: 1; 
      -webkit-user-drag: none !important; 
      user-select: none !important;
      -webkit-user-select: none !important;
    }
    img[draggable="false"] { -webkit-user-drag: none !important; }
    iframe, object, embed { 
      pointer-events: none !important; 
      user-select: none !important;
    }

    /* FAQ/ACCORDION in editor: lascio lo stato originale della pagina
     * clonata (di norma chiuse). Il delegate _toggleFaq nel script
     * dell'iframe gestisce apri/chiudi al click: setta inline
     * display:block/none con !important sul pannello, vincendo sia
     * sui display:none originali sia su eventuali !important della
     * pagina. Niente force-open. */

    /* ── CAROUSEL: zero overrides per librerie standard ────────
     * Manteniamo gli script di Swiper/Slick/etc. (vedi
     * stripNonCarouselScripts). Le librerie calcolano da sole le
     * larghezze delle slide in base alla loro config (slidesPerView,
     * spaceBetween, breakpoints, etc.). Forzare max-width:100% qui
     * rompeva il calcolo e impilava le slide a tutta larghezza.
     * Risultato: editor e preview hanno carousel PIXEL-PERFECT
     * identico alla pagina originale. */

    /* ── REPLO CAROUSEL FALLBACK (.slider-for > .r-ldsnaw > img) ──
     * Pagine come gethirelief.com usano il pattern Replo dove il
     * layout CSS (dimensioni di .slider-for / .r-ldsnaw / img.r-1lm4acq)
     * e' caricato dinamicamente dal runtime Replo (script esterno che
     * NON possiamo eseguire). Senza quella CSS, lo <img width=""
     * height=""> non ha dimensioni e i contenitori .slider-for /
     * .r-ldsnaw non hanno layout -> immagine carousel invisibile.
     * Diamo layout minimo: img al 100% width, height auto. */
    /* Neutralizza il trucco aspect-ratio di Replo
       (.slider-for{padding-bottom:100%}) che senza il runtime crea
       spazio vuoto enorme sotto la slide. Forza container ad altezza
       naturale della slide corrente. */
    .slider-for { position: relative !important; display: block !important; width: 100% !important; overflow: hidden !important; padding-bottom: 0 !important; height: auto !important; }
    .slider-for > .r-ldsnaw { display: block !important; width: 100% !important; position: relative !important; height: auto !important; }
    /* L'img Replo ha specificita' alta (:not(#\\20):not(#\\20).r-1lm4acq)
       per height:100%;object-fit:cover. Override con !important per
       width:100%/height:auto cosi' aspect ratio naturale. */
    .slider-for img, .slider-for .r-1lm4acq { display: block !important; width: 100% !important; height: auto !important; max-width: 100% !important; max-height: none !important; min-height: 0 !important; object-fit: contain !important; }
    /* Striscia thumbnail orizzontale: Replo CSS fa flex con thumb
       piccole; senza, .r-35xly6 sono block-level (full width) e con la
       regola sopra (img 100% width) diventerebbero 7 immagini giganti
       impilate. Flex horizontal con 80px per thumb + overflow-x scroll. */
    .slider-nav { display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important; gap: 6px; overflow-x: auto; overflow-y: hidden; margin-top: 8px; align-items: stretch; }
    .slider-nav > .r-35xly6 { flex: 0 0 auto; width: 80px; cursor: pointer; display: block; }
    .slider-nav > .r-35xly6 img { display: block; width: 100%; height: auto; max-width: 100%; border-radius: 4px; }

    /* ── FALLBACK PER ICON-FONT MANCANTI (FontAwesome SVG-with-JS) ─
     * Pattern <i class="fas fa-star"></i> renderizzato dal JS di FA.
     * Abbiamo strippato gli script → i container <i> restano vuoti
     * e non si vedono. Inietto pseudo-content con char unicode per
     * le icone piu' usate nelle landing (stelle, check, frecce). Se
     * il font FA e' invece caricato via CSS link tag, l'unicode FA
     * Pro/Free vince comunque, quindi non rompiamo niente. */
    i.fa-star::before, i.fas.fa-star::before, i.far.fa-star::before,
    i.fa.fa-star::before, .fa-solid.fa-star::before, .fa-regular.fa-star::before,
    svg.fa-star, .icon-star::before, [class*="star-icon"]::before {
      content: "★";
      font-family: "FontAwesome", "Font Awesome 6 Free", "Font Awesome 5 Free", Arial, sans-serif;
      font-style: normal;
      color: inherit;
      display: inline-block;
    }
    i.fa-star-half::before, i.fa-star-half-alt::before, i.fa-star-half-stroke::before {
      content: "⯨";
      font-family: "FontAwesome", "Font Awesome 6 Free", Arial, sans-serif;
      font-style: normal;
      display: inline-block;
    }
    i.fa-check::before, i.fas.fa-check::before, .fa-solid.fa-check::before,
    .icon-check::before, [class*="check-icon"]::before {
      content: "✓";
      font-family: "FontAwesome", "Font Awesome 6 Free", Arial, sans-serif;
      font-style: normal;
      display: inline-block;
    }
    i.fa-circle-check::before, i.fa-check-circle::before {
      content: "✔";
      font-family: "FontAwesome", "Font Awesome 6 Free", Arial, sans-serif;
      font-style: normal;
      display: inline-block;
    }
    i.fa-times::before, i.fa-xmark::before, i.fa-close::before {
      content: "✕";
      font-family: "FontAwesome", "Font Awesome 6 Free", Arial, sans-serif;
      font-style: normal;
      display: inline-block;
    }
    i.fa-arrow-right::before, i.fa-chevron-right::before, i.fa-angle-right::before {
      content: "›";
      font-family: "FontAwesome", "Font Awesome 6 Free", Arial, sans-serif;
      font-style: normal;
      display: inline-block;
    }
    i.fa-arrow-left::before, i.fa-chevron-left::before, i.fa-angle-left::before {
      content: "‹";
      font-family: "FontAwesome", "Font Awesome 6 Free", Arial, sans-serif;
      font-style: normal;
      display: inline-block;
    }
    /* Empty <i> containers (FA SVG-with-JS rimuove il content e mette
     * un <svg> al posto del <i> via JS). Se il <i> e' completamente
     * vuoto, gli diamo una dimensione minima e un placeholder square
     * cosi' l'utente vede DOVE sta l'icona e puo' editarla. */
    i.fa:empty, i.fas:empty, i.far:empty, i.fab:empty, i.fal:empty,
    i[class*="fa-"]:empty {
      display: inline-block;
      min-width: 1em;
      min-height: 1em;
    }
  </style>`;
  const script = `<script>${EDITOR_SCRIPT}<\/script>`;
  const inject = editorCss + script;
  if (clean.includes('</body>')) return clean.replace('</body>', `${inject}</body>`);
  if (clean.includes('</html>')) return clean.replace('</html>', `${inject}</html>`);
  return clean + inject;
}

function stripEditorScript(html: string): string {
  let result = html;
  result = result.replace(/<style data-editor-override>[\s\S]*?<\/style>/g, '');
  // Overlay UI dell'editor (plus / cestino / maniglia resize): marcati con
  // data-editor-ui, non devono finire nell'HTML salvato.
  result = result.replace(/<div[^>]*\bdata-editor-ui\b[^>]*>[\s\S]*?<\/div>/gi, '');
  const idx = result.indexOf(EDITOR_SCRIPT.substring(0, 40));
  if (idx === -1) return result;
  const scriptStart = result.lastIndexOf('<script>', idx);
  const scriptEnd = result.indexOf('</script>', idx);
  if (scriptStart !== -1 && scriptEnd !== -1) {
    return result.substring(0, scriptStart) + result.substring(scriptEnd + 9);
  }
  return result;
}

const FONT_SIZES = ['10px','12px','14px','16px','18px','20px','24px','28px','32px','36px','40px','48px','56px','64px','72px'];

const SAVED_SECTIONS_KEY = 'funnel-swiper-saved-sections';

function loadSavedSections(): SavedSection[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(SAVED_SECTIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function persistSavedSections(sections: SavedSection[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SAVED_SECTIONS_KEY, JSON.stringify(sections));
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function rgbToHex(rgb: string): string {
  if (!rgb || rgb === 'transparent' || rgb.startsWith('#')) return rgb || '#000000';
  const match = rgb.match(/\d+/g);
  if (!match || match.length < 3) return '#000000';
  return '#' + match.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
}

// Estrae il numero (px) da un valore di computed style tipo "12px" / "0px" /
// "auto" / "12.5px". Ritorna 0 se non parsabile (margin: auto / em / % ecc.).
function pxToNum(v: string | undefined | null): number {
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/* ── Image data URL extraction (fallback affidabile) ──
 * Scarica l'immagine lato BROWSER (sfrutta il fatto che la pagina di
 * preview l'ha già caricata in cache) e la converte in data URL JPEG.
 * Strategia 1: <img crossOrigin="anonymous"> + canvas.toDataURL.
 *              Funziona se il server abilita CORS per asset statici
 *              (Shopify CDN, Cloudfront, R2, ecc.).
 * Strategia 2 (no-CORS): in molti casi il browser ha l'asset in cache
 *              dal preview iframe; ritentiamo con `cache: 'force-cache'`
 *              come ultimo tentativo.
 *
 * Ritorna data URL JPEG (max 1280px sul lato lungo) o null se entrambi
 * i tentativi falliscono. Hard timeout 8s. */
async function extractImageAsDataUrl(
  imageUrl: string,
  maxDim: number = 1280,
  quality: number = 0.85,
): Promise<string | null> {
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return null;

  /* Strategia 1: Image element + canvas (richiede CORS sul server). */
  const viaCanvas = await new Promise<string | null>((resolve) => {
    let resolved = false;
    const finish = (v: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    const t = window.setTimeout(() => finish(null), 8000);
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) {
          window.clearTimeout(t);
          finish(null);
          return;
        }
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) {
          window.clearTimeout(t);
          finish(null);
          return;
        }
        ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/jpeg', quality);
        window.clearTimeout(t);
        finish(url.startsWith('data:image/') ? url : null);
      } catch {
        /* Canvas tainted (CORS). */
        window.clearTimeout(t);
        finish(null);
      }
    };
    img.onerror = () => {
      window.clearTimeout(t);
      finish(null);
    };
    img.src = imageUrl;
  });
  if (viaCanvas) return viaCanvas;

  /* Strategia 2: fetch con cache forzata (a volte il browser ha già
     il blob in cache dal preview iframe e supera il blocco CORS strict). */
  try {
    const res = await fetch(imageUrl, { cache: 'force-cache' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0 || blob.size > 6 * 1024 * 1024) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const v = typeof reader.result === 'string' ? reader.result : null;
        resolve(v && v.startsWith('data:image/') ? v : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/* ── Multi-frame extraction per video competitor ──
 * Estrae N frame (di default 3: inizio / metà / fine) da un URL video
 * usando un <video> nascosto + canvas. Ritorna data URL JPEG.
 * Se il video è cross-origin senza CORS o non si carica, ritorna [].
 * Hard-timeout di 12s per evitare di bloccare la UI in caso di video
 * gigantesco o server lento. */
async function extractVideoFrames(
  videoUrl: string,
  count: number = 3,
): Promise<string[]> {
  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) return [];
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (arr: string[]) => {
      if (resolved) return;
      resolved = true;
      try {
        video.pause();
      } catch {}
      try {
        video.removeAttribute('src');
        video.load();
      } catch {}
      resolve(arr);
    };

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.style.position = 'fixed';
    video.style.left = '-99999px';
    video.style.top = '-99999px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    const cleanup = () => {
      if (video.parentNode) video.parentNode.removeChild(video);
    };

    const hardTimeout = window.setTimeout(() => {
      cleanup();
      finish([]);
    }, 12000);

    video.addEventListener('error', () => {
      window.clearTimeout(hardTimeout);
      cleanup();
      finish([]);
    });

    video.addEventListener(
      'loadedmetadata',
      async () => {
        try {
          const duration = Number.isFinite(video.duration) ? video.duration : 0;
          if (!(duration > 0)) {
            window.clearTimeout(hardTimeout);
            cleanup();
            finish([]);
            return;
          }
          const w = video.videoWidth || 1280;
          const h = video.videoHeight || 720;
          const canvas = document.createElement('canvas');
          /* Limit canvas size to keep base64 small (Claude 5MB limit). */
          const maxDim = 720;
          const scale = Math.min(1, maxDim / Math.max(w, h));
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx2d = canvas.getContext('2d');
          if (!ctx2d) {
            window.clearTimeout(hardTimeout);
            cleanup();
            finish([]);
            return;
          }

          const timestamps: number[] = [];
          if (count <= 1) {
            timestamps.push(duration / 2);
          } else {
            for (let i = 0; i < count; i++) {
              const t =
                i === 0
                  ? Math.min(0.3, duration * 0.05)
                  : i === count - 1
                    ? Math.max(0, duration - Math.min(0.3, duration * 0.05))
                    : (duration * i) / (count - 1);
              timestamps.push(t);
            }
          }

          const frames: string[] = [];
          for (const ts of timestamps) {
            await new Promise<void>((res) => {
              const onSeeked = () => {
                video.removeEventListener('seeked', onSeeked);
                res();
              };
              video.addEventListener('seeked', onSeeked, { once: true });
              try {
                video.currentTime = ts;
              } catch {
                res();
              }
            });
            try {
              ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
              const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
              if (dataUrl.startsWith('data:image/')) frames.push(dataUrl);
            } catch {
              /* canvas tainted (CORS) — abort, server avrà fallback al poster. */
              window.clearTimeout(hardTimeout);
              cleanup();
              finish([]);
              return;
            }
          }

          window.clearTimeout(hardTimeout);
          cleanup();
          finish(frames);
        } catch {
          window.clearTimeout(hardTimeout);
          cleanup();
          finish([]);
        }
      },
      { once: true },
    );

    try {
      video.src = videoUrl;
      video.load();
    } catch {
      window.clearTimeout(hardTimeout);
      cleanup();
      finish([]);
    }
  });
}

const TAG_LABELS: Record<string, string> = {
  h1: 'Heading H1', h2: 'Heading H2', h3: 'Heading H3', h4: 'Heading H4',
  p: 'Paragraph', span: 'Text', a: 'Link', button: 'Button',
  img: 'Image', div: 'Section', section: 'Section', header: 'Header',
  footer: 'Footer', nav: 'Navigation', ul: 'List', ol: 'Ordered List',
  li: 'List Item', form: 'Form', input: 'Input', textarea: 'Text Area',
  video: 'Video', figure: 'Figure', figcaption: 'Caption', main: 'Main Content',
  article: 'Article', aside: 'Sidebar', blockquote: 'Blockquote',
};

const TEXT_EDITABLE_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'span', 'a', 'button', 'li', 'label',
  'td', 'th', 'figcaption', 'blockquote', 'cite',
  'em', 'strong', 'small', 'b', 'i', 'u', 'mark',
  'del', 'ins', 'dt', 'dd', 'caption', 'summary', 'legend',
]);

/* ─────────── Background gradient parsing + editor ───────────
 *
 * Adds linear/radial gradient support to the per-element Background panel.
 * Backed by `background-image`, so it coexists with the existing solid
 * `background-color` picker right above it: the underlying color is still
 * what you pick in the color input, and any gradient is rendered ON TOP.
 *
 * The editor is fully driven by `el.styles.backgroundImage`: on mount /
 * selection change we re-parse the current value so the controls always
 * reflect what's actually applied (linear angle, two colours, radial
 * shape). Setting Type = "Solid" clears the gradient by writing
 * `background-image: none`. */

interface ParsedLinear { type: 'linear'; angle: number; c1: string; c2: string }
interface ParsedRadial { type: 'radial'; c1: string; c2: string }
type ParsedGradient = ParsedLinear | ParsedRadial;

function splitTopLevel(s: string): string[] {
  // Split CSS comma list but ignore commas inside parens (rgb(), rgba())
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function rgbAnyToHex(input: string): string {
  const s = input.trim();
  if (s.startsWith('#')) {
    return s.length === 4
      ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
      : s.length >= 7
        ? s.slice(0, 7).toLowerCase()
        : s;
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    const h = (n: string) => parseInt(n, 10).toString(16).padStart(2, '0');
    return `#${h(rgb[1])}${h(rgb[2])}${h(rgb[3])}`;
  }
  // unknown (named colour, hsl, …) — leave as-is, picker will fall back
  return s;
}

function parseGradient(bg: string | undefined | null): ParsedGradient | null {
  if (!bg) return null;
  const v = bg.trim();
  if (!v || v === 'none') return null;

  const linear = v.match(/linear-gradient\(\s*([\s\S]+)\)\s*$/i);
  if (linear) {
    const parts = splitTopLevel(linear[1]);
    let angle = 180; // CSS default for "to bottom"
    const colours: string[] = [];
    for (const raw of parts) {
      const t = raw.trim();
      const am = t.match(/^(-?\d+(?:\.\d+)?)deg$/i);
      if (am) {
        angle = Number(am[1]);
        continue;
      }
      if (/^to\s+/i.test(t)) {
        // direction keyword — best-effort fallback to default
        continue;
      }
      // strip any "stop" position suffix ("#fff 50%")
      colours.push(t.replace(/\s+\d+(?:\.\d+)?%?$/, '').trim());
    }
    if (colours.length >= 2) {
      return {
        type: 'linear',
        angle,
        c1: rgbAnyToHex(colours[0]),
        c2: rgbAnyToHex(colours[colours.length - 1]),
      };
    }
    return null;
  }

  const radial = v.match(/radial-gradient\(\s*([\s\S]+)\)\s*$/i);
  if (radial) {
    const parts = splitTopLevel(radial[1]);
    const colours: string[] = [];
    for (const raw of parts) {
      const t = raw.trim();
      if (/^(circle|ellipse)\b/i.test(t) || /^at\s+/i.test(t) || /^(closest|farthest)-(side|corner)/i.test(t)) continue;
      colours.push(t.replace(/\s+\d+(?:\.\d+)?%?$/, '').trim());
    }
    if (colours.length >= 2) {
      return {
        type: 'radial',
        c1: rgbAnyToHex(colours[0]),
        c2: rgbAnyToHex(colours[colours.length - 1]),
      };
    }
    return null;
  }

  return null;
}

function BgGradientEditor({
  bgImage,
  seedColor,
  onChange,
}: {
  bgImage: string | undefined;
  seedColor: string;
  onChange: (nextBgImage: string) => void;
}) {
  // Mode follows whatever the element currently has, but we remember
  // the user's last picked colours/angle while toggling so they don't
  // lose them when temporarily switching to Solid and back.
  const parsed = useMemo(() => parseGradient(bgImage || ''), [bgImage]);
  const initialMode: 'none' | 'linear' | 'radial' = parsed ? parsed.type : 'none';
  const [mode, setMode] = useState<'none' | 'linear' | 'radial'>(initialMode);
  const [angle, setAngle] = useState<number>(parsed?.type === 'linear' ? parsed.angle : 135);
  const [c1, setC1] = useState<string>(parsed?.c1 || seedColor || '#3b82f6');
  const [c2, setC2] = useState<string>(parsed?.c2 || '#a855f7');

  // Re-sync internal state whenever the parent selection changes a
  // different element (bgImage prop swap). Without this, switching
  // between two elements with different gradients would leave stale
  // values in the controls.
  useEffect(() => {
    if (parsed) {
      setMode(parsed.type);
      if (parsed.type === 'linear') setAngle(parsed.angle);
      setC1(parsed.c1);
      setC2(parsed.c2);
    } else {
      setMode('none');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgImage]);

  const emit = (m: typeof mode, a: number, ca: string, cb: string) => {
    if (m === 'none') {
      onChange('none');
    } else if (m === 'linear') {
      onChange(`linear-gradient(${a}deg, ${ca}, ${cb})`);
    } else {
      onChange(`radial-gradient(circle, ${ca}, ${cb})`);
    }
  };

  return (
    <div className="mt-2.5 border-t border-slate-100 pt-2">
      <label className="text-[10px] text-slate-500 mb-1 block">Gradient</label>
      <div className="grid grid-cols-3 gap-1 mb-1.5">
        {([
          { id: 'none', label: 'Solid' },
          { id: 'linear', label: 'Linear' },
          { id: 'radial', label: 'Radial' },
        ] as const).map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`px-1.5 py-1 rounded text-[10px] font-medium border transition-colors ${
              mode === opt.id
                ? 'bg-violet-50 border-violet-300 text-violet-700'
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
            onClick={() => {
              setMode(opt.id);
              emit(opt.id, angle, c1, c2);
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {mode !== 'none' && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={c1}
              className="w-6 h-6 rounded cursor-pointer border border-slate-200"
              onChange={(e) => { setC1(e.target.value); emit(mode, angle, e.target.value, c2); }}
              title="Start color"
            />
            <span className="text-[9px] font-mono text-slate-500 w-12 truncate">{c1}</span>
            <span className="text-[10px] text-slate-400">→</span>
            <input
              type="color"
              value={c2}
              className="w-6 h-6 rounded cursor-pointer border border-slate-200"
              onChange={(e) => { setC2(e.target.value); emit(mode, angle, c1, e.target.value); }}
              title="End color"
            />
            <span className="text-[9px] font-mono text-slate-500 w-12 truncate">{c2}</span>
            <button
              type="button"
              onClick={() => { const a = c2, b = c1; setC1(a); setC2(b); emit(mode, angle, a, b); }}
              className="ml-auto text-[10px] text-slate-400 hover:text-violet-600"
              title="Swap colors"
            >
              ⇄
            </button>
          </div>
          {mode === 'linear' && (
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-slate-500 shrink-0">Angle</label>
              <input
                type="range"
                min={0}
                max={360}
                value={angle}
                className="flex-1 h-1 accent-violet-500"
                onChange={(e) => { const a = Number(e.target.value); setAngle(a); emit(mode, a, c1, c2); }}
              />
              <input
                type="number"
                min={0}
                max={360}
                value={angle}
                className="w-12 px-1 py-0.5 text-[10px] font-mono text-slate-700 border border-slate-200 rounded text-right"
                onChange={(e) => { const a = Math.max(0, Math.min(360, Number(e.target.value) || 0)); setAngle(a); emit(mode, a, c1, c2); }}
              />
              <span className="text-[10px] text-slate-400">°</span>
            </div>
          )}
          <div
            className="h-6 rounded border border-slate-200"
            style={{
              background: mode === 'linear'
                ? `linear-gradient(${angle}deg, ${c1}, ${c2})`
                : `radial-gradient(circle, ${c1}, ${c2})`,
            }}
            title="Preview"
          />
          {/* Preset suggestions: 6 common direction/style combos to
              one-click a sensible gradient without dragging the slider. */}
          <div className="flex flex-wrap gap-1 pt-1">
            {([
              { label: '↘ 135°', kind: 'linear' as const, a: 135 },
              { label: '↓ 180°', kind: 'linear' as const, a: 180 },
              { label: '→ 90°', kind: 'linear' as const, a: 90 },
              { label: '◯ Radial', kind: 'radial' as const, a: 0 },
            ]).map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setMode(p.kind);
                  if (p.kind === 'linear') setAngle(p.a);
                  emit(p.kind, p.a, c1, c2);
                }}
                className="px-1.5 py-0.5 text-[9px] rounded border border-slate-200 bg-white hover:bg-violet-50 hover:border-violet-300 hover:text-violet-700 text-slate-600 transition-colors"
                style={{
                  background: p.kind === 'linear'
                    ? `linear-gradient(${p.a}deg, ${c1}, ${c2})`
                    : `radial-gradient(circle, ${c1}, ${c2})`,
                  color: '#fff',
                  textShadow: '0 1px 2px rgba(0,0,0,.5)',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────── Component ─────────── */

export default function VisualHtmlEditor({ initialHtml, initialMobileHtml, onSave, onSaveToProject, onClose, pageTitle, productContext, sourceUrl, availableProducts, currentProductId, onProductChange }: VisualHtmlEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [mode, setMode] = useState<EditorMode>('visual');
  const [selectedElement, setSelectedElement] = useState<ElementInfo | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [showSections, setShowSections] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [saved, setSaved] = useState(false);

  // UI state per controlli spacing per-lato (sidebar). Quando "linked" e'
  // attivo, modificare un lato applica lo stesso valore a tutti e 4.
  const [paddingLinked, setPaddingLinked] = useState(false);
  const [marginLinked, setMarginLinked] = useState(false);

  const [currentHtml, setCurrentHtml] = useState(initialHtml);
  // Ref sempre aggiornato a currentHtml: usato da handleSave per leggere
  // il valore PIU' recente (anche se appena arrivato da cmd-flush-html)
  // senza dipendere dalla closure del momento in cui handleSave e' definita.
  const currentHtmlRef = useRef(initialHtml);
  currentHtmlRef.current = currentHtml;
  const [codeHtml, setCodeHtml] = useState(initialHtml);
  const undoStack = useRef<string[]>([initialHtml]);
  const redoStack = useRef<string[]>([]);
  const undoIdx = useRef(0);
  const [iframeVersion, setIframeVersion] = useState(0);

  /* ── Mobile viewport ── */
  const [editorViewport, setEditorViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [mobileHtml, setMobileHtml] = useState(initialMobileHtml || '');
  const [mobileCodeHtml, setMobileCodeHtml] = useState(initialMobileHtml || '');

  /* ── Code Search ── */
  const codeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [codeSearchOpen, setCodeSearchOpen] = useState(false);
  const [codeSearchTerm, setCodeSearchTerm] = useState('');
  const [codeSearchIdx, setCodeSearchIdx] = useState(0);
  const [codeSearchCount, setCodeSearchCount] = useState(0);
  const [codeReplaceTerm, setCodeReplaceTerm] = useState('');
  const [codeShowReplace, setCodeShowReplace] = useState(false);
  const hasMobile = !!(initialMobileHtml || mobileHtml);

  const activeCode = editorViewport === 'mobile' && mobileHtml ? mobileCodeHtml : codeHtml;

  const codeSearchNavigate = useCallback((term: string, startIdx: number) => {
    if (!term || !codeTextareaRef.current) { setCodeSearchCount(0); return; }
    const src = activeCode.toLowerCase();
    const needle = term.toLowerCase();
    const indices: number[] = [];
    let pos = 0;
    while ((pos = src.indexOf(needle, pos)) !== -1) { indices.push(pos); pos += needle.length; }
    setCodeSearchCount(indices.length);
    if (indices.length === 0) return;
    const idx = ((startIdx % indices.length) + indices.length) % indices.length;
    setCodeSearchIdx(idx);
    const ta = codeTextareaRef.current;
    ta.focus();
    ta.setSelectionRange(indices[idx], indices[idx] + needle.length);
    const lines = activeCode.substring(0, indices[idx]).split('\n').length;
    const lineHeight = 20;
    ta.scrollTop = Math.max(0, (lines - 5) * lineHeight);
  }, [activeCode]);

  const codeSearchNext = useCallback(() => codeSearchNavigate(codeSearchTerm, codeSearchIdx + 1), [codeSearchNavigate, codeSearchTerm, codeSearchIdx]);
  const codeSearchPrev = useCallback(() => codeSearchNavigate(codeSearchTerm, codeSearchIdx - 1), [codeSearchNavigate, codeSearchTerm, codeSearchIdx]);

  const codeReplaceOne = useCallback(() => {
    if (!codeSearchTerm || codeSearchCount === 0) return;
    const src = activeCode.toLowerCase();
    const needle = codeSearchTerm.toLowerCase();
    const indices: number[] = [];
    let pos = 0;
    while ((pos = src.indexOf(needle, pos)) !== -1) { indices.push(pos); pos += needle.length; }
    if (indices.length === 0) return;
    const idx = ((codeSearchIdx % indices.length) + indices.length) % indices.length;
    const before = activeCode.substring(0, indices[idx]);
    const after = activeCode.substring(indices[idx] + codeSearchTerm.length);
    const newCode = before + codeReplaceTerm + after;
    if (editorViewport === 'mobile' && mobileHtml) { setMobileCodeHtml(newCode); } else { setCodeHtml(newCode); }
    setTimeout(() => codeSearchNavigate(codeSearchTerm, idx), 50);
  }, [codeSearchTerm, codeReplaceTerm, codeSearchCount, codeSearchIdx, activeCode, editorViewport, mobileHtml, codeSearchNavigate]);

  const codeReplaceAll = useCallback(() => {
    if (!codeSearchTerm || codeSearchCount === 0) return;
    const regex = new RegExp(codeSearchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const newCode = activeCode.replace(regex, codeReplaceTerm);
    if (editorViewport === 'mobile' && mobileHtml) { setMobileCodeHtml(newCode); } else { setCodeHtml(newCode); }
    setCodeSearchCount(0);
    setCodeSearchIdx(0);
  }, [codeSearchTerm, codeReplaceTerm, codeSearchCount, activeCode, editorViewport, mobileHtml]);

  /* ── AI Image / Video Generation ── */
  type AiMode = 'text2image' | 'image2image' | 'image2video' | 'text2video';
  const [aiMode, setAiMode] = useState<AiMode>('text2image');
  const [aiModel, setAiModel] = useState<string>('nano-banana-2');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiSize, setAiSize] = useState<'1024x1024' | '1792x1024' | '1024x1792'>('1024x1024');
  const [aiStyle, setAiStyle] = useState<'vivid' | 'natural'>('vivid');
  const [aiSourceImage, setAiSourceImage] = useState<string>('');
  const [aiSourceUploading, setAiSourceUploading] = useState(false);
  /* Seconda immagine per l'edit (image2image): la foto del NOSTRO prodotto
   * da inserire al posto di quello nella sorgente. Passata come
   * secondaryImageUrl ai modelli edit multi-immagine (Nano Banana 2 / GPT). */
  const [aiProductImage, setAiProductImage] = useState<string>('');
  const [aiProductUploading, setAiProductUploading] = useState(false);
  /* Immagini extra per il collage/edit multi-immagine (image2image): l'utente
   * può aggiungerne quante vuole col pulsante "+". Passate come extraImageUrls. */
  const [aiExtraImages, setAiExtraImages] = useState<string[]>([]);
  const [aiExtraUploading, setAiExtraUploading] = useState(false);

  /* ── Prodotto selezionato dentro la modale (My Projects) ──
   * Inizializzato dal productId della pagina; l'utente può cambiarlo dal
   * menu per basare il prompt su un altro prodotto anche se la pagina è
   * solo clonata. `effectiveProduct` è la fonte unica usata da swipe /
   * brand colors / analisi: prima il prodotto scelto dal menu, poi il
   * `productContext` passato dal parent come fallback. */
  const [selectedProductId, setSelectedProductId] = useState<string>(currentProductId || '');
  useEffect(() => {
    setSelectedProductId(currentProductId || '');
  }, [currentProductId]);

  /* Fallback automatico ai projects dello store quando il parent NON
   * passa `availableProducts`. Prima il selettore "Product (My Projects)"
   * usciva SOLO da front-end-funnel (l'unico callsite che ricordava di
   * passare la prop); aprendo lo stesso editor da ProjectHub/FunnelTab,
   * Clone Landing o Agentic Swipe il menu spariva e Claude tornava a
   * indovinare il prodotto dall'HTML — è proprio la regressione "non
   * vedo più la tendina" che l'utente ha segnalato.
   *
   * Adesso ogni entry-point eredita gratis l'intera lista My Projects
   * dallo store. Se il parent vuole comunque imporre una lista custom
   * (caso raro), passare `availableProducts` continua a vincere. */
  const storeProjects = useStore((s) => s.projects);
  const resolvedAvailableProducts = useMemo(() => {
    if (availableProducts) return availableProducts;
    return (storeProjects || []).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description || '',
      // Stessa logica del fallback in front-end-funnel: prima i file
      // parsati (briefData), poi il blob legacy `brief` come fallback.
      brief:
        extractSectionContent(p.briefData).trim() || (p.brief || '').trim(),
      marketResearch: extractSectionContent(p.marketResearchData),
      imageUrl: (Array.isArray(p.logo) && p.logo[0]?.url) || '',
    }));
  }, [availableProducts, storeProjects]);

  const effectiveProduct = useMemo(() => {
    const fromList = resolvedAvailableProducts.find((p) => p.id === selectedProductId);
    if (fromList) return fromList;
    if (productContext) {
      return {
        id: '',
        name: productContext.name || '',
        description: productContext.description,
        brief: productContext.brief,
        marketResearch: productContext.marketResearch,
        imageUrl: productContext.imageUrl,
      };
    }
    return undefined;
  }, [resolvedAvailableProducts, selectedProductId, productContext]);

  const handleProductSelect = useCallback(
    (id: string) => {
      setSelectedProductId(id);
      onProductChange?.(id);
    },
    [onProductChange],
  );
  const [aiVideoDuration, setAiVideoDuration] = useState<5 | 10>(5);
  const [aiVideoLoop, setAiVideoLoop] = useState<boolean>(true);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiRevisedPrompt, setAiRevisedPrompt] = useState('');
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [showAiImagePopup, setShowAiImagePopup] = useState(false);
  const [aiContextText, setAiContextText] = useState('');
  /** True quando il modal AI è stato aperto dal bottone "Swipe for Product"
   *  con un'immagine prodotto già disponibile: appena il modal monta e
   *  l'aiSourceImage è impostato, parte automaticamente Seedance 2.0
   *  senza che l'utente debba toccare null'altro. */
  const [swipeAutoMode, setSwipeAutoMode] = useState(false);
  /** Stati relativi all'analisi vision del clip originale (Claude vede
   *  il poster del <video> e propone un prompt mirato per Seedance). */
  const [swipeVisionLoading, setSwipeVisionLoading] = useState(false);
  const [swipeVisionMode, setSwipeVisionMode] = useState<'vision' | 'text' | null>(null);
  const [swipeVisionIntent, setSwipeVisionIntent] = useState('');
  const [swipeVisionError, setSwipeVisionError] = useState('');
  /** Stage del lavoro Claude: extracting | analyzing | done. Permette al
   *  banner di mostrare un feedback più granulare durante i 5-15s in cui
   *  il poster viene decodificato in 3 frame e poi mandato a Claude. */
  const [swipeStage, setSwipeStage] = useState<
    'idle' | 'extracting' | 'analyzing' | 'done'
  >('idle');
  /** Numero di frame effettivamente analizzati da Claude (1 = solo poster,
   *  3 = multi-frame chronological). */
  const [swipeFramesUsed, setSwipeFramesUsed] = useState(0);
  /** Output approfondito dell'analyzer (chain-of-thought condensata). */
  const [swipeAnalysis, setSwipeAnalysis] = useState('');
  const [swipeBigIdea, setSwipeBigIdea] = useState('');
  const [swipeTargetAudience, setSwipeTargetAudience] = useState('');
  const [swipeNegativePrompt, setSwipeNegativePrompt] = useState('');
  /** 'video' quando il modal Swipe è stato aperto da un <video>,
   *  'image' quando è stato aperto da un <img>. Cambia il copy del
   *  banner, l'endpoint analyzer e il modello di default. */
  const [swipeMediaKind, setSwipeMediaKind] = useState<'video' | 'image' | null>(null);
  /** Indicazioni extra che l'utente può scrivere per guidare la
   *  rigenerazione del prompt (es. "fai vedere persona prima grassa con
   *  cuffie e poi magra"). */
  const [swipeExtraGuidance, setSwipeExtraGuidance] = useState('');
  /** Snapshot del contesto in cui è stato avviato lo Swipe (alt, URL del
   *  poster/img, brief…), così il bottone "Rigenera prompt" può rifare la
   *  chiamata anche dopo che selectedElement è cambiato. */
  const swipeAnalysisCtxRef = useRef<{
    mediaKind: 'video' | 'image';
    /** Per i video è il poster, per le immagini è la src. */
    sourceImageUrl: string;
    /** Solo per video: 0-3 frame (data URL JPEG) estratti dal clip. */
    posterFrames: string[];
    /** Heading vicino, paragrafo, CTA. */
    surroundingContext: {
      heading?: string;
      nearbyText?: string;
      cta?: string;
      position?: string;
    };
    currentAlt: string;
    pageTitle: string;
    productName: string;
    productDesc: string;
    productBrief: string;
    fallbackPrompt: string;
  } | null>(null);

  const AI_MODELS: Record<AiMode, { id: string; label: string; hint: string }[]> = {
    text2image: [
      { id: 'nano-banana-2', label: 'Nano Banana 2 (Gemini 3.1 Flash)', hint: 'Fast, high quality, default' },
      { id: 'gpt-image-2', label: 'ChatGPT Image 2 (OpenAI)', hint: 'Top for text in images, expensive' },
      { id: 'flux-schnell', label: 'FLUX Schnell', hint: 'Super fast (~2s), cheap' },
      { id: 'flux-dev', label: 'FLUX Dev', hint: 'Higher quality, slower' },
      { id: 'imagen4', label: 'Google Imagen 4 Fast', hint: 'Good for realism' },
    ],
    image2image: [
      { id: 'nano-banana-2-edit', label: 'Nano Banana 2 Edit', hint: 'Targeted edit, preserves subject' },
      { id: 'gpt-image-2-edit', label: 'ChatGPT Image 2 Edit (OpenAI)', hint: 'Fine editing, expensive' },
      { id: 'flux-kontext', label: 'FLUX Pro Kontext', hint: 'Advanced re-edit' },
    ],
    image2video: [
      { id: 'seedance-2', label: 'Bytedance Seedance 2.0', hint: '5/10s, top quality, multi-resolution' },
      { id: 'veo3-fast', label: 'Google Veo 3 Fast', hint: 'Top quality, 5/8s' },
      { id: 'kling-21', label: 'Kling 2.1 Standard', hint: '5/10s, high naturalness' },
    ],
    text2video: [
      { id: 'seedance-2-t2v', label: 'Bytedance Seedance 2.0 (T2V)', hint: '5/10s, scene invented from prompt, top quality' },
      { id: 'seedance-2-t2v-fast', label: 'Bytedance Seedance 2.0 Fast (T2V)', hint: '5/10s, cheaper, faster render' },
    ],
  };

  // Whenever the user switches mode, snap aiModel to the first valid option
  // for that mode (so we don't end up with e.g. mode=video + model=flux).
  useEffect(() => {
    const valid = AI_MODELS[aiMode].some((m) => m.id === aiModel);
    if (!valid) setAiModel(AI_MODELS[aiMode][0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiMode]);

  /* ── AI Code Editor ── */
  const [aiEditPrompt, setAiEditPrompt] = useState('');
  const [aiEditModel, setAiEditModel] = useState<'claude' | 'gemini'>('claude');
  const [aiEditRunning, setAiEditRunning] = useState(false);
  const [aiEditError, setAiEditError] = useState('');
  const [aiEditProgress, setAiEditProgress] = useState<{ chunkIndex: number; totalChunks: number; label: string } | null>(null);
  const [showAiEditPanel, setShowAiEditPanel] = useState(false);
  const [aiEditHistory, setAiEditHistory] = useState<string[]>([]);

  /* ── Brand Colors ──
   * Flusso: l'utente clicca "Brand Colors" in alto → si apre il panel.
   * Step 1: proviamo a estrarre una palette dal brief/market research (hex
   *         espliciti o, in mancanza, Gemini interpreta le keyword di brand).
   * Step 2: se non c'è abbastanza testo ma abbiamo productContext.imageUrl
   *         (la foto del prodotto), Gemini Vision la guarda e propone una
   *         palette coerente con il packaging/categoria.
   * Step 3: se non c'è né testo né imageUrl, chiediamo all'utente di caricare
   *         una foto prodotto e poi ripartiamo da Step 2.
   * Step 4: l'utente conferma la palette → la inoltriamo a /api/ai-edit-html
   *         con un prompt strutturato che ricolora TUTTA la pagina in modo
   *         consistente (background, testi, bottoni, gradient, ombre…). */
  const [showBrandColorsPanel, setShowBrandColorsPanel] = useState(false);
  const [brandPalette, setBrandPalette] = useState<BrandPalette | null>(null);
  const [brandExtractRunning, setBrandExtractRunning] = useState(false);
  const [brandExtractError, setBrandExtractError] = useState('');
  const [brandNeedsImage, setBrandNeedsImage] = useState(false);
  const [brandUploadedImageUrl, setBrandUploadedImageUrl] = useState('');
  const [brandApplying, setBrandApplying] = useState(false);
  const brandFileInputRef = useRef<HTMLInputElement>(null);
  const [aiPresetPrompts] = useState([
    { label: 'Conspiracy / Dark Brand', prompt: 'Completely transform the brand to conspiracy/secret style: use dark colors (black, dark red, gold), impactful fonts, add mysterious visual elements, make the tone more urgent and secretive, modify all text to have a conspiracy angle with "they don\'t want you to know" language, add symbols like eyes, triangles, locks where appropriate in text.' },
    { label: 'Luxury / Premium', prompt: 'Transform the brand to luxury premium style: use elegant colors (black, gold, white), elegant serif fonts, wide spacing, add subtle shadows, make the design minimalist and sophisticated, modify text with exclusive and premium tone.' },
    { label: 'Urgency / Scarcity', prompt: 'Add maximum urgency and scarcity to the entire page: red/yellow urgency banners, countdown timer styling, "limited spots" badges, "offer expiring" badges, colors that communicate urgency (red, orange), text with maximum scarcity and urgency.' },
    { label: 'Health / Natural', prompt: 'Transform to health/natural style: green, beige, earthy brown colors, clean and modern fonts, nature imagery, warm tones, text emphasizing naturalness, wellness, pure ingredients.' },
    { label: 'Tech / Futuristic', prompt: 'Transform to futuristic tech style: cyan, purple, black colors, neon gradients, modern sans-serif fonts, thin glowing borders, glow effects, text with innovative and technological tone.' },
  ]);

  /* ── Element AI Chat ── */
  const [elAiMessages, setElAiMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [elAiInput, setElAiInput] = useState('');
  const [elAiLoading, setElAiLoading] = useState(false);
  const elAiPendingRef = useRef<string | null>(null);
  const elAiChatEndRef = useRef<HTMLDivElement>(null);

  /* ── Section Library (state only) ── */
  const [savedSections, setSavedSections] = useState<SavedSection[]>([]);
  const [showSectionLibrary, setShowSectionLibrary] = useState(false);
  const [showInsertPanel, setShowInsertPanel] = useState(false);
  const [insertSearch, setInsertSearch] = useState('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveSectionName, setSaveSectionName] = useState('');

  // ── Tracking snippet dialog ──
  // Pulsante in toolbar -> popup dove l'utente incolla un URL o uno
  // snippet HTML completo (es. Meta Pixel, GA4, tracker proprietario)
  // che vogliamo piazzare SUBITO DOPO il tag <head>. Volutamente
  // permissivo:
  //   - se l'input parte con `<` lo usiamo as-is (script/meta/link/...)
  //   - altrimenti lo trattiamo come URL e lo avvolgiamo in
  //     <script src="..." async></script>
  // Idempotente: ri-applicare lo stesso snippet non lo duplica nell'HTML.
  const [showTrackingDialog, setShowTrackingDialog] = useState(false);
  const [trackingInput, setTrackingInput] = useState('');
  const [trackingApplied, setTrackingApplied] = useState(false);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [saveSectionType, setSaveSectionType] = useState('other');
  const [saveSectionTags, setSaveSectionTags] = useState('');
  const [saveSectionAiRewrite, setSaveSectionAiRewrite] = useState(false);
  const [saveSectionModel, setSaveSectionModel] = useState<'claude' | 'gemini'>('claude');
  const [saveSectionStack, setSaveSectionStack] = useState<OutputStack>('pure_css');
  const [saveSectionCustomInstructions, setSaveSectionCustomInstructions] = useState('');
  const [saveSectionRunning, setSaveSectionRunning] = useState(false);
  const [saveSectionError, setSaveSectionError] = useState('');
  const [saveSectionSuccess, setSaveSectionSuccess] = useState(false);
  const [pendingSectionHtml, setPendingSectionHtml] = useState('');
  const [librarySearch, setLibrarySearch] = useState('');
  const [libraryFilterType, setLibraryFilterType] = useState('all');
  const [previewSectionId, setPreviewSectionId] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);

  useEffect(() => { setSavedSections(loadSavedSections()); }, []);

  /* ── Undo/Redo ── */
  const pushUndo = useCallback((html: string) => {
    const stack = undoStack.current;
    if (stack[undoIdx.current] === html) return;
    stack.splice(undoIdx.current + 1);
    stack.push(html);
    if (stack.length > 60) stack.shift();
    undoIdx.current = stack.length - 1;
    redoStack.current = [];
  }, []);

  const canUndo = undoIdx.current > 0;
  const canRedo = undoIdx.current < undoStack.current.length - 1;

  /*
   * Undo/Redo: stesso pattern dei fix freeze precedenti.
   *
   * Il problema: bumpiamo `iframeVersion` per forzare l'iframe a ricaricare
   * la nuova srcDoc dallo stack di history. La srcDoc e' pesante (HTML
   * clonato + Swiper + jQuery) e React la passa al browser sincronicamente
   * dentro lo stesso commit → main thread bloccato 1-2s.
   *
   * Soluzione: paint immediato dell'overlay "Restoring…", svuoto del
   * vecchio iframe su rAF, poi su setTimeout(0) applico davvero la
   * versione storica (l'iframe remonta, parser blocca, ma l'overlay e'
   * gia' visibile). Il messaggio 'editor-ready' del nuovo iframe pulira'
   * il flag.
   */
  const [restoringHistory, setRestoringHistory] = useState(false);
  const applyHistorySnapshot = useCallback((html: string) => {
    setRestoringHistory(true);
    setEditorReady(false);
    requestAnimationFrame(() => {
      try {
        if (iframeRef.current) {
          iframeRef.current.srcdoc = '<!doctype html><html><body></body></html>';
        }
      } catch { /* iframe detached */ }
      setTimeout(() => {
        setIframeVersion(v => v + 1);
        setCurrentHtml(html);
        setCodeHtml(html);
        // Defensive: l'iframe potrebbe non rispondere con 'editor-ready'.
        setTimeout(() => setRestoringHistory(false), 4000);
      }, 0);
    });
  }, []);

  const handleUndo = useCallback(() => {
    if (undoIdx.current <= 0 || restoringHistory) return;
    undoIdx.current--;
    const html = undoStack.current[undoIdx.current];
    applyHistorySnapshot(html);
  }, [restoringHistory, applyHistorySnapshot]);

  const handleRedo = useCallback(() => {
    if (undoIdx.current >= undoStack.current.length - 1 || restoringHistory) return;
    undoIdx.current++;
    const html = undoStack.current[undoIdx.current];
    applyHistorySnapshot(html);
  }, [restoringHistory, applyHistorySnapshot]);

  /* ── Iframe communication ── */
  const sendToIframe = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data?.type) return;
      switch (e.data.type) {
        case 'editor-ready':
          setEditorReady(true);
          setSwitchingViewport(false);
          setSwitchingMode(false);
          setRestoringHistory(false);
          sendToIframe({ type: 'cmd-get-sections' });
          break;
        case 'element-selected':
          setSelectedElement(e.data.data);
          setIsEditing(false);
          break;
        case 'element-deselected':
          setSelectedElement(null);
          setIsEditing(false);
          break;
        case 'editing-started':
          setSelectedElement(e.data.data);
          setIsEditing(true);
          break;
        case 'editing-finished':
          setSelectedElement(e.data.data);
          setIsEditing(false);
          break;
        case 'html-updated': {
          const clean = stripEditorScript(e.data.data);
          if (editorViewport === 'mobile' && mobileHtml) {
            setMobileHtml(clean);
          } else {
            setCurrentHtml(clean);
            pushUndo(clean);
          }
          break;
        }
        case 'clean-html':
          if (editorViewport === 'mobile' && mobileHtml) {
            setMobileHtml(stripEditorScript(e.data.data));
          } else {
            setCurrentHtml(stripEditorScript(e.data.data));
          }
          break;
        case 'sections-list':
          setSections(e.data.data);
          break;
        case 'selected-full-html':
          setPendingSectionHtml(e.data.data);
          setShowSaveDialog(true);
          break;
        case 'element-html-for-ai':
          elAiPendingRef.current = e.data.data;
          break;
        case 'section-inserted':
          setShowInsertPanel(false);
          break;
        case 'request-insert-after':
          setShowInsertPanel(true);
          break;
        case 'context-text':
          setAiContextText(e.data.data || '');
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [sendToIframe, pushUndo, editorViewport, mobileHtml]);

  /* ── Section Library (callbacks – needs sendToIframe) ── */
  const handleRequestSaveSection = useCallback(() => {
    sendToIframe({ type: 'cmd-get-selected-full-html' });
    setSaveSectionName('');
    setSaveSectionType('other');
    setSaveSectionTags('');
    setSaveSectionAiRewrite(false);
    setSaveSectionStack('pure_css');
    setSaveSectionCustomInstructions('');
    setSaveSectionError('');
    setSaveSectionSuccess(false);
  }, [sendToIframe]);

  const handleSaveSection = useCallback(async () => {
    if (!pendingSectionHtml || !saveSectionName.trim()) return;
    setSaveSectionRunning(true);
    setSaveSectionError('');

    try {
      let finalHtml = pendingSectionHtml;

      if (saveSectionAiRewrite) {
        const res = await fetch('/api/rewrite-section', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            html: pendingSectionHtml,
            model: saveSectionModel,
            context: pageTitle || undefined,
            outputStack: saveSectionStack,
            customStackInstructions: saveSectionStack === 'custom' ? saveSectionCustomInstructions : undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'AI rewrite error');
        finalHtml = data.html;
      }

      const newSection: SavedSection = {
        id: generateId(),
        name: saveSectionName.trim(),
        html: finalHtml,
        sectionType: saveSectionType,
        tags: saveSectionTags.split(',').map(t => t.trim()).filter(Boolean),
        textPreview: finalHtml.replace(/<[^>]*>/g, '').substring(0, 120).trim(),
        sourcePageTitle: pageTitle || undefined,
        aiRewritten: saveSectionAiRewrite,
        outputStack: saveSectionAiRewrite ? saveSectionStack : undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const updated = [newSection, ...savedSections];
      setSavedSections(updated);
      persistSavedSections(updated);
      setSaveSectionSuccess(true);
      setTimeout(() => {
        setShowSaveDialog(false);
        setSaveSectionSuccess(false);
      }, 1500);
    } catch (err) {
      setSaveSectionError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaveSectionRunning(false);
    }
  }, [pendingSectionHtml, saveSectionName, saveSectionType, saveSectionTags, saveSectionAiRewrite, saveSectionModel, saveSectionStack, saveSectionCustomInstructions, savedSections, pageTitle]);

  const handleDeleteSection = useCallback((id: string) => {
    const updated = savedSections.filter(s => s.id !== id);
    setSavedSections(updated);
    persistSavedSections(updated);
  }, [savedSections]);

  const handleImportSection = useCallback((section: SavedSection) => {
    setImportingId(section.id);
    sendToIframe({ type: 'cmd-insert-section', html: section.html });
    setTimeout(() => setImportingId(null), 1500);
  }, [sendToIframe]);

  const handleInsertAfter = useCallback((section: SavedSection) => {
    sendToIframe({ type: 'cmd-insert-after-selected', html: section.html });
    setShowInsertPanel(false);
  }, [sendToIframe]);

  const insertPanelSections = savedSections.filter(s => {
    if (!insertSearch.trim()) return true;
    const q = insertSearch.toLowerCase();
    return (s.name || '').toLowerCase().includes(q) || (s.tags || []).some(t => (t || '').toLowerCase().includes(q)) || (s.sectionType || '').toLowerCase().includes(q);
  });

  const filteredLibrarySections = savedSections.filter(s => {
    if (libraryFilterType !== 'all' && s.sectionType !== libraryFilterType) return false;
    if (librarySearch.trim()) {
      const q = librarySearch.toLowerCase();
      return (s.name || '').toLowerCase().includes(q) ||
             (s.textPreview || '').toLowerCase().includes(q) ||
             (s.tags || []).some(t => (t || '').toLowerCase().includes(q));
    }
    return true;
  });

  /* ── Mode switching ── */
  const switchMode = useCallback((newMode: EditorMode) => {
    if (newMode === mode) return;
    if (mode === 'code' && newMode === 'visual') {
      setIframeVersion(v => v + 1);
      if (editorViewport === 'mobile' && mobileHtml) {
        setMobileHtml(mobileCodeHtml);
      } else {
        setCurrentHtml(codeHtml);
        pushUndo(codeHtml);
      }
    }
    if (mode === 'visual' && newMode === 'code') {
      sendToIframe({ type: 'cmd-get-html' });
      if (editorViewport === 'mobile' && mobileHtml) {
        setMobileCodeHtml(mobileHtml);
      } else {
        setCodeHtml(currentHtml);
      }
    }
    setMode(newMode);
    setSelectedElement(null);
    setIsEditing(false);
  }, [mode, codeHtml, mobileCodeHtml, currentHtml, mobileHtml, editorViewport, sendToIframe, pushUndo]);

  /* ── Commands ── */
  const execCmd = (cmd: string, val?: string) => sendToIframe({ type: 'cmd-exec', command: cmd, value: val });
  const setStyle = (prop: string, val: string) => sendToIframe({ type: 'cmd-set-style', property: prop, value: val });
  const setAttr = (name: string, val: string) => sendToIframe({ type: 'cmd-set-attr', name, value: val });
  const setChildImgSrc = (val: string) => sendToIframe({ type: 'cmd-set-child-img-src', value: val });
  const setChildImgSrcAt = (index: number, val: string) => sendToIframe({ type: 'cmd-set-child-img-src-at', index, value: val });
  const setChildBgImage = (val: string) => sendToIframe({ type: 'cmd-set-child-bg-image', value: val });
  // Forma immagine: applica border-radius/aspect-ratio/object-fit all'immagine
  // selezionata (o a TUTTE quelle del blocco se scope='all', per caroselli).
  const setShape = (shape: string, scope: 'main' | 'all' = 'main') =>
    sendToIframe({ type: 'cmd-set-shape', shape, scope });
  // Selettore visuale di forma per le immagini. Ogni pulsante mostra
  // un'anteprima della forma e la applica all'immagine (o a tutte, scope='all').
  const ShapeRow = ({ scope = 'main' as 'main' | 'all' }: { scope?: 'main' | 'all' }) => {
    const shapes: { id: string; label: string; w: number; h: number; r: string }[] = [
      { id: 'rect', label: 'Rect.', w: 24, h: 14, r: '2px' },
      { id: 'rounded', label: 'Rounded', w: 24, h: 14, r: '6px' },
      { id: 'square', label: 'Square', w: 16, h: 16, r: '2px' },
      { id: 'circle', label: 'Circle', w: 16, h: 16, r: '50%' },
      { id: 'pill', label: 'Pill', w: 24, h: 12, r: '9999px' },
    ];
    return (
      <div className="mt-2">
        <label className="text-[10px] text-slate-500 mb-1 block">
          Image shape{scope === 'all' ? ' (all)' : ''}
        </label>
        <div className="grid grid-cols-5 gap-1">
          {shapes.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setShape(s.id, scope)}
              title={s.label}
              className="flex flex-col items-center justify-center gap-1 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-blue-50 hover:border-blue-300 transition-all"
            >
              <span
                style={{ width: s.w, height: s.h, borderRadius: s.r, background: '#94a3b8', display: 'block' }}
              />
              <span className="text-[9px] text-slate-500 leading-none">{s.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  };
  const removeAttr = (name: string) => sendToIframe({ type: 'cmd-remove-attr', name });
  // Toggle di un attributo booleano HTML (es. loop, controls, muted...).
  // Aggiunge l'attributo (value="") se ON, lo rimuove se OFF.
  const setBoolAttr = (name: string, on: boolean) => {
    if (on) setAttr(name, '');
    else removeAttr(name);
  };

  /* ── Export ── */
  const handleSave = () => {
    // Forza il flush dell'HTML dall'iframe (sendHtml e' debounce-ato a 200ms,
    // se l'utente clicca Salva subito dopo un'edit le ultime mutazioni
    // sarebbero perse). Aspetto un microtask + un piccolo timeout per
    // lasciar arrivare la risposta html-updated prima di chiamare onSave.
    sendToIframe({ type: 'cmd-flush-html' });
    setTimeout(() => {
      onSave(currentHtmlRef.current, mobileHtml || undefined);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }, 50);
  };

  // Salva la pagina corrente direttamente nel Progetto/Funnel (stessa logica
  // del modal in front-end-funnel). Flusha prima l'HTML dall'iframe cosi' il
  // parent riceve l'ultima versione, poi delega al parent l'apertura del modal.
  const handleSaveToProject = () => {
    if (!onSaveToProject) return;
    sendToIframe({ type: 'cmd-flush-html' });
    setTimeout(() => {
      onSaveToProject(currentHtmlRef.current, mobileHtml || undefined);
    }, 50);
  };

  const handleDownload = () => {
    const blob = new Blob([currentHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `edited-${pageTitle?.replace(/\s+/g, '-') || 'landing'}-${Date.now()}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(currentHtml);
  };

  /* ── Tracking snippet inject ──
   *  Apre/chiude il popup e applica lo snippet alla pagina corrente.
   *  Comportamento:
   *    - Input vuoto: errore inline, nessuna modifica all'HTML.
   *    - Input che inizia con `<`: usato as-is (es. tag completo Meta
   *      Pixel/GA4/script proprietario/meta verification).
   *    - Altrimenti: trattato come URL e avvolto in
   *        <script src="..." async></script>.
   *    - Idempotency: se lo snippet (normalizzato) e' gia' presente
   *      nell'HTML, non viene duplicato.
   *  Inserimento: subito dopo il tag `<head>` (preservando attributi
   *  tipo `<head lang="en">`). Se la pagina non ha `<head>` ricadiamo
   *  prima di `</head>` (chiusura), come ultima ancora prima di `<body>`.
   *  Aggiorna currentHtml + codeHtml + undo stack e bumpa iframeVersion
   *  per forzare il re-mount dell'iframe con la nuova srcDoc. */
  const handleApplyTracking = () => {
    const raw = trackingInput.trim();
    if (!raw) {
      setTrackingError('Incolla un URL o uno snippet HTML.');
      return;
    }
    const snippet = raw.startsWith('<')
      ? raw
      : `<script src="${raw.replace(/"/g, '&quot;')}" async></script>`;

    // Idempotency: normalizza whitespace e confronta. Cosi' re-aprire
    // il dialog e ri-cliccare Apply non duplica lo stesso tag.
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    if (norm(currentHtml).includes(norm(snippet))) {
      setTrackingError('Questo snippet e\' gia\' presente nella pagina.');
      return;
    }

    let updated: string;
    if (/<head\b[^>]*>/i.test(currentHtml)) {
      updated = currentHtml.replace(
        /(<head\b[^>]*>)/i,
        `$1\n  ${snippet}`,
      );
    } else if (/<\/head\s*>/i.test(currentHtml)) {
      updated = currentHtml.replace(/<\/head\s*>/i, `  ${snippet}\n</head>`);
    } else if (/<body\b[^>]*>/i.test(currentHtml)) {
      // Frammenti senza <head>: ancoriamo prima del <body>.
      updated = currentHtml.replace(
        /(<body\b[^>]*>)/i,
        `${snippet}\n$1`,
      );
    } else {
      // Last resort: prepend. Niente <head>/<body> = frammento HTML.
      updated = `${snippet}\n${currentHtml}`;
    }

    setIframeVersion(v => v + 1);
    setCurrentHtml(updated);
    setCodeHtml(updated);
    pushUndo(updated);

    setTrackingApplied(true);
    setTrackingError(null);
    setTimeout(() => {
      setTrackingApplied(false);
      setShowTrackingDialog(false);
      setTrackingInput('');
    }, 900);
  };

  /* ── AI Image Generation ── */
  // Helper: parse JSON safely. The backend route always returns JSON, but
  // serverless platforms (Netlify) may surface their own HTML error pages on
  // function timeout / 5xx. In that case, json() throws "Unexpected token <".
  // We rebuild a sane error message instead of leaking the SyntaxError.
  const safeJson = async (res: Response): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> => {
    const raw = await res.text();
    try {
      return { ok: true, data: JSON.parse(raw) as Record<string, unknown> };
    } catch {
      const snippet = raw.replace(/\s+/g, ' ').slice(0, 180);
      return {
        ok: false,
        error:
          res.status === 504 || res.status === 502
            ? `Function timeout (${res.status}). Try again: the model took too long.`
            : `Non-JSON response (${res.status}): ${snippet}`,
      };
    }
  };

  // Upload of the source image used by image2image / image2video. Reuses the
  // existing Supabase direct uploader, then stashes the public URL in state.
  const handleAiSourceUpload = useCallback(async (file: File) => {
    if (aiSourceUploading) return;
    setAiSourceUploading(true);
    setAiError('');
    try {
      const url = await directSupabaseUpload(file);
      setAiSourceImage(url);
    } catch (err) {
      setAiError(err instanceof Error ? `Upload failed: ${err.message}` : 'Upload failed');
    } finally {
      setAiSourceUploading(false);
    }
  }, [aiSourceUploading]);

  /* Upload della foto del NOSTRO prodotto (seconda immagine per l'edit). */
  const handleAiProductUpload = useCallback(async (file: File) => {
    if (aiProductUploading) return;
    setAiProductUploading(true);
    setAiError('');
    try {
      const url = await directSupabaseUpload(file);
      setAiProductImage(url);
    } catch (err) {
      setAiError(err instanceof Error ? `Upload failed: ${err.message}` : 'Upload failed');
    } finally {
      setAiProductUploading(false);
    }
  }, [aiProductUploading]);

  /* Upload di una o più immagini extra (collage) per l'edit multi-immagine. */
  const handleAiExtraUpload = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length || aiExtraUploading) return;
    setAiExtraUploading(true);
    setAiError('');
    try {
      for (const f of list) {
        const url = await directSupabaseUpload(f);
        setAiExtraImages((prev) => [...prev, url]);
      }
    } catch (err) {
      setAiError(err instanceof Error ? `Upload failed: ${err.message}` : 'Upload failed');
    } finally {
      setAiExtraUploading(false);
    }
  }, [aiExtraUploading]);

  const handleAiGenerate = useCallback(async () => {
    if (aiGenerating) return;
    let finalPrompt = aiPrompt.trim();
    if (!finalPrompt && aiMode === 'text2image' && aiContextText.trim()) {
      finalPrompt = `Create a professional, high-quality image that visually represents the following content. Make it suitable for a landing page or marketing material. Context: "${aiContextText.trim().substring(0, 500)}"`;
    }
    if (!finalPrompt) {
      setAiError(
        aiMode === 'image2video'
          ? 'Enter a description of how to animate the image'
          : aiMode === 'image2image'
            ? 'Describe the change to apply to the image'
            : aiMode === 'text2video'
              ? 'Describe the video scene to generate'
              : 'Enter a prompt or select an element with nearby text',
      );
      return;
    }
    if ((aiMode === 'image2image' || aiMode === 'image2video') && !aiSourceImage) {
      setAiError('Upload a source image first.');
      return;
    }

    setAiGenerating(true);
    setAiError('');
    setAiRevisedPrompt('');
    try {
      const submitRes = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: aiMode,
          model: aiModel,
          prompt: finalPrompt,
          size: aiSize,
          style: aiStyle,
          imageUrl: aiSourceImage || undefined,
          // Seconda immagine (nostro prodotto) solo nell'edit image2image:
          // i modelli Nano Banana 2 / GPT Image 2 edit la fondono con la
          // sorgente per sostituire il prodotto.
          secondaryImageUrl:
            aiMode === 'image2image' && aiProductImage ? aiProductImage : undefined,
          // Collage / immagini extra: si accodano alla sorgente nei modelli
          // edit multi-immagine (Nano Banana 2 / GPT Image 2).
          extraImageUrls:
            aiMode === 'image2image' && aiExtraImages.length ? aiExtraImages : undefined,
          duration:
            aiMode === 'image2video' || aiMode === 'text2video'
              ? aiVideoDuration
              : undefined,
        }),
      });
      const submitParsed = await safeJson(submitRes);
      if (!submitParsed.ok) throw new Error(submitParsed.error);
      let data = submitParsed.data as {
        status?: string;
        url?: string;
        revisedPrompt?: string;
        mediaType?: 'image' | 'video';
        requestId?: string;
        statusUrl?: string;
        responseUrl?: string;
        modelKey?: string;
        falStatus?: string;
        error?: string;
      };
      if (!submitRes.ok || data.status === 'error') {
        throw new Error(data.error || 'Generation error');
      }

      const POLL_DEADLINE = Date.now() + 5 * 60_000;
      while (data.status === 'pending' && data.requestId) {
        if (Date.now() > POLL_DEADLINE) {
          throw new Error('Timeout: generation took more than 5 minutes.');
        }
        await new Promise((r) => setTimeout(r, 1500));
        const pollRes = await fetch('/api/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'poll',
            requestId: data.requestId,
            statusUrl: data.statusUrl,
            responseUrl: data.responseUrl,
            modelKey: data.modelKey,
          }),
        });
        const pollParsed = await safeJson(pollRes);
        if (!pollParsed.ok) throw new Error(pollParsed.error);
        const next = pollParsed.data as typeof data;
        if (next.status === 'error') throw new Error(next.error || 'Polling error');
        data = {
          ...data,
          ...next,
          statusUrl: next.statusUrl || data.statusUrl,
          responseUrl: next.responseUrl || data.responseUrl,
          modelKey: next.modelKey || data.modelKey,
        };
      }

      if (data.status !== 'completed' || !data.url) {
        throw new Error(data.error || 'No media returned by the model');
      }

      const url = data.url;
      const mediaType = data.mediaType || 'image';

      if (mediaType === 'video') {
        // Replace the selected <img> with a looping muted <video> tag so the
        // result behaves like a GIF on the page.
        const loopAttr = aiVideoLoop ? ' loop' : '';
        const tag = selectedElement?.tagName;
        const videoHtml = `<video src="${url}" autoplay${loopAttr} muted playsinline class="w-full h-auto rounded-lg" style="max-width:100%;height:auto;"></video>`;
        if (tag === 'img' || tag === 'video') {
          sendToIframe({ type: 'cmd-replace-outer-html', html: videoHtml });
        } else {
          // Nothing suitable selected — insert as a new section after the body.
          sendToIframe({ type: 'cmd-insert-section', html: videoHtml });
        }
      } else {
        setAttr('src', url);
        if (data.revisedPrompt) {
          setAiRevisedPrompt(data.revisedPrompt);
          setAttr('alt', data.revisedPrompt.substring(0, 120));
        }
      }

      setShowAiImagePopup(false);
      setSwipeMediaKind(null);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setAiGenerating(false);
    }
  }, [
    aiMode,
    aiModel,
    aiPrompt,
    aiSize,
    aiStyle,
    aiSourceImage,
    aiProductImage,
    aiExtraImages,
    aiVideoDuration,
    aiVideoLoop,
    aiGenerating,
    aiContextText,
    selectedElement,
    setAttr,
    sendToIframe,
  ]);

  /* Default sorgente: quando si apre il modal su Modifica (image2image) o
   * Anima (image2video) e non c'è ancora una sorgente, precompila con
   * l'immagine della sezione/elemento selezionato (img, immagine nel blocco
   * o background-image). L'utente può sempre sostituirla caricandone un'altra.
   * Usiamo l'update funzionale (prev || cand) così non sovrascriviamo una
   * scelta dell'utente e non re-iniettiamo dopo una rimozione manuale. */
  useEffect(() => {
    if (!showAiImagePopup) return;
    if (aiMode !== 'image2video' && aiMode !== 'image2image') return;
    const e = selectedElement;
    if (!e) return;
    const cand =
      (e.tagName === 'img' ? e.src : '') ||
      e.childImg?.src ||
      (e.childImgs && e.childImgs[0]?.src) ||
      e.childBg?.src ||
      '';
    if (!cand || !/^https?:\/\//.test(cand)) return;
    setAiSourceImage((prev) => prev || cand);
  }, [showAiImagePopup, aiMode, selectedElement]);

  /* ── Media Upload ── */
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const imgUploadRef = useRef<HTMLInputElement>(null);
  const vidUploadRef = useRef<HTMLInputElement>(null);
  const bgImgUploadRef = useRef<HTMLInputElement>(null);
  const childImgUploadRef = useRef<HTMLInputElement>(null);
  const childImgsUploadRef = useRef<HTMLInputElement>(null);
  const childImgsUploadIndexRef = useRef<number>(-1);
  // Pannello "Immagini nel blocco" come menu a tendina: con caroselli/gallery
  // da decine di immagini la lista è lunghissima, quindi parte chiuso.
  const [childImgsOpen, setChildImgsOpen] = useState(false);

  const handleMediaUpload = useCallback(async (file: File, target: 'image' | 'video') => {
    if (uploading) return;
    setUploading(true);
    setUploadError('');
    try {
      const publicUrl = await directSupabaseUpload(file);
      setAttr('src', publicUrl);
      if (target === 'image' && file.name) {
        setAttr('alt', file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '));
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [uploading, setAttr]);

  /* Carica e sostituisce il primo <img> DENTRO l'elemento selezionato:
   * usato quando il click prende un wrapper/overlay invece dell'<img>
   * (ClickFunnels/Funnelish), cosi' l'immagine resta modificabile. */
  const handleChildImgUpload = useCallback(async (file: File) => {
    if (uploading) return;
    setUploading(true);
    setUploadError('');
    try {
      const publicUrl = await directSupabaseUpload(file);
      setChildImgSrc(publicUrl);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [uploading, setChildImgSrc]);

  /* Sostituisce l'<img> N-esima dentro il blocco (caroselli/gallery). */
  const handleChildImgUploadAt = useCallback(async (file: File, index: number) => {
    if (uploading) return;
    setUploading(true);
    setUploadError('');
    try {
      const publicUrl = await directSupabaseUpload(file);
      setChildImgSrcAt(index, publicUrl);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [uploading, setChildImgSrcAt]);

  /* requestSwipeContext — chiede all'iframe il contesto strutturato
   * (heading + paragrafo + CTA + posizione) attorno all'elemento
   * selezionato. Wrap della postMessage in una Promise con timeout 1500ms:
   * il banner non deve aspettare in eterno se l'iframe non risponde. */
  const requestSwipeContext = useCallback((): Promise<{
    heading?: string;
    nearbyText?: string;
    cta?: string;
    position?: string;
  }> => {
    return new Promise((resolve) => {
      let done = false;
      const finish = (data: {
        heading?: string;
        nearbyText?: string;
        cta?: string;
        position?: string;
      }) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        window.clearTimeout(t);
        resolve(data);
      };
      const onMsg = (e: MessageEvent) => {
        if (!e.data || e.data.type !== 'swipe-context') return;
        finish(e.data.data || {});
      };
      window.addEventListener('message', onMsg);
      const t = window.setTimeout(() => finish({}), 1500);
      sendToIframe({ type: 'cmd-get-swipe-context' });
    });
  }, [sendToIframe]);

  /* runSwipeAnalysis — chiama l'analyzer Claude e, se va a buon fine,
   * popola aiPrompt / aiContextText / intent / duration. Sia in
   * apertura iniziale che dal bottone "Rigenera prompt", la generazione
   * NON parte mai automatica: l'utente prima legge l'analisi e il
   * prompt suggerito, eventualmente lo modifica nel textarea, e POI
   * clicca il pulsante "Genera". Il parametro autoFire è mantenuto per
   * retrocompatibilità ma di fatto non viene più usato per autostart.
   * Legge il contesto da swipeAnalysisCtxRef così non dipende da
   * selectedElement (che potrebbe essere cambiato). */
  const runSwipeAnalysis = useCallback(
    async (opts: { extraGuidance?: string; autoFire?: boolean }) => {
      const ctx = swipeAnalysisCtxRef.current;
      if (!ctx) return;
      const extraGuidance = (opts.extraGuidance ?? '').trim();
      const autoFire = Boolean(opts.autoFire);

      setSwipeVisionLoading(true);
      setSwipeVisionError('');
      setSwipeAutoMode(false);
      setAiError('');

      setSwipeStage('analyzing');
      try {
        const endpoint =
          ctx.mediaKind === 'image'
            ? '/api/swipe-image/analyze'
            : '/api/swipe-video/analyze';
        const payload =
          ctx.mediaKind === 'image'
            ? {
                imageUrl: ctx.sourceImageUrl,
                /* Per le immagini riusiamo posterFrames[0] come imageDataUrl:
                   se presente ha PRIORITÀ sul fetch via URL lato server. */
                imageDataUrl:
                  ctx.posterFrames && ctx.posterFrames.length > 0
                    ? ctx.posterFrames[0]
                    : undefined,
                currentAlt: ctx.currentAlt,
                pageTitle: ctx.pageTitle,
                productContext: {
                  name: (effectiveProduct?.name || ctx.productName || '').trim(),
                  description: (effectiveProduct?.description || ctx.productDesc || '').trim(),
                  brief: (effectiveProduct?.brief || ctx.productBrief || '').trim().slice(0, 600),
                },
                surroundingContext: ctx.surroundingContext,
                userGuidance: extraGuidance || undefined,
              }
            : {
                posterUrl: ctx.sourceImageUrl,
                posterFrames: ctx.posterFrames,
                currentAlt: ctx.currentAlt,
                pageTitle: ctx.pageTitle,
                productContext: {
                  name: (effectiveProduct?.name || ctx.productName || '').trim(),
                  description: (effectiveProduct?.description || ctx.productDesc || '').trim(),
                  brief: (effectiveProduct?.brief || ctx.productBrief || '').trim().slice(0, 600),
                },
                surroundingContext: ctx.surroundingContext,
                userGuidance: extraGuidance || undefined,
              };
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = (await resp.json()) as {
          ok: boolean;
          analysis?: string;
          bigIdea?: string;
          targetAudience?: string;
          intent?: string;
          originalDescription?: string;
          uniqueMechanism?: string;
          transformation?: string;
          suggestedPrompt?: string;
          negativePrompt?: string;
          suggestedDuration?: number;
          framesUsed?: number;
          mode?: 'vision' | 'text';
          error?: string;
        };
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || `analyze ${resp.status}`);
        }
        const suggested =
          (data.suggestedPrompt || '').trim() || ctx.fallbackPrompt;
        const desc = (data.originalDescription || '').trim();
        const mech = (data.uniqueMechanism || '').trim();
        const transf = (data.transformation || '').trim();
        const neg = (data.negativePrompt || '').trim();
        /* Append del negative prompt come "Avoid: …" perché Nano Banana,
           Imagen 4 e Seedance 2.0 T2V non hanno un campo negative_prompt
           separato — Claude scrive le indicazioni nel prompt principale. */
        const finalPrompt = neg
          ? `${suggested}\n\nAvoid: ${neg}.`
          : suggested;
        setAiPrompt(finalPrompt);
        const ctxParts: string[] = [];
        if (desc) ctxParts.push(`Original: ${desc}`);
        if (mech) ctxParts.push(`Mechanism: ${mech}`);
        if (transf) ctxParts.push(`Transformation: ${transf}`);
        if (ctxParts.length > 0) setAiContextText(ctxParts.join(' • '));
        setSwipeVisionMode(data.mode || 'text');
        setSwipeVisionIntent(data.intent || '');
        setSwipeAnalysis((data.analysis || '').trim());
        setSwipeBigIdea((data.bigIdea || '').trim());
        setSwipeTargetAudience((data.targetAudience || '').trim());
        setSwipeNegativePrompt((data.negativePrompt || '').trim());
        if (typeof data.framesUsed === 'number') {
          setSwipeFramesUsed(data.framesUsed);
        }
        if (ctx.mediaKind === 'video') {
          const duration =
            data.suggestedDuration === 10 || data.suggestedDuration === 5
              ? (data.suggestedDuration as 5 | 10)
              : 10;
          setAiVideoDuration(duration);
        }
        setSwipeStage('done');
        if (autoFire) setSwipeAutoMode(true);
      } catch (err) {
        if (!aiPrompt.trim()) {
          /* Solo al primo tentativo lasciamo il fallback. Per un retry
             manuale teniamo quello che c'è già nel textarea, così l'utente
             non perde le sue modifiche. */
          setAiPrompt(ctx.fallbackPrompt);
        }
        setSwipeVisionMode(null);
        setSwipeStage('idle');
        setSwipeVisionError(
          err instanceof Error ? err.message : 'Analysis not available'
        );
      } finally {
        setSwipeVisionLoading(false);
      }
    },
    [aiPrompt, effectiveProduct],
  );

  /* Rigenera il prompt usando le indicazioni extra dell'utente. Non
   * fa partire automaticamente la generazione: l'utente prima legge il
   * nuovo prompt, eventualmente lo modifica, e poi clicca Genera. */
  const handleRegenerateSwipePrompt = useCallback(() => {
    if (swipeVisionLoading) return;
    void runSwipeAnalysis({
      extraGuidance: swipeExtraGuidance,
      autoFire: false,
    });
  }, [runSwipeAnalysis, swipeExtraGuidance, swipeVisionLoading]);

  /* ── Analizza con Claude l'immagine di riferimento caricata ──
   * Fa vedere a Claude l'immagine caricata + i dati del prodotto scelto e
   * scrive un prompt mirato nel textarea. Usa l'analyzer immagini
   * (/api/swipe-image/analyze) via runSwipeAnalysis: passando solo
   * sourceImageUrl (URL pubblico Supabase) il server fa il fetch lato suo.
   * Funziona in ogni tab — il prompt prodotto serve sia per generare/editare
   * che per animare. Deve stare DOPO runSwipeAnalysis: referenziarlo prima
   * nella dep array darebbe un TDZ ("cannot access before initialization"). */
  const handleAnalyzeReferenceImage = useCallback(async () => {
    if (!aiSourceImage || swipeVisionLoading || aiGenerating) return;

    const productName = (effectiveProduct?.name || '').trim();
    const productDesc = (effectiveProduct?.description || '').trim();
    const productBrief = (effectiveProduct?.brief || '').trim().slice(0, 600);

    const fallbackLines: string[] = [];
    fallbackLines.push(
      productName
        ? `Photorealistic promotional image for ${productName}, inspired by the reference image.`
        : 'Photorealistic promotional image inspired by the reference image.',
    );
    if (productDesc) fallbackLines.push(`What it is: ${productDesc}.`);
    if (productBrief) fallbackLines.push(`Brief snippet: ${productBrief}`);
    fallbackLines.push(
      'Keep the composition/mood of the reference, integrate our product naturally, professional lighting, no on-image text.',
    );

    swipeAnalysisCtxRef.current = {
      mediaKind: 'image',
      sourceImageUrl: aiSourceImage,
      posterFrames: [],
      surroundingContext: {},
      currentAlt: '',
      pageTitle: pageTitle || '',
      productName,
      productDesc,
      productBrief,
      fallbackPrompt: fallbackLines.join('\n'),
    };

    setSwipeMediaKind('image');
    setSwipeVisionError('');
    setSwipeVisionLoading(true);
    setSwipeStage('analyzing');
    await runSwipeAnalysis({ extraGuidance: swipeExtraGuidance, autoFire: false });
  }, [
    aiSourceImage,
    swipeVisionLoading,
    aiGenerating,
    effectiveProduct,
    pageTitle,
    runSwipeAnalysis,
    swipeExtraGuidance,
  ]);

  /* ── Swipe Video for Product ──
   * Sostituisce il video selezionato con un nuovo video AI-generato
   * COERENTE col nostro prodotto. Riusa il modal AI esistente
   * (`showAiImagePopup` con `aiMode = 'text2video'` → Seedance 2.0)
   * pre-compilando il prompt con:
   *   - contesto della pagina (alt del video + heading vicino) per
   *     "capire cosa è" il clip originale;
   *   - dati del Project (nome, descrizione, brief) per orientare la
   *     scena verso il NOSTRO prodotto.
   *
   * Nota: NON pre-compiliamo l'immagine sorgente col poster del clip
   * originale, perché è una frame del PRODOTTO COMPETITOR. Lo Swipe
   * usa text-to-video — l'AI inventa la scena da zero dal prompt.
   *
   * Il flow di replace già esistente nel modal (vedi `handleAiGenerate`)
   * sostituirà l'<video> selezionato con il nuovo URL via
   * cmd-replace-outer-html, quindi qui non c'è altro da fare. */
  const handleSwipeVideoForProduct = useCallback(async () => {
    if (!selectedElement || selectedElement.tagName !== 'video') return;

    /* ElementInfo espone direttamente alt/src/textContent/className.
       Non ha un map "attributes": andare a leggere selectedElement.attributes
       a runtime dà undefined → TypeError, motivo per cui in v1 il bottone
       sembrava "non fare nulla". Usiamo solo i field tipizzati. */
    const currentAlt = String(selectedElement.alt || '').trim();
    const posterUrl = (() => {
      const va = (selectedElement as unknown as {
        videoAttrs?: { poster?: string };
      }).videoAttrs;
      return String(va?.poster || '').trim();
    })();
    const videoSrc = String(selectedElement.src || '').trim();

    const productName = (effectiveProduct?.name || '').trim();
    const productDesc = (effectiveProduct?.description || '').trim();
    const productBrief = (effectiveProduct?.brief || '').trim().slice(0, 600);
    /* Swipe for Product = TEXT-to-VIDEO: l'AI inventa la scena DA ZERO da
       prompt, senza foto sorgente obbligatoria. Differente da "Anima" che è
       image-to-video (animazione di una foto fissa). Il vincolo della foto
       prodotto come prima frame produceva risultati limitati: l'output era
       sempre l'animazione del logo/box, mai una scena equivalente al clip
       originale. Con text2video Seedance 2.0 può ricreare il setting
       (es. before/after piedi sani, persona rilassata con il prodotto in mano,
       lifestyle shot, ecc.) coerente con l'intent del clip competitor. */

    /* Prompt fallback in caso l'analisi vision di Claude fallisca:
       struttura before → product-in-action → after (multi-shot Seedance 2.0)
       per non cadere mai in un generico "beauty shot" che non racconta
       niente del prodotto. Tutto in inglese (Seedance preferisce EN). */
    const fallbackLines: string[] = [];
    fallbackLines.push(
      productName
        ? `Create a 10-second multi-shot product video for ${productName}.`
        : 'Create a 10-second multi-shot product video for our product.'
    );
    if (productDesc) fallbackLines.push(`What it is: ${productDesc}.`);
    if (productBrief) fallbackLines.push(`Brief snippet: ${productBrief}`);
    if (currentAlt) fallbackLines.push(`Original clip context (keep the same persuasive intent): "${currentAlt}".`);
    fallbackLines.push(
      'Shot 1 (0-3s): the protagonist visibly experiencing the problem the product solves (frustrated, in pain, struggling — pick the most relevant from the brief).'
    );
    fallbackLines.push(
      'Shot 2 (3-7s): SAME protagonist using the product, with its unique mechanism shown VISUALLY (e.g. glowing audio waves entering the head, a glowing serum spreading, a device working) — the mechanism must be visible, not just implied.'
    );
    fallbackLines.push(
      'Shot 3 (7-10s): SAME protagonist after the transformation promised by the brief (slimmer, smiling, pain-free, energetic — match what the brief promises).'
    );
    fallbackLines.push(
      'Camera: slow push-in on shot 1, static medium on shot 2, slow pull-back on shot 3. Consistent character across shots. Realistic, professional, cinematic lighting, smooth motion, no on-screen text, no audio.'
    );
    const fallbackPrompt = fallbackLines.join('\n');

    /* 1. Apriamo il modal subito con stato "analisi in corso" (UI
       responsive). Lo stage va a 'extracting' mentre raccogliamo
       frame multipli + context strutturato dalla pagina. */
    setAiMode('text2video');
    setAiPrompt('');
    setAiSourceImage('');
    setAiContextText(currentAlt || pageTitle || '');
    setAiVideoLoop(true);
    setAiError('');
    setAiRevisedPrompt('');
    setShowAiPanel(false);
    setSwipeAutoMode(false);
    setSwipeVisionLoading(true);
    setSwipeVisionMode(null);
    setSwipeVisionIntent('');
    setSwipeVisionError('');
    setSwipeExtraGuidance('');
    setSwipeAnalysis('');
    setSwipeBigIdea('');
    setSwipeTargetAudience('');
    setSwipeNegativePrompt('');
    setSwipeFramesUsed(0);
    setSwipeStage('extracting');
    setSwipeMediaKind('video');
    setShowAiImagePopup(true);

    /* 2. Estraggo in parallelo: 3 frame del video sorgente +
       surrounding context (heading, paragrafo, CTA, posizione).
       Frame extraction richiede 3-8s per video normali; il context
       arriva in <1.5s. extractVideoFrames può ritornare [] in caso
       di CORS. */
    const [videoFrames, surroundingContext] = await Promise.all([
      videoSrc ? extractVideoFrames(videoSrc, 3) : Promise.resolve<string[]>([]),
      requestSwipeContext(),
    ]);

    /* 2b. Fallback: se l'estrazione frame del video è fallita (CORS o
       no src) ma esiste il poster, estraggo il poster come dataURL via
       canvas. Stessa logica delle immagini: il browser HA il poster in
       cache dal preview iframe, quindi è molto affidabile. */
    let posterFrames = videoFrames;
    if (posterFrames.length === 0 && posterUrl) {
      const posterDataUrl = await extractImageAsDataUrl(posterUrl, 1280, 0.85);
      if (posterDataUrl) posterFrames = [posterDataUrl];
    }

    /* 3. Salvataggio context completo nel ref per "Rigenera prompt". */
    swipeAnalysisCtxRef.current = {
      mediaKind: 'video',
      sourceImageUrl: posterUrl,
      posterFrames,
      surroundingContext,
      currentAlt,
      pageTitle: pageTitle || '',
      productName,
      productDesc,
      productBrief,
      fallbackPrompt,
    };

    /* autoFire: false → dopo l'analisi NON parte la generazione automatica.
       L'utente legge il prompt suggerito da Claude, eventualmente lo
       modifica nel textarea o usa i preset "Più drammatico / Più scientifico /
       …" e poi clicca manualmente "Genera Video (Swipe)". Questo evita
       di consumare crediti Seedance su un prompt che l'utente non ha mai
       visto. */
    await runSwipeAnalysis({ extraGuidance: '', autoFire: false });
  }, [
    selectedElement,
    effectiveProduct,
    pageTitle,
    runSwipeAnalysis,
    requestSwipeContext,
  ]);

  /* ── Swipe Image for Product ──
   * Equivalente di handleSwipeVideoForProduct ma per <img>: usa
   * text-to-image (Nano Banana 2 / FLUX / GPT Image) invece di T2V.
   * Stesso modal, stessa UX. Claude analizza l'immagine competitor e
   * propone un prompt che mostra il MECCANISMO del nostro prodotto e/o
   * la trasformazione promessa dal brief, evitando il "packshot su
   * sfondo bianco" generico. */
  const handleSwipeImageForProduct = useCallback(async () => {
    if (!selectedElement || selectedElement.tagName !== 'img') return;

    const currentAlt = String(selectedElement.alt || '').trim();
    const imageSrc = String(selectedElement.src || '').trim();

    const productName = (effectiveProduct?.name || '').trim();
    const productDesc = (effectiveProduct?.description || '').trim();
    const productBrief = (effectiveProduct?.brief || '').trim().slice(0, 600);

    /* Fallback prompt T2I — scegli automaticamente split-frame se l'alt
       suggerisce before/after, altrimenti hero con hint del meccanismo. */
    const altLower = currentAlt.toLowerCase();
    const looksLikeBeforeAfter =
      /before|after|prima|dopo|transformation|trasformaz/i.test(altLower);
    const fallbackLines: string[] = [];
    if (looksLikeBeforeAfter) {
      fallbackLines.push(
        productName
          ? `Photorealistic split-frame promotional image for ${productName}.`
          : 'Photorealistic split-frame promotional image for our product.'
      );
      if (productDesc) fallbackLines.push(`What it is: ${productDesc}.`);
      if (productBrief) fallbackLines.push(`Brief snippet: ${productBrief}`);
      fallbackLines.push(
        'Left half: the SAME person experiencing the problem the product solves (matching the original framing/mood).'
      );
      fallbackLines.push(
        'Right half: the SAME person, same pose, same framing and lighting, after the transformation promised by the brief (e.g. slimmer, pain-free, confident).'
      );
      fallbackLines.push(
        'Visualize the unique mechanism subtly between the two halves (a glow, audio waves, energy flow — match the brief).'
      );
    } else {
      fallbackLines.push(
        productName
          ? `Photorealistic hero image for ${productName}.`
          : 'Photorealistic hero image for our product.'
      );
      if (productDesc) fallbackLines.push(`What it is: ${productDesc}.`);
      if (productBrief) fallbackLines.push(`Brief snippet: ${productBrief}`);
      if (currentAlt) fallbackLines.push(`Original image context (keep the same persuasive intent): "${currentAlt}".`);
      fallbackLines.push(
        'Show the product naturally integrated in a real-world scene, with a subtle visual cue of its unique mechanism (e.g. glowing audio waves around the head, a soft halo of energy, a delicate infographic overlay) — the mechanism must be hinted at visually, not just implied.'
      );
    }
    fallbackLines.push(
      'Photorealistic, sharp focus, professional studio lighting, clean composition, no on-image text, no competitor logos.'
    );
    const fallbackPrompt = fallbackLines.join('\n');

    setAiMode('text2image');
    setAiPrompt('');
    setAiSourceImage('');
    setAiContextText(currentAlt || pageTitle || '');
    setAiError('');
    setAiRevisedPrompt('');
    setShowAiPanel(false);
    setSwipeAutoMode(false);
    setSwipeVisionLoading(true);
    setSwipeVisionMode(null);
    setSwipeVisionIntent('');
    setSwipeVisionError('');
    setSwipeExtraGuidance('');
    setSwipeAnalysis('');
    setSwipeBigIdea('');
    setSwipeTargetAudience('');
    setSwipeNegativePrompt('');
    setSwipeFramesUsed(0);
    setSwipeStage('extracting');
    setSwipeMediaKind('image');
    setShowAiImagePopup(true);

    /* Recupero in parallelo:
       - context strutturato (heading vicino, paragrafo, CTA, posizione)
       - dataURL dell'immagine SORGENTE estratta lato client (fallback
         per quando il server non riesce a fetcharla per CORS / UA block /
         URL relativo non risolvibile server-side). */
    const [surroundingContext, imageDataUrl] = await Promise.all([
      requestSwipeContext(),
      imageSrc ? extractImageAsDataUrl(imageSrc, 1280, 0.85) : Promise.resolve<string | null>(null),
    ]);

    swipeAnalysisCtxRef.current = {
      mediaKind: 'image',
      sourceImageUrl: imageSrc,
      /* Riusiamo posterFrames anche per le immagini: 0 o 1 elemento. */
      posterFrames: imageDataUrl ? [imageDataUrl] : [],
      surroundingContext,
      currentAlt,
      pageTitle: pageTitle || '',
      productName,
      productDesc,
      productBrief,
      fallbackPrompt,
    };

    /* autoFire: false → dopo l'analisi NON parte la generazione automatica.
       Stessa logica dello Swipe Video: l'utente vede il prompt T2I che
       Claude ha generato, può modificarlo o rifinire con guidance, e POI
       clicca "Genera Immagine". */
    await runSwipeAnalysis({ extraGuidance: '', autoFire: false });
  }, [
    selectedElement,
    effectiveProduct,
    pageTitle,
    runSwipeAnalysis,
    requestSwipeContext,
  ]);

  /* Auto-fire della generazione quando "Swipe for Product" parte in
   * modalità automatica. Per text-to-video basta avere il prompt; per
   * image-to-video servirebbe anche aiSourceImage (oggi però lo Swipe
   * usa sempre text2video, quindi qui ci appoggiamo solo al prompt).
   * Aspettiamo un frame in modo che il modal abbia il tempo di
   * renderizzare lo state di loading prima che il job parta sul main
   * thread. */
  useEffect(() => {
    if (!swipeAutoMode) return;
    if (!showAiImagePopup) return;
    if (!aiPrompt.trim()) return;
    if (swipeVisionLoading) return;
    if (aiGenerating) return;
    if (aiMode === 'image2image' || aiMode === 'image2video') {
      if (!aiSourceImage) return;
    }

    const t = window.setTimeout(() => {
      // Consume the auto-mode token so successive opens of the modal
      // (manual generation, retry) don't accidentally re-trigger.
      setSwipeAutoMode(false);
      handleAiGenerate();
    }, 250);
    return () => window.clearTimeout(t);
  }, [
    swipeAutoMode,
    showAiImagePopup,
    aiPrompt,
    aiMode,
    aiSourceImage,
    swipeVisionLoading,
    aiGenerating,
    handleAiGenerate,
  ]);

  // Se l'utente chiude il modal manualmente prima che parta il job auto,
  // azzeriamo la flag così la prossima apertura è "manuale" e non
  // triggera generazioni non richieste.
  useEffect(() => {
    if (!showAiImagePopup && swipeAutoMode) setSwipeAutoMode(false);
  }, [showAiImagePopup, swipeAutoMode]);

  // Apre il file picker, carica il video, e SOLO dopo l'upload sostituisce
  // l'iframe selezionato con un <video> nativo che ha gia' src valido.
  // Se l'utente annulla la finestra di scelta file, l'iframe non viene
  // toccato (cosi' non si rischia di rimanere con un placeholder vuoto
  // che "lampeggia" senza src in produzione).
  const handleIframeToVideoUpload = useCallback(() => {
    if (uploading) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.onchange = async (ev) => {
      const f = (ev.target as HTMLInputElement).files?.[0];
      if (!f) return;
      setUploading(true);
      setUploadError('');
      try {
        const publicUrl = await directSupabaseUpload(f);
        sendToIframe({ type: 'cmd-convert-iframe-to-video', src: publicUrl });
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    };
    input.click();
  }, [uploading, sendToIframe]);

  /* ── AI Code Edit Handler ── */
  const handleAiEdit = useCallback(async () => {
    if (!aiEditPrompt.trim() || aiEditRunning) return;
    setAiEditRunning(true);
    setAiEditError('');
    setAiEditProgress(null);

    try {
      const res = await fetch('/api/ai-edit-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: editorViewport === 'mobile' && mobileHtml ? mobileHtml : currentHtml,
          prompt: aiEditPrompt,
          model: aiEditModel,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Network error' }));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('Stream not available');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));

            switch (data.type) {
              case 'chunk-start':
                setAiEditProgress({
                  chunkIndex: data.chunkIndex,
                  totalChunks: data.totalChunks,
                  label: data.label || `Chunk ${data.chunkIndex + 1}`,
                });
                break;
              case 'chunk-done':
                break;
              case 'result':
                if (data.html) {
                  setIframeVersion(v => v + 1);
                  if (editorViewport === 'mobile' && mobileHtml) {
                    setAiEditHistory(prev => [...prev, mobileHtml]);
                    setMobileHtml(data.html);
                    setMobileCodeHtml(data.html);
                  } else {
                    setAiEditHistory(prev => [...prev, currentHtml]);
                    setCurrentHtml(data.html);
                    setCodeHtml(data.html);
                    pushUndo(data.html);
                  }
                }
                break;
              case 'error':
                throw new Error(data.error);
              case 'done':
                break;
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== 'done') {
              if (!parseErr.message.includes('Unexpected')) throw parseErr;
            }
          }
        }
      }
    } catch (err) {
      setAiEditError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setAiEditRunning(false);
      setAiEditProgress(null);
    }
  }, [aiEditPrompt, aiEditModel, aiEditRunning, currentHtml, pushUndo]);

  const handleAiEditUndo = useCallback(() => {
    if (aiEditHistory.length === 0) return;
    setIframeVersion(v => v + 1);
    const prev = aiEditHistory[aiEditHistory.length - 1];
    setAiEditHistory(h => h.slice(0, -1));
    if (editorViewport === 'mobile' && mobileHtml) {
      setMobileHtml(prev);
      setMobileCodeHtml(prev);
    } else {
      setCurrentHtml(prev);
      setCodeHtml(prev);
      pushUndo(prev);
    }
  }, [aiEditHistory, editorViewport, mobileHtml, pushUndo]);

  /* ── Brand Colors: estrazione palette ──
   * Chiamata SUBITO all'apertura del panel. Prima prova hex nel brief, poi
   * fallback su Gemini (text o vision). Se non c'è materiale, alza il flag
   * brandNeedsImage e lascia all'utente l'upload manuale. */
  const runBrandExtract = useCallback(async (overrideImageUrl?: string) => {
    setBrandExtractRunning(true);
    setBrandExtractError('');
    setBrandNeedsImage(false);
    try {
      const res = await fetch('/api/extract-brand-colors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief: effectiveProduct?.brief || '',
          marketResearch: effectiveProduct?.marketResearch || '',
          productName: effectiveProduct?.name || '',
          productDescription: effectiveProduct?.description || '',
          imageUrl: overrideImageUrl || brandUploadedImageUrl || effectiveProduct?.imageUrl || '',
        }),
      });

      // Gestione difensiva: se la function timeoutta o crasha, Netlify
      // restituisce una pagina HTML d'errore (5xx con content-type text/html)
      // e res.json() exploderebbe con "Unexpected token '<'…".
      // Leggiamo prima come testo e proviamo a parsarlo come JSON.
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      const rawText = await res.text();
      let data: { ok?: boolean; palette?: BrandPalette; error?: string; needsImage?: boolean } | null = null;

      if (ctype.includes('application/json')) {
        try {
          data = JSON.parse(rawText);
        } catch {
          // body è HTML pure se Content-Type dice JSON (raro, capita con proxy malformati)
          data = null;
        }
      } else {
        try { data = JSON.parse(rawText); } catch { /* lascia null */ }
      }

      if (!data) {
        // Body non-JSON (HTML d'errore di Netlify, gateway timeout, ecc.)
        const isTimeout = res.status === 504 || res.status === 408 || /timeout/i.test(rawText);
        setBrandExtractError(
          isTimeout
            ? `Server timed out (${res.status}). The product image may be too slow to fetch or analyze. Try again or upload a smaller photo.`
            : `Server returned an unexpected response (HTTP ${res.status}). Try again or hard-refresh the page (Ctrl+Shift+R).`,
        );
        return;
      }

      if (!res.ok || !data.ok) {
        if (data?.needsImage) {
          setBrandNeedsImage(true);
          setBrandExtractError(data.error || 'No brief/research available. Upload a product photo.');
        } else {
          setBrandExtractError(data?.error || `HTTP ${res.status}`);
        }
        return;
      }

      setBrandPalette(data.palette as BrandPalette);
    } catch (err) {
      setBrandExtractError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBrandExtractRunning(false);
    }
  }, [effectiveProduct, brandUploadedImageUrl]);

  // Auto-run quando l'utente apre il panel la prima volta (e non c'è già una palette).
  useEffect(() => {
    if (showBrandColorsPanel && !brandPalette && !brandExtractRunning && !brandExtractError && !brandNeedsImage) {
      void runBrandExtract();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBrandColorsPanel]);

  /* ── Brand Colors: upload foto prodotto (quando manca brief+imageUrl) ── */
  const handleBrandImageUpload = useCallback(async (file: File) => {
    setBrandExtractError('');
    setBrandExtractRunning(true);
    try {
      const url = await directSupabaseUpload(file);
      setBrandUploadedImageUrl(url);
      setBrandNeedsImage(false);
      await runBrandExtract(url);
    } catch (err) {
      setBrandExtractError(err instanceof Error ? err.message : 'Upload failed');
      setBrandExtractRunning(false);
    }
  }, [runBrandExtract]);

  /* ── Brand Colors: applica la palette via swap deterministico server-side ──
   *
   * Prima usavamo /api/ai-edit-html (Claude chunked) ma su landing > 80 KB
   * il numero di chunk × tempo per chunk superava il timeout Netlify (300s)
   * e il browser mostrava un generico "network error".
   *
   * Adesso il ricolore è fatto da /api/recolor-page: estrae tutti i token
   * colore dell'HTML (hex / rgb / named), per ognuno sceglie il role della
   * palette più vicino in spazio HSL, e fa lo swap. Risultato deterministico,
   * istantaneo (<1s anche su pagine da 1 MB), nessuna dipendenza da LLM
   * keys/quota/timeout. */
  const handleApplyBrandColors = useCallback(async () => {
    if (!brandPalette || brandApplying) return;
    setBrandApplying(true);
    setBrandExtractError('');
    try {
      const targetHtml = editorViewport === 'mobile' && mobileHtml ? mobileHtml : currentHtml;

      // Recolouring runs ENTIRELY in the browser — no network call.
      //
      // Why: the previous implementation POSTed the full HTML to
      // /api/recolor-page, which on heavy cloned landings (>6MB after
      // inline base64 images) hit Netlify's hard 6MB request-body cap.
      // Netlify rejected the request with its own HTML 500 page and the
      // user saw "Server returned non-JSON (HTTP 500)". The route is
      // 100% deterministic (no LLM, no DB), so calling the shared lib
      // directly is functionally identical AND removes the size cliff.
      //
      // We use a microtask yield so React paints the "Applying…" state
      // before the (sync, ~50–500ms on a big page) recolouring blocks
      // the main thread.
      await new Promise<void>((r) => setTimeout(r, 0));

      let result: ReturnType<typeof recolorPage>;
      try {
        result = recolorPage(targetHtml, {
          primary: brandPalette.primary,
          secondary: brandPalette.secondary,
          accent: brandPalette.accent,
          background: brandPalette.background,
          text: brandPalette.text,
        });
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : 'Recolour failed');
      }

      const nextHtml = result.html;

      setIframeVersion(v => v + 1);
      if (editorViewport === 'mobile' && mobileHtml) {
        setAiEditHistory(prev => [...prev, mobileHtml]);
        setMobileHtml(nextHtml);
        setMobileCodeHtml(nextHtml);
      } else {
        setAiEditHistory(prev => [...prev, currentHtml]);
        setCurrentHtml(nextHtml);
        setCodeHtml(nextHtml);
        pushUndo(nextHtml);
      }

      setShowBrandColorsPanel(false);
    } catch (err) {
      setBrandExtractError(err instanceof Error ? err.message : 'Unknown error applying palette');
    } finally {
      setBrandApplying(false);
      setAiEditProgress(null);
    }
  }, [brandPalette, brandApplying, editorViewport, mobileHtml, currentHtml, pushUndo]);

  /* ── Element AI Chat — image upload/paste ── */
  const elAiFileRef = useRef<HTMLInputElement>(null);
  const [elAiUploading, setElAiUploading] = useState(false);

  const handleElAiImageUpload = useCallback(async (file: File) => {
    if (elAiUploading) return;
    setElAiUploading(true);
    try {
      const publicUrl = await directSupabaseUpload(file);
      if (selectedElement?.tagName === 'img') {
        setAttr('src', publicUrl);
        setAttr('alt', file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '));
        setElAiMessages(prev => [...prev,
          { role: 'user', content: `📎 Uploaded: ${file.name}` },
          { role: 'assistant', content: `Done! Image replaced with uploaded file.` },
        ]);
      } else {
        setElAiInput(prev => prev + (prev ? ' ' : '') + publicUrl);
        setElAiMessages(prev => [...prev,
          { role: 'user', content: `📎 Uploaded: ${file.name} → ${publicUrl}` },
        ]);
      }
    } catch (err) {
      setElAiMessages(prev => [...prev, { role: 'assistant', content: `Upload error: ${err instanceof Error ? err.message : 'Failed'}` }]);
    } finally {
      setElAiUploading(false);
    }
  }, [elAiUploading, selectedElement, setAttr]);

  const handleElAiPaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (file) handleElAiImageUpload(file);
    }
  }, [handleElAiImageUpload]);

  /* ── Element AI Chat Handler ── */
  const handleElAiSend = useCallback(async () => {
    if (!elAiInput.trim() || elAiLoading) return;
    const instruction = elAiInput.trim();
    setElAiInput('');
    setElAiMessages(prev => [...prev, { role: 'user', content: instruction }]);
    setElAiLoading(true);

    let elementHtml: string | null = null;
    if (selectedElement) {
      elAiPendingRef.current = null;
      sendToIframe({ type: 'cmd-get-element-html-for-ai' });
      await new Promise(r => setTimeout(r, 200));
      let attempts = 0;
      while (!elAiPendingRef.current && attempts < 20) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }
      elementHtml = elAiPendingRef.current;
    }

    try {
      const res = await fetch('/api/ai-edit-element', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elementHtml: elementHtml || undefined,
          instruction,
        }),
      });
      // Parsing robusto: in caso di timeout del gateway (Netlify/Vercel
      // chiudono la funzione dopo pochi secondi) o errore 5xx, il server
      // risponde con una PAGINA HTML d'errore, non JSON. Senza questo
      // controllo `res.json()` lanciava "Unexpected token '<'".
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('application/json')) {
        const text = await res.text().catch(() => '');
        const isTimeout = res.status === 504 || res.status === 502 || res.status === 408 || res.status === 524;
        const looksHtml = /^\s*<(?:!doctype|html|head|body)/i.test(text);
        throw new Error(
          isTimeout || (looksHtml && res.status >= 500)
            ? 'The server took too long and timed out. Try again, maybe with a simpler request or on a smaller element.'
            : looksHtml
              ? `The server returned an error page (HTTP ${res.status}). Try again shortly.`
              : (text.slice(0, 200) || `HTTP error ${res.status}`),
        );
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (data.scope === 'page') {
        const { action, target, code } = data;
        if (!target || !code) throw new Error('Invalid page-level response');
        setIframeVersion(v => v + 1);
        pushUndo(currentHtml);
        let newHtml = currentHtml;
        const targetIdx = newHtml.toLowerCase().indexOf(target.toLowerCase());
        if (targetIdx === -1) {
          throw new Error(`Could not find "${target}" in the page`);
        }
        const actualTarget = newHtml.substring(targetIdx, targetIdx + target.length);
        if (action === 'insert_before') {
          newHtml = newHtml.substring(0, targetIdx) + code + '\n' + newHtml.substring(targetIdx);
        } else if (action === 'insert_after') {
          newHtml = newHtml.substring(0, targetIdx + actualTarget.length) + '\n' + code + newHtml.substring(targetIdx + actualTarget.length);
        } else if (action === 'replace') {
          newHtml = newHtml.substring(0, targetIdx) + code + newHtml.substring(targetIdx + actualTarget.length);
        }
        setCurrentHtml(newHtml);
        setElAiMessages(prev => [...prev, { role: 'assistant', content: `Done! Inserted ${action === 'insert_before' ? 'before' : action === 'insert_after' ? 'after' : 'replacing'} ${target}` }]);
      } else {
        if (elementHtml) {
          sendToIframe({ type: 'cmd-replace-outer-html', html: data.html });
        }
        setElAiMessages(prev => [...prev, { role: 'assistant', content: 'Done!' }]);
      }
    } catch (err) {
      setElAiMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : 'Unknown'}` }]);
    } finally {
      setElAiLoading(false);
    }
  }, [elAiInput, elAiLoading, selectedElement, sendToIframe, currentHtml, pushUndo]);

  useEffect(() => {
    elAiChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [elAiMessages, elAiLoading]);

  useEffect(() => {
    setElAiMessages([]);
  }, [selectedElement?.path]);

  /* ── Keyboard shortcuts ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && codeSearchOpen) { setCodeSearchOpen(false); setCodeSearchTerm(''); setCodeSearchCount(0); return; }
      if (e.key === 'Escape' && mode !== 'visual') { handleSwitchMode('visual'); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && mode === 'code') { e.preventDefault(); setCodeSearchOpen(true); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'h' && mode === 'code') { e.preventDefault(); setCodeSearchOpen(true); setCodeShowReplace(true); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) { e.preventDefault(); handleRedo(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'y') { e.preventDefault(); handleRedo(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); handleSave(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const activeHtml = editorViewport === 'mobile' && mobileHtml ? mobileHtml : currentHtml;

  // Only recompute srcDoc when we explicitly need to reload the iframe (undo/redo/AI edit/viewport switch)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableSrcDoc = useMemo(() => prepareEditorHtml(activeHtml, sourceUrl), [iframeVersion, editorViewport, sourceUrl]);
  const el = selectedElement;

  // Preview mode: il <iframe srcDoc={activeHtml}> esegue TUTTI gli script
  // della landing (jQuery, Swiper, embed YouTube, fallback diag, etc.)
  // sincronamente al mount, bloccando il main thread per centinaia di ms.
  // Per non far percepire un "freeze" all'utente, prima mostriamo uno
  // spinner (30ms - 1 frame); solo dopo montiamo l'iframe.
  // - Lo srcDoc e' uno SNAPSHOT preso al momento dell'ingresso in preview
  //   (previewSnapshot), cosi' modifiche a currentHtml/mobileHtml in
  //   background non causano reload dell'iframe (re-parsing di megabytes).
  const [previewReady, setPreviewReady] = useState(false);
  const [previewSnapshot, setPreviewSnapshot] = useState('');
  useEffect(() => {
    if (mode !== 'preview') {
      setPreviewReady(false);
      return;
    }
    setPreviewReady(false);
    // Inietta il toggler universale FAQ/accordion: nello snapshot statico
    // gli script originali del clone sono spesso rotti, quindi senza questo
    // le FAQ restano chiuse e non cliccabili in Preview (mentre in live mode
    // funzionano perché è il sito reale). Best-effort: se l'import fallisce
    // usiamo l'HTML grezzo.
    let cancelled = false;
    setPreviewSnapshot(activeHtml);
    void (async () => {
      try {
        const { injectInteractivityRescue } = await import('@/lib/spa-rescue');
        const { unbakeDynamicComments } = await import('@/lib/bake-dynamic-comments');
        const { detectDynamicScripts, reattachDynamicScripts } = await import('@/lib/detect-dynamic-scripts');
        // I commenti live vengono "cotti" come DOM statico per l'editing e
        // l'iframe di editing serializza SENZA script. Per l'anteprima:
        //  1) ri-attacchiamo il motore dagli script originali (initialHtml),
        //  2) ricostruiamo l'array TIMED dal DOM statico (col testo modificato)
        //     rimuovendo i nodi statici,
        //  3) teniamo gli script, così il motore ri-anima i commenti "a tempo".
        // No-op sulle pagine senza quel motore.
        const withEngine = reattachDynamicScripts(initialHtml, activeHtml);
        const unbaked = unbakeDynamicComments(withEngine).html;
        const keepScripts = detectDynamicScripts(unbaked).functional;
        if (!cancelled) {
          const rescued = injectInteractivityRescue(unbaked, { keepScripts });
          // Fix scroll in preview: quando teniamo gli script, il player video
          // (es. Vidalytics) inietta un <iframe> che copre gran parte del
          // viewport e "cattura" la rotella del mouse, impedendo di scorrere
          // fino ai commenti sotto. Garantiamo lo scroll verticale e rendiamo
          // gli iframe dei video trasparenti alla rotella (pointer-events:none).
          // Solo per l'anteprima: non tocca l'HTML salvato/pubblicato.
          setPreviewSnapshot(keepScripts ? injectPreviewScrollFix(rescued) : rescued);
        }
      } catch { /* fallback già impostato sopra */ }
    })();
    const t = setTimeout(() => setPreviewReady(true), 30);
    return () => { cancelled = true; clearTimeout(t); };
    // Volutamente NO dependency su activeHtml: lo snapshot si fa solo
    // quando si entra in preview mode. Per "ricaricare" l'utente puo'
    // tornare a Visual e ri-cliccare Preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /* ── Close handler ──
   * Smontare l'editor sincronicamente blocca il main thread per ~1-2s su
   * pagine grandi (Swiper + jQuery + DOM clonato): React deve fare il
   * teardown di un iframe con migliaia di nodi e di tutti gli script
   * attivi al suo interno.
   *
   * Workaround: appena clicco la X mostro un overlay "Closing…" (paint
   * immediato dell'overlay), poi su rAF svuoto le srcDoc degli iframe
   * (reset su DOM vuoto = teardown rapido), e SOLO DOPO chiamo onClose.
   * Cosi' l'utente vede subito feedback e React smonta nodi gia' leggeri.
   */
  const [closing, setClosing] = useState(false);
  const handleClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    requestAnimationFrame(() => {
      try {
        if (iframeRef.current) {
          iframeRef.current.srcdoc = '<!doctype html><html><body></body></html>';
        }
      } catch { /* iframe gia' detached */ }
      setTimeout(() => onClose(), 0);
    });
  }, [closing, onClose]);

  /* ── Viewport switch (Desktop ↔ Mobile) ──
   * Stesso problema del close: cambiare editorViewport fa cambiare la
   * `key` dell'<iframe srcDoc=...>, React lo remounta nello stesso
   * commit e il browser parsa sincronicamente la nuova srcDoc (pesante:
   * Swiper, jQuery, centinaia di nodi). Senza yield al browser, la UI
   * freeza per 1-2s prima che lo spinner appaia.
   *
   * Fix:
   *   1) flippa `switchingViewport=true` + `editorReady=false` → React
   *      rerender SOLO con l'overlay (l'iframe ha ancora il vecchio key,
   *      quindi non remounta) → il browser dipinge lo spinner.
   *   2) su rAF svuoto la srcDoc del vecchio iframe (teardown leggero
   *      del DOM grande prima del remount).
   *   3) su setTimeout(0) cambio davvero editorViewport: il key cambia,
   *      l'iframe remounta, il parser blocca il main thread MA stavolta
   *      l'overlay e' gia' visibile.
   *   4) il messaggio 'editor-ready' dall'iframe nuova clearera' il flag.
   */
  const [switchingViewport, setSwitchingViewport] = useState(false);
  const handleSwitchViewport = useCallback((next: 'desktop' | 'mobile') => {
    if (next === editorViewport || switchingViewport) return;
    setSwitchingViewport(true);
    setEditorReady(false);
    requestAnimationFrame(() => {
      try {
        if (iframeRef.current) {
          iframeRef.current.srcdoc = '<!doctype html><html><body></body></html>';
        }
      } catch { /* iframe detached */ }
      setTimeout(() => {
        setEditorViewport(next);
        // Defensive: l'iframe potrebbe non rispondere con 'editor-ready'
        // (es. errori di parsing). Sgancia il flag dopo 4s comunque.
        setTimeout(() => setSwitchingViewport(false), 4000);
      }, 0);
    });
  }, [editorViewport, switchingViewport]);

  /* ── Mode switch (Visual / Code / Preview) ──
   * Stessa root-cause: entrare in `visual` o `preview` monta un iframe
   * con la srcDoc completa (HTML clonato + Swiper + jQuery), che il
   * browser parsa sincronicamente nello stesso commit React → freeze
   * 1-2s. visual ↔ code in piu' bumpa `iframeVersion` per forzare il
   * remount dell'iframe e prendere le modifiche fatte in code mode.
   *
   * Wrappo switchMode con lo stesso pattern di handleSwitchViewport:
   * overlay-first paint, poi defer del cambio mode. visual→code (e
   * preview→code) sono leggeri ma li gestisce comunque la stessa
   * funzione: lo spinner si vedra' per ~1 frame, niente di grave.
   */
  const [switchingMode, setSwitchingMode] = useState(false);
  const handleSwitchMode = useCallback((newMode: EditorMode) => {
    if (newMode === mode || switchingMode) return;
    const willMountIframe = newMode === 'visual' || newMode === 'preview';
    if (!willMountIframe) {
      // Verso 'code' nessun iframe pesante da montare → switch diretto.
      switchMode(newMode);
      return;
    }
    setSwitchingMode(true);
    if (newMode === 'visual') setEditorReady(false);
    requestAnimationFrame(() => {
      try {
        if (iframeRef.current) {
          iframeRef.current.srcdoc = '<!doctype html><html><body></body></html>';
        }
      } catch { /* iframe detached */ }
      setTimeout(() => {
        switchMode(newMode);
        // Per 'preview' c'e' gia' un setTimeout(30) interno che imposta
        // previewReady → l'overlay locale di preview gestisce la sua
        // attesa. Per 'visual' aspettiamo 'editor-ready' o 4s defensivi.
        setTimeout(() => setSwitchingMode(false), newMode === 'visual' ? 4000 : 200);
      }, 0);
    });
  }, [mode, switchingMode, switchMode]);

  // Defensive fallback: se l'iframe non risponde con 'editor-ready' entro
  // un budget ragionevole, sblocchiamo comunque l'overlay. Succede quando
  // l'HTML clonato contiene <script src="..."> parser-blocking che non
  // finiscono in tempo (CDN lento, broken script) o uno script della
  // pagina originale che fa document.write/redirect distruttivo. Senza
  // questo timeout l'utente vede "Loading editor..." in eterno.
  //
  // Deve stare DOPO le dichiarazioni di switchingViewport, switchingMode
  // e setSwitchingMode (riga ~2580+), altrimenti TDZ -> "Cannot access
  // 'lc' before initialization" in produzione (Next.js minified bundle).
  useEffect(() => {
    if (editorReady || switchingViewport || restoringHistory) return;
    const t = setTimeout(() => {
      console.warn('[VisualHtmlEditor] editor-ready timeout (8s) — forcing ready');
      setEditorReady(true);
      setSwitchingViewport(false);
      setSwitchingMode(false);
      setRestoringHistory(false);
    }, 8000);
    return () => clearTimeout(t);
  }, [editorReady, switchingViewport, restoringHistory, iframeVersion]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-white">
      {/* Overlay mostrato durante il close per dare feedback immediato
          mentre svuotiamo l'iframe e prima che React smonti l'editor. */}
      {closing && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/85 backdrop-blur-sm">
          <div className="flex items-center gap-3 px-5 py-3 rounded-lg bg-slate-800 text-white text-sm font-medium shadow-2xl border border-slate-700">
            <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
            Closing editor…
          </div>
        </div>
      )}

      {/* ═══ Top Bar ═══ */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900 text-white shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/20">
            <Paintbrush className="h-4 w-4 text-amber-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-bold truncate">{pageTitle || 'Visual Editor'}</h2>
            <p className="text-[10px] text-slate-400">
              {mode === 'visual' ? 'Click to select · Double click to edit text' :
               mode === 'code' ? 'Edit HTML code directly' : 'Final preview'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Undo/Redo */}
          <div className="flex items-center gap-0.5 mr-2">
            <button onClick={handleUndo} disabled={!canUndo || restoringHistory}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-wait transition-colors" title="Undo (Ctrl+Z)">
              <Undo2 className="h-4 w-4" />
            </button>
            <button onClick={handleRedo} disabled={!canRedo || restoringHistory}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-wait transition-colors" title="Redo (Ctrl+Shift+Z)">
              <Redo2 className="h-4 w-4" />
            </button>
          </div>

          {/* Mode switcher */}
          <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5">
            {([['visual', Paintbrush, 'Visual'], ['code', Code, 'Code'], ['preview', Eye, 'Preview']] as const).map(([m, Icon, label]) => (
              <button key={m} onClick={() => handleSwitchMode(m)} disabled={switchingMode}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-wait ${
                  mode === m ? 'bg-amber-500 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-700'
                }`}>
                <Icon className="h-3.5 w-3.5" />{label}
              </button>
            ))}
          </div>

          {/* Viewport Switcher (Desktop/Mobile) */}
          <div className="w-px h-6 bg-slate-700 mx-1" />
          <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5">
            <button
              onClick={() => handleSwitchViewport('desktop')}
              disabled={switchingViewport}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-wait ${
                editorViewport === 'desktop'
                  ? 'bg-blue-500 text-white shadow'
                  : 'text-slate-400 hover:text-white hover:bg-slate-700'
              }`}
            >
              <Monitor className="h-3.5 w-3.5" />Desktop
            </button>
            <button
              onClick={() => handleSwitchViewport('mobile')}
              disabled={switchingViewport}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-wait ${
                editorViewport === 'mobile'
                  ? 'bg-blue-500 text-white shadow'
                  : 'text-slate-400 hover:text-white hover:bg-slate-700'
              }`}
            >
              <Smartphone className="h-3.5 w-3.5" />Mobile
            </button>
          </div>

          <div className="w-px h-6 bg-slate-700 mx-1" />

          {/* AI Edit Toggle */}
          <button
            onClick={() => setShowAiEditPanel(!showAiEditPanel)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              showAiEditPanel
                ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-lg shadow-violet-500/30'
                : aiEditRunning
                  ? 'bg-violet-500/20 text-violet-300 animate-pulse'
                  : 'bg-slate-800 text-violet-300 hover:bg-violet-600/30 hover:text-violet-200'
            }`}
            title="AI Editor - Edit with AI"
          >
            <Bot className="h-4 w-4" />
            <span className="hidden sm:inline">AI Editor</span>
            {aiEditRunning && <Loader2 className="h-3 w-3 animate-spin" />}
          </button>

          {/* Brand Colors Toggle ──
              Estrae automaticamente una palette dal brief / market research del
              Project; se non bastano, usa la foto prodotto (logo[0].url); se
              manca anche quella, chiede all'utente di caricarne una.  Poi
              ricolora TUTTA la pagina via /api/ai-edit-html. */}
          <button
            onClick={() => setShowBrandColorsPanel(!showBrandColorsPanel)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              showBrandColorsPanel
                ? 'bg-gradient-to-r from-pink-500 via-fuchsia-500 to-orange-400 text-white shadow-lg shadow-fuchsia-500/30'
                : brandApplying || brandExtractRunning
                  ? 'bg-fuchsia-500/20 text-fuchsia-200 animate-pulse'
                  : 'bg-slate-800 text-fuchsia-300 hover:bg-fuchsia-600/30 hover:text-fuchsia-200'
            }`}
            title="Brand Colors — recolor the whole page using the brief / market research / product photo"
          >
            <Palette className="h-4 w-4" />
            <span className="hidden sm:inline">Brand Colors</span>
            {(brandApplying || brandExtractRunning) && <Loader2 className="h-3 w-3 animate-spin" />}
          </button>

          {/* Tracking snippet — apre il popup per incollare URL o tag
              completo (Meta Pixel, GA4, custom tracker, ...) che viene
              iniettato subito dopo <head>. Idempotente sul re-apply. */}
          <button
            onClick={() => {
              setTrackingError(null);
              setTrackingApplied(false);
              setShowTrackingDialog(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-800 text-emerald-300 hover:bg-emerald-600/30 hover:text-emerald-200 transition-all"
            title="Insert a tracking snippet right after <head>"
          >
            <Activity className="h-4 w-4" />
            <span className="hidden sm:inline">Tracking</span>
          </button>

          <div className="w-px h-6 bg-slate-700 mx-1" />

          {/* Actions */}
          <button onClick={handleCopy} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors" title="Copy HTML">
            <Copy className="h-4 w-4" />
          </button>
          <button onClick={handleDownload} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors" title="Download HTML">
            <Download className="h-4 w-4" />
          </button>
          <button onClick={handleSave}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              saved ? 'bg-emerald-500 text-white' : 'bg-amber-500 hover:bg-amber-400 text-white'}`}>
            {saved ? <><CheckCircle className="h-3.5 w-3.5" />Saved</> : <><Save className="h-3.5 w-3.5" />Save</>}
          </button>
          {onSaveToProject && (
            <button onClick={handleSaveToProject}
              title="Save this page to the Project / Funnel"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-all">
              <BookmarkPlus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Save to project</span>
            </button>
          )}
          <button onClick={handleClose} disabled={closing} className="ml-1 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors disabled:opacity-50 disabled:cursor-wait" title="Close editor">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* ═══ Formatting Toolbar (visual mode only) ═══ */}
      {mode === 'visual' && (
        <div className="flex items-center gap-1 px-4 py-1.5 bg-white border-b border-slate-200 shrink-0 flex-wrap">
          {/* Text Formatting */}
          <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
            <ToolBtn icon={Bold} title="Bold" onClick={() => execCmd('bold')} />
            <ToolBtn icon={Italic} title="Italic" onClick={() => execCmd('italic')} />
            <ToolBtn icon={Underline} title="Underline" onClick={() => execCmd('underline')} />
            <ToolBtn icon={Strikethrough} title="Strikethrough" onClick={() => execCmd('strikeThrough')} />
          </div>

          <div className="w-px h-6 bg-slate-200" />

          {/* Headings */}
          <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
            <ToolBtn icon={Heading1} title="Heading H1" onClick={() => execCmd('formatBlock', 'h1')} />
            <ToolBtn icon={Heading2} title="Heading H2" onClick={() => execCmd('formatBlock', 'h2')} />
            <ToolBtn icon={Heading3} title="Heading H3" onClick={() => execCmd('formatBlock', 'h3')} />
            <ToolBtn icon={Type} title="Paragraph" onClick={() => execCmd('formatBlock', 'p')} />
          </div>

          <div className="w-px h-6 bg-slate-200" />

          {/* Alignment */}
          <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
            <ToolBtn icon={AlignLeft} title="Align left" onClick={() => execCmd('justifyLeft')} />
            <ToolBtn icon={AlignCenter} title="Center" onClick={() => execCmd('justifyCenter')} />
            <ToolBtn icon={AlignRight} title="Align right" onClick={() => execCmd('justifyRight')} />
            <ToolBtn icon={AlignJustify} title="Justify" onClick={() => execCmd('justifyFull')} />
          </div>

          <div className="w-px h-6 bg-slate-200" />

          {/* Lists */}
          <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
            <ToolBtn icon={List} title="Bullet list" onClick={() => execCmd('insertUnorderedList')} />
            <ToolBtn icon={ListOrdered} title="Numbered list" onClick={() => execCmd('insertOrderedList')} />
          </div>

          <div className="w-px h-6 bg-slate-200" />

          {/* Colors */}
          <div className="flex items-center gap-1">
            <ColorPicker label="A" title="Text color" value={el ? rgbToHex(el.styles.color) : '#000000'}
              onChange={(c) => { if (isEditing) { execCmd('foreColor', c); } else if (el) { setStyle('color', c); } }} textColor />
            <ColorPicker label="" title="Background color" value={el ? rgbToHex(el.styles.backgroundColor) : '#ffffff'}
              onChange={(c) => { if (el) setStyle('backgroundColor', c); }} />
          </div>

          <div className="w-px h-6 bg-slate-200" />

          {/* Element Actions */}
          {el && (
            <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
              <ToolBtn icon={MoveUp} title="Move up" onClick={() => sendToIframe({ type: 'cmd-move-up' })} />
              <ToolBtn icon={MoveDown} title="Move down" onClick={() => sendToIframe({ type: 'cmd-move-down' })} />
              <ToolBtn icon={CopyPlus} title="Duplicate" onClick={() => sendToIframe({ type: 'cmd-duplicate' })} />
              <ToolBtn icon={Trash2} title="Delete" onClick={() => sendToIframe({ type: 'cmd-delete' })} danger />
            </div>
          )}

          <div className="flex-1" />

          {/* Section Library + Save + Sections toggles */}
          {el && (
            <button onClick={handleRequestSaveSection}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-emerald-600 hover:bg-emerald-50 transition-colors"
              title="Save selected section to library">
              <BookmarkPlus className="h-3.5 w-3.5" />Save Section
            </button>
          )}
          <button onClick={() => setShowSectionLibrary(!showSectionLibrary)}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors ${
              showSectionLibrary ? 'bg-indigo-100 text-indigo-700' : 'text-indigo-500 hover:bg-indigo-50'}`}>
            <Library className="h-3.5 w-3.5" />Library ({savedSections.length})
          </button>
          <button onClick={() => setShowSections(!showSections)}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors ${
              showSections ? 'bg-amber-100 text-amber-700' : 'text-slate-500 hover:bg-slate-100'}`}>
            <Layers className="h-3.5 w-3.5" />Sections
          </button>
          <button onClick={() => setShowSidebar(!showSidebar)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors" title={showSidebar ? 'Hide panel' : 'Show panel'}>
            {showSidebar ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        </div>
      )}

      {/* ═══ Main Area ═══ */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Mode-switch overlay: dipinto subito quando l'utente clicca
            Visual / Code / Preview, mentre il React commit del nuovo
            mode (e l'eventuale parsing della srcDoc dell'iframe) avviene
            in background. */}
        {switchingMode && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/85 backdrop-blur-sm pointer-events-auto">
            <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white shadow border border-slate-200 text-slate-700">
              <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
              <span className="text-sm font-medium">Switching mode…</span>
            </div>
          </div>
        )}

        {/* Sections panel */}
        {mode === 'visual' && showSections && (
          <div className="w-56 border-r border-slate-200 bg-slate-50 overflow-y-auto shrink-0">
            <div className="px-3 py-2 border-b border-slate-200 bg-white sticky top-0 z-10">
              <h3 className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-amber-500" />Page Sections
              </h3>
            </div>
            {sections.length === 0 ? (
              <p className="p-3 text-xs text-slate-400">Loading sections...</p>
            ) : (
              <div className="p-1.5 space-y-0.5">
                {sections.map((sec) => (
                  <button key={sec.index} onClick={() => sendToIframe({ type: 'cmd-select-path', path: sec.path })}
                    className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-white hover:shadow-sm transition-all group">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-mono text-amber-600 bg-amber-50 px-1 rounded">{sec.tagName}</span>
                      {sec.id && <span className="text-[10px] font-mono text-blue-500">#{sec.id}</span>}
                    </div>
                    <p className="text-[11px] text-slate-600 mt-0.5 truncate leading-tight group-hover:text-slate-800">
                      {sec.textPreview || '(empty)'}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Canvas / Code / Preview */}
        <div className="flex-1 relative overflow-hidden"
          style={mode === 'visual' ? {
            backgroundImage: 'radial-gradient(circle, #e2e8f0 0.6px, transparent 0.6px)',
            backgroundSize: '16px 16px',
            backgroundColor: '#f1f5f9',
          } : {}}>

          {mode === 'visual' && (
            <div className={`absolute inset-2 rounded-xl overflow-hidden shadow-xl border bg-white flex items-start justify-center ${
              editorViewport === 'mobile' ? 'border-blue-300 bg-gray-100' : 'border-slate-200'
            }`}>
              <iframe
                ref={iframeRef}
                key={`${editorViewport}-${iframeVersion}`}
                srcDoc={stableSrcDoc}
                className={`h-full border-0 transition-all duration-300 ${
                  editorViewport === 'mobile'
                    ? 'w-[390px] border-x-2 border-gray-300 shadow-2xl'
                    : 'w-full'
                }`}
                title="Visual Editor Canvas"
                sandbox="allow-scripts allow-same-origin"
              />
              {(!editorReady || switchingViewport || restoringHistory) && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/85 backdrop-blur-sm z-30">
                  <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white shadow border border-slate-200 text-slate-700">
                    {restoringHistory ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
                        <span className="text-sm font-medium">Restoring…</span>
                      </>
                    ) : switchingViewport ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                        <span className="text-sm font-medium">Switching viewport…</span>
                      </>
                    ) : (
                      <>
                        <MousePointer className="h-5 w-5 animate-pulse" />
                        <span className="text-sm">Loading editor…</span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === 'code' && (
            <div className="h-full flex flex-col">
              <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700">
                <span className="text-xs text-slate-400 font-mono">
                  HTML {editorViewport === 'mobile' ? '(Mobile)' : '(Desktop)'}
                </span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => { setCodeSearchOpen(!codeSearchOpen); if (codeSearchOpen) { setCodeSearchTerm(''); setCodeSearchCount(0); } }}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                      codeSearchOpen ? 'bg-amber-500/20 text-amber-300' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700'
                    }`}
                    title="Find & Replace (Ctrl+F)"
                  >
                    <Search className="h-3 w-3" />Find
                  </button>
                  <span className="text-[10px] text-slate-500">
                    {activeCode.length.toLocaleString()} characters
                  </span>
                </div>
              </div>

              {/* Search & Replace Bar */}
              {codeSearchOpen && (
                <div className="bg-slate-800 border-b border-slate-700 px-4 py-2 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-500" />
                      <input
                        autoFocus
                        type="text"
                        value={codeSearchTerm}
                        onChange={(e) => { setCodeSearchTerm(e.target.value); setCodeSearchIdx(0); codeSearchNavigate(e.target.value, 0); }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); codeSearchPrev(); }
                          else if (e.key === 'Enter') { e.preventDefault(); codeSearchNext(); }
                          else if (e.key === 'Escape') { setCodeSearchOpen(false); setCodeSearchTerm(''); setCodeSearchCount(0); }
                        }}
                        placeholder="Find..."
                        className="w-full bg-slate-900 text-slate-200 text-xs font-mono rounded border border-slate-600 focus:border-amber-500 pl-7 pr-2 py-1.5 outline-none"
                      />
                    </div>
                    <span className="text-[10px] text-slate-500 min-w-[60px] text-center">
                      {codeSearchCount > 0 ? `${codeSearchIdx + 1} / ${codeSearchCount}` : codeSearchTerm ? 'No match' : ''}
                    </span>
                    <button onClick={codeSearchPrev} disabled={codeSearchCount === 0}
                      className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 transition-colors" title="Previous (Shift+Enter)">
                      <MoveUp className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={codeSearchNext} disabled={codeSearchCount === 0}
                      className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 transition-colors" title="Next (Enter)">
                      <MoveDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setCodeShowReplace(!codeShowReplace)}
                      className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                        codeShowReplace ? 'bg-violet-500/20 text-violet-300' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      Replace
                    </button>
                    <button onClick={() => { setCodeSearchOpen(false); setCodeSearchTerm(''); setCodeSearchCount(0); setCodeShowReplace(false); }}
                      className="p-1 rounded text-slate-500 hover:text-white hover:bg-slate-700 transition-colors">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {codeShowReplace && (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={codeReplaceTerm}
                        onChange={(e) => setCodeReplaceTerm(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); codeReplaceOne(); } }}
                        placeholder="Replace with..."
                        className="flex-1 bg-slate-900 text-slate-200 text-xs font-mono rounded border border-slate-600 focus:border-violet-500 px-2.5 py-1.5 outline-none"
                      />
                      <button onClick={codeReplaceOne} disabled={codeSearchCount === 0}
                        className="px-2 py-1 rounded text-[10px] font-medium text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 transition-colors border border-slate-700">
                        Replace
                      </button>
                      <button onClick={codeReplaceAll} disabled={codeSearchCount === 0}
                        className="px-2 py-1 rounded text-[10px] font-medium text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 transition-colors border border-slate-700">
                        All
                      </button>
                    </div>
                  )}
                </div>
              )}

              <textarea
                ref={codeTextareaRef}
                value={activeCode}
                onChange={(e) => {
                  if (editorViewport === 'mobile' && mobileHtml) {
                    setMobileCodeHtml(e.target.value);
                  } else {
                    setCodeHtml(e.target.value);
                  }
                }}
                className="flex-1 w-full bg-slate-900 text-slate-300 font-mono text-sm p-4 resize-none outline-none leading-relaxed"
                spellCheck={false}
              />
            </div>
          )}

          {mode === 'preview' && (
            <div className="w-full h-full flex items-start justify-center bg-gray-100 overflow-auto relative">
              {!previewReady ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="flex items-center gap-2 text-slate-500">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="text-sm">Preparing preview…</span>
                  </div>
                </div>
              ) : (
                <iframe
                  key={`preview-${editorViewport}`}
                  srcDoc={previewSnapshot}
                  className={`h-full border-0 transition-all duration-300 ${
                    editorViewport === 'mobile'
                      ? 'w-[390px] shadow-2xl border-2 border-gray-300 rounded-[2rem] my-4'
                      : 'w-full'
                  }`}
                  title="Preview"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
              )}
            </div>
          )}
        </div>

        {/* ═══ Properties Sidebar ═══ */}
        {mode === 'visual' && showSidebar && (
          <div className="w-72 border-l border-slate-200 bg-white overflow-y-auto shrink-0 flex flex-col">
            {el ? (
              <div className="divide-y divide-slate-100 flex-1 overflow-y-auto">
                {/* Element Info */}
                <div className="p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-mono font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">&lt;{el.tagName}&gt;</span>
                    <span className="text-xs text-slate-500">{TAG_LABELS[el.tagName] || el.tagName}</span>
                  </div>
                  {el.id && <p className="text-[10px] text-blue-500 font-mono mb-1">#{el.id}</p>}
                  {el.className && <p className="text-[10px] text-slate-400 font-mono truncate mb-1" title={el.className}>.{el.className.split(' ').slice(0, 3).join(' .')}</p>}
                  {isEditing && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full font-medium">
                      <Paintbrush className="h-2.5 w-2.5" /> Editing Mode
                    </span>
                  )}
                </div>

                {/* Text Content */}
                {el.textContent && el.isTextNode && (
                  <div className="p-3">
                    <PropLabel>Text</PropLabel>
                    <textarea key={el.path} defaultValue={el.textContent} rows={3} className="prop-input font-normal"
                      onBlur={(e) => sendToIframe({ type: 'cmd-set-text', value: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendToIframe({ type: 'cmd-set-text', value: (e.target as HTMLTextAreaElement).value }); (e.target as HTMLTextAreaElement).blur(); } }} />
                  </div>
                )}

                {/* Rich Content (elements with children like advertorial paragraphs, headings, etc.) */}
                {!el.isTextNode && el.textContent && TEXT_EDITABLE_TAGS.has(el.tagName) && (
                  <div className="p-3">
                    <PropLabel icon={Type}>Content</PropLabel>
                    <p className="text-[10px] text-slate-400 mb-1">Edit inner HTML — formatting preserved</p>
                    <textarea key={`html-${el.path}`} defaultValue={el.innerHTML} rows={4} className="prop-input font-mono text-[11px]"
                      onBlur={(e) => sendToIframe({ type: 'cmd-set-inner-html', value: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); sendToIframe({ type: 'cmd-set-inner-html', value: (e.target as HTMLTextAreaElement).value }); (e.target as HTMLTextAreaElement).blur(); } }} />
                    <p className="text-[10px] text-slate-400 mt-1">Cmd+Enter to apply</p>
                  </div>
                )}

                {/* Link/Href */}
                {(el.tagName === 'a' || el.href) && (
                  <div className="p-3">
                    <PropLabel icon={Link}>Link URL</PropLabel>
                    <input type="url" defaultValue={el.href} className="prop-input"
                      onBlur={(e) => setAttr('href', e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') setAttr('href', (e.target as HTMLInputElement).value); }} />
                  </div>
                )}

                {/* (Le immagini di sfondo si modificano dalla sezione
                    "Background" più sotto: controllo sempre disponibile.) */}

                {/* Immagine dentro un wrapper — quando il click seleziona il
                    contenitore (.elImage / overlay) invece dell'<img>. */}
                {el.tagName !== 'img' && el.childImg && el.childImg.src && !(el.childImgs && el.childImgs.length > 1) && (
                  <div className="p-3">
                    <PropLabel icon={Image}>Image (in block)</PropLabel>
                    <label className="text-[10px] text-slate-500 mb-0.5 block">Image URL</label>
                    <input type="url" defaultValue={el.childImg.src} key={el.childImg.src} className="prop-input"
                      onBlur={(e) => setChildImgSrc(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') setChildImgSrc((e.target as HTMLInputElement).value); }} />
                    <input ref={childImgUploadRef} type="file" accept="image/*,.gif,.webp,.avif,.svg" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleChildImgUpload(f); e.target.value = ''; }} />
                    <button
                      onClick={() => childImgUploadRef.current?.click()}
                      disabled={uploading}
                      className="mt-1.5 w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg bg-blue-50 border border-blue-200 hover:border-blue-300 hover:bg-blue-100 transition-all text-xs font-medium text-blue-700 disabled:opacity-50"
                    >
                      {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      {uploading ? 'Uploading...' : 'Upload/replace image'}
                    </button>

                    {/* Forma immagine */}
                    <ShapeRow scope="main" />
                  </div>
                )}

                {/* Carosello / gallery — più <img> nello stesso blocco.
                    Le mostriamo TUTTE così l'utente sostituisce ognuna per
                    indice (nel carosello statico dell'editor ne vede una sola,
                    ma qui le tocca tutte). */}
                {el.childImgs && el.childImgs.length > 1 && (
                  <div className="p-3">
                    {/* Header cliccabile: apre/chiude la lista (menu a tendina).
                        Con caroselli da decine di immagini la lista è lunga,
                        così resta compatta finché non serve. */}
                    <button
                      type="button"
                      onClick={() => setChildImgsOpen((v) => !v)}
                      className="w-full flex items-center justify-between gap-2 mb-1"
                    >
                      <PropLabel icon={Image}>Images in block ({el.childImgs.length})</PropLabel>
                      <ChevronDown
                        className={`h-4 w-4 text-slate-400 transition-transform flex-shrink-0 ${childImgsOpen ? 'rotate-180' : ''}`}
                      />
                    </button>
                    <p className="text-[10px] text-slate-500 mb-2">
                      Carousel/gallery: replace each image individually.
                      {!childImgsOpen && ' Click to expand.'}
                    </p>
                    <input ref={childImgsUploadRef} type="file" accept="image/*,.gif,.webp,.avif,.svg" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; const idx = childImgsUploadIndexRef.current; if (f && idx >= 0) handleChildImgUploadAt(f, idx); e.target.value = ''; }} />
                    {childImgsOpen && <ShapeRow scope="all" />}
                    {childImgsOpen && (
                      <div className="space-y-2 max-h-[420px] overflow-y-auto pr-0.5 mt-2">
                        {el.childImgs.map((ci, i) => (
                          <div key={i} className="flex items-center gap-2 p-1.5 rounded-lg border border-slate-200 bg-slate-50">
                            <div className="w-10 h-10 rounded bg-white border border-slate-200 overflow-hidden flex-shrink-0 flex items-center justify-center">
                              {ci.src
                                ? <img src={ci.src} alt="" className="w-full h-full object-cover" />
                                : <Image className="h-4 w-4 text-slate-300" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="text-[10px] text-slate-400 block">#{i + 1}</span>
                              <input type="url" defaultValue={ci.src} key={ci.src} placeholder="Image URL"
                                className="prop-input !py-1 !text-[11px]"
                                onBlur={(e) => { if (e.target.value !== ci.src) setChildImgSrcAt(i, e.target.value); }}
                                onKeyDown={(e) => { if (e.key === 'Enter') setChildImgSrcAt(i, (e.target as HTMLInputElement).value); }} />
                            </div>
                            <button
                              onClick={() => { childImgsUploadIndexRef.current = i; childImgsUploadRef.current?.click(); }}
                              disabled={uploading}
                              title="Upload/replace"
                              className="flex-shrink-0 p-2 rounded-lg bg-blue-50 border border-blue-200 hover:bg-blue-100 transition-all text-blue-700 disabled:opacity-50"
                            >
                              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Image */}
                {el.tagName === 'img' && (
                  <div className="p-3">
                    <PropLabel icon={Image}>Image</PropLabel>
                    <label className="text-[10px] text-slate-500 mb-0.5 block">Image URL</label>
                    <input type="url" defaultValue={el.src} className="prop-input"
                      onBlur={(e) => setAttr('src', e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') setAttr('src', (e.target as HTMLInputElement).value); }} />

                    {/* Upload Image */}
                    <input ref={imgUploadRef} type="file" accept="image/*,.gif,.webp,.avif,.svg" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleMediaUpload(f, 'image'); e.target.value = ''; }} />
                    <button
                      onClick={() => imgUploadRef.current?.click()}
                      disabled={uploading}
                      className="mt-1.5 w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg bg-blue-50 border border-blue-200 hover:border-blue-300 hover:bg-blue-100 transition-all text-xs font-medium text-blue-700 disabled:opacity-50"
                    >
                      {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      {uploading ? 'Uploading...' : 'Upload Image'}
                    </button>
                    {uploadError && <p className="text-[10px] text-red-500 mt-1">{uploadError}</p>}

                    {/* Swipe for Product (immagini): Claude vision analizza
                        l'immagine competitor e genera un prompt T2I che
                        mostra il meccanismo unico del nostro prodotto e/o
                        un before/after split-frame, evitando il classico
                        packshot generico. */}
                    <button
                      onClick={handleSwipeImageForProduct}
                      disabled={uploading}
                      title="Replaces the image with one consistent with your product, generated with AI (text-to-image). Pre-fills the prompt using the page context and the Project data."
                      className="mt-1.5 w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500 hover:from-violet-600 hover:via-fuchsia-600 hover:to-pink-600 transition-all text-xs font-semibold text-white shadow-sm disabled:opacity-50"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Swipe for Product
                    </button>

                    <label className="text-[10px] text-slate-500 mt-2 mb-0.5 block">Alt text</label>
                    <input type="text" defaultValue={el.alt} className="prop-input"
                      onBlur={(e) => setAttr('alt', e.target.value)} />

                    {/* Image preview */}
                    {el.src && (
                      <div className="mt-2 rounded-lg overflow-hidden border border-slate-200 bg-slate-50">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={el.src} alt={el.alt || 'preview'} className="w-full h-auto max-h-32 object-contain" />
                      </div>
                    )}

                    {/* Forma immagine */}
                    <ShapeRow scope="main" />
                  </div>
                )}

                {/* Video */}
                {(el.tagName === 'video' || el.tagName === 'source') && (
                  <div className="p-3">
                    <PropLabel icon={Film}>Video</PropLabel>
                    <label className="text-[10px] text-slate-500 mb-0.5 block">Video URL</label>
                    <input type="url" defaultValue={el.src} className="prop-input"
                      onBlur={(e) => setAttr('src', e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') setAttr('src', (e.target as HTMLInputElement).value); }} />

                    {/* Upload Video */}
                    <input ref={vidUploadRef} type="file" accept="video/*" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleMediaUpload(f, 'video'); e.target.value = ''; }} />
                    <button
                      onClick={() => vidUploadRef.current?.click()}
                      disabled={uploading}
                      className="mt-1.5 w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg bg-purple-50 border border-purple-200 hover:border-purple-300 hover:bg-purple-100 transition-all text-xs font-medium text-purple-700 disabled:opacity-50"
                    >
                      {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      {uploading ? 'Uploading...' : 'Upload Video'}
                    </button>
                    {uploadError && <p className="text-[10px] text-red-500 mt-1">{uploadError}</p>}

                    {/* Swipe for Product: l'AI capisce cosa rappresenta il
                       video corrente e lo sostituisce con un video coerente
                       per il NOSTRO prodotto, riusando Seedance 2.0 (image2video). */}
                    {el.tagName === 'video' && (
                      <button
                        onClick={handleSwipeVideoForProduct}
                        disabled={uploading}
                        title="Replaces the video with one consistent with your product, generated with AI (Seedance 2.0). Pre-fills the prompt using the page context and the Project data."
                        className="mt-1.5 w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500 hover:from-violet-600 hover:via-fuchsia-600 hover:to-pink-600 transition-all text-xs font-semibold text-white shadow-sm disabled:opacity-50"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        Swipe for Product
                      </button>
                    )}

                    {/* Playback options (solo per <video>, non per <source>) */}
                    {el.tagName === 'video' && (() => {
                      const va = (el as unknown as { videoAttrs?: { controls: boolean; autoplay: boolean; loop: boolean; muted: boolean; playsinline: boolean; preload: string; poster: string } }).videoAttrs;
                      if (!va) return null;
                      const Toggle = ({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) => (
                        <button
                          type="button"
                          onClick={() => onChange(!on)}
                          title={hint}
                          className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-[11px] font-medium border transition-colors ${
                            on
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100'
                              : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                          }`}
                        >
                          <span>{label}</span>
                          <span className={`text-[9px] uppercase tracking-wider font-bold ${on ? 'text-emerald-600' : 'text-slate-400'}`}>
                            {on ? 'ON' : 'OFF'}
                          </span>
                        </button>
                      );
                      return (
                        <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
                          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Playback</p>
                          <div className="grid grid-cols-2 gap-1.5">
                            <Toggle
                              label="Controls"
                              hint="Show/hide the controls (play, volume, etc.) on the video"
                              on={va.controls}
                              onChange={(v) => setBoolAttr('controls', v)}
                            />
                            <Toggle
                              label="Loop"
                              hint="Automatically restart the video when it ends"
                              on={va.loop}
                              onChange={(v) => setBoolAttr('loop', v)}
                            />
                            <Toggle
                              label="Autoplay"
                              hint="Starts automatically on load (usually also needs Muted)"
                              on={va.autoplay}
                              onChange={(v) => {
                                setBoolAttr('autoplay', v);
                                if (v && !va.muted) setBoolAttr('muted', true);
                              }}
                            />
                            <Toggle
                              label="Muted"
                              hint="Audio off by default. Required for autoplay on modern browsers."
                              on={va.muted}
                              onChange={(v) => setBoolAttr('muted', v)}
                            />
                            <Toggle
                              label="Inline (mobile)"
                              hint="Inline playback on iPhone (without forced fullscreen)"
                              on={va.playsinline}
                              onChange={(v) => setBoolAttr('playsinline', v)}
                            />
                            <div>
                              <label className="text-[10px] text-slate-400 block mb-0.5">Preload</label>
                              <select
                                value={va.preload}
                                className="prop-select"
                                onChange={(e) => setAttr('preload', e.target.value)}
                                title="How much of the video to preload before playing"
                              >
                                <option value="none">none (lazy)</option>
                                <option value="metadata">metadata</option>
                                <option value="auto">auto (full)</option>
                              </select>
                            </div>
                          </div>
                          <div>
                            <label className="text-[10px] text-slate-400 block mb-0.5 mt-1">Poster (image shown before play)</label>
                            <input
                              type="url"
                              defaultValue={va.poster}
                              key={`poster-${va.poster}`}
                              placeholder="https://... (or leave empty)"
                              className="prop-input"
                              onBlur={(e) => {
                                const v = e.target.value.trim();
                                if (v) setAttr('poster', v);
                                else removeAttr('poster');
                              }}
                              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                            />
                          </div>
                          {/* Preset rapidi: GIF-like (autoplay+loop+muted+no controls)
                              e Reset (controls only). */}
                          <div className="pt-1 grid grid-cols-2 gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setBoolAttr('autoplay', true);
                                setBoolAttr('loop', true);
                                setBoolAttr('muted', true);
                                setBoolAttr('playsinline', true);
                                setBoolAttr('controls', false);
                              }}
                              className="text-[10px] py-1.5 rounded-md bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 font-medium"
                              title="Autoplay + Loop + Muted, without control bar — like a GIF"
                            >
                              GIF-like
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setBoolAttr('controls', true);
                                setBoolAttr('autoplay', false);
                                setBoolAttr('loop', false);
                                setBoolAttr('muted', false);
                              }}
                              className="text-[10px] py-1.5 rounded-md bg-slate-50 border border-slate-200 text-slate-600 hover:bg-slate-100 font-medium"
                              title="Only controls visible, no autoplay/loop/muted"
                            >
                              Standard
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Iframe / Embed (YouTube, Vimeo, ecc.) */}
                {el.tagName === 'iframe' && (
                  <div className="p-3">
                    <PropLabel icon={Film}>Embed</PropLabel>
                    <label className="text-[10px] text-slate-500 mb-0.5 block">Embed URL</label>
                    <input
                      type="url"
                      defaultValue={el.src}
                      placeholder="https://www.youtube.com/embed/VIDEO_ID"
                      className="prop-input"
                      onBlur={(e) => {
                        const raw = e.target.value.trim();
                        if (!raw) { setAttr('src', ''); return; }
                        let url = raw;
                        const yt = raw.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{6,})/i);
                        if (yt) url = `https://www.youtube.com/embed/${yt[1]}`;
                        const vm = raw.match(/vimeo\.com\/(?!.*player\.)(\d+)/i);
                        if (vm) url = `https://player.vimeo.com/video/${vm[1]}`;
                        setAttr('src', url);
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    />
                    <p className="text-[10px] text-slate-400 mt-1">
                      Paste a YouTube/Vimeo URL (also /watch?v=) or a ready embed.
                    </p>

                    {/* Convert iframe → native <video>. UX:
                        - Pulsante principale: apre subito il file picker; dopo
                          l'upload sostituisce l'iframe con un <video src="...">
                          gia' pronto a partire. Cosi' non si rimane mai con un
                          placeholder vuoto che "lampeggia" senza src.
                        - Link secondario: converte in <video> vuoto se l'utente
                          vuole solo cambiare la sorgente in un secondo momento. */}
                    <div className="mt-3 pt-3 border-t border-slate-100">
                      <p className="text-[10px] text-slate-500 mb-1.5">Want to upload your own video instead of using an embed?</p>
                      <button
                        type="button"
                        onClick={handleIframeToVideoUpload}
                        disabled={uploading}
                        className="w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg bg-purple-50 border border-purple-200 hover:border-purple-300 hover:bg-purple-100 transition-all text-xs font-medium text-purple-700 disabled:opacity-50"
                        title="Opens the file picker, uploads the video, and inserts it ready to go."
                      >
                        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        {uploading ? 'Uploading...' : 'Upload your own video instead'}
                      </button>
                      {uploadError && <p className="text-[10px] text-red-500 mt-1">{uploadError}</p>}
                      <button
                        type="button"
                        onClick={() => sendToIframe({ type: 'cmd-convert-iframe-to-video' })}
                        disabled={uploading}
                        className="w-full mt-1.5 text-[10px] text-slate-400 hover:text-slate-600 underline disabled:opacity-50"
                        title="Creates an empty &lt;video&gt;. You'll then need to click the video and use 'Upload Video' in the sidebar."
                      >
                        or convert to an empty &lt;video&gt; (upload later)
                      </button>
                    </div>
                  </div>
                )}

                {/* AI Image / Video Generation */}
                {el.tagName === 'img' && (
                  <div className="p-3">
                    <button
                      onClick={() => {
                        setAiError('');
                        setAiRevisedPrompt('');
                        setAiContextText('');
                        setAiPrompt('');
                        setAiMode('text2image');
                        setAiModel('nano-banana-2');
                        // Reset Swipe banner: questo è il flusso AI normale,
                        // non lo Swipe-for-Product.
                        setSwipeMediaKind(null);
                        // Pre-fill source image with the currently selected img,
                        // useful if the user immediately switches to Modifica/Anima.
                        const currentSrc = el.src;
                        setAiSourceImage(currentSrc && /^https?:\/\//.test(currentSrc) ? currentSrc : '');
                        setAiProductImage('');
                        setAiExtraImages([]);
                        sendToIframe({ type: 'cmd-get-context-text' });
                        setShowAiImagePopup(true);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-gradient-to-r from-violet-50 to-purple-50 border border-violet-200 hover:border-violet-300 transition-all group"
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex items-center justify-center w-6 h-6 rounded-md bg-violet-500/10">
                          <Sparkles className="h-3.5 w-3.5 text-violet-600" />
                        </div>
                        <span className="text-xs font-semibold text-violet-700">Generate with AI</span>
                      </div>
                      <Wand2 className="h-3.5 w-3.5 text-violet-400" />
                    </button>

                  </div>
                )}

                {/* Typography */}
                <div className="p-3">
                  <PropLabel icon={Type}>Typography</PropLabel>
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <div>
                      <label className="text-[10px] text-slate-400">Color</label>
                      <div className="flex items-center gap-1">
                        <input type="color" value={rgbToHex(el.styles.color)} className="w-6 h-6 rounded cursor-pointer border border-slate-200"
                          onChange={(e) => { if (isEditing) { execCmd('foreColor', e.target.value); } else { setStyle('color', e.target.value); } }} />
                        <span className="text-[10px] font-mono text-slate-500">{rgbToHex(el.styles.color)}</span>
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Size</label>
                      <select value={el.styles.fontSize} className="prop-select"
                        onChange={(e) => setStyle('fontSize', e.target.value)}>
                        {FONT_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Weight</label>
                      <select value={parseInt(el.styles.fontWeight) >= 600 ? '700' : '400'} className="prop-select"
                        onChange={(e) => setStyle('fontWeight', e.target.value)}>
                        <option value="300">Light</option>
                        <option value="400">Normal</option>
                        <option value="500">Medium</option>
                        <option value="600">Semi Bold</option>
                        <option value="700">Bold</option>
                        <option value="800">Extra Bold</option>
                        <option value="900">Black</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Alignment</label>
                      <div className="flex gap-0.5">
                        {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([align, Icon]) => (
                          <button key={align} onClick={() => setStyle('textAlign', align)}
                            className={`p-1 rounded ${el.styles.textAlign === align ? 'bg-amber-100 text-amber-700' : 'text-slate-400 hover:bg-slate-100'}`}>
                            <Icon className="h-3 w-3" />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Background */}
                <div className="p-3">
                  <PropLabel icon={Palette}>Background</PropLabel>
                  <div className="flex items-center gap-2 mt-1">
                    <input type="color" value={rgbToHex(el.styles.backgroundColor)}
                      className="w-6 h-6 rounded cursor-pointer border border-slate-200"
                      onChange={(e) => setStyle('backgroundColor', e.target.value)} />
                    <span className="text-[10px] font-mono text-slate-500">{rgbToHex(el.styles.backgroundColor)}</span>
                    <button onClick={() => setStyle('backgroundColor', 'transparent')}
                      className="ml-auto text-[10px] text-slate-400 hover:text-red-500">Reset</button>
                  </div>

                  {/* Gradient editor (linear / radial) — drives `background-image`
                      so it stacks on top of the solid color picker above and
                      coexists with the URL/image bg field below. Setting type
                      "Solid" writes `background-image:none` to clear it. */}
                  {el.tagName !== 'img' && (
                    <BgGradientEditor
                      bgImage={el.styles.backgroundImage}
                      seedColor={rgbToHex(el.styles.backgroundColor)}
                      onChange={(nextBgImage) => setStyle('backgroundImage', nextBgImage)}
                    />
                  )}

                  {/* Immagine di sfondo — SEMPRE disponibile per elementi non-<img>.
                      Pre-filled with the existing background, if any
                      (sull'elemento o, se assente, su un figlio del blocco —
                      rilevato via getComputedStyle). Permette anche di
                      AGGIUNGERNE una da zero dove non c'è. */}
                  {el.tagName !== 'img' && (() => {
                    const ownBg = el.styles.backgroundImage && el.styles.backgroundImage !== 'none'
                      ? (el.styles.backgroundImage.match(/url\((['"]?)(.*?)\1\)/i)?.[2] || '')
                      : '';
                    const childBgSrc = el.childBg?.src || '';
                    // Se l'elemento non ha un suo background ma un figlio sì,
                    // agiamo sul figlio (setter "nel blocco"). Altrimenti
                    // sull'elemento selezionato.
                    const useChild = !ownBg && !!childBgSrc;
                    const currentBg = ownBg || childBgSrc;
                    const applyBg = (v: string) => {
                      if (useChild) setChildBgImage(v);
                      else setStyle('backgroundImage', v ? `url("${v}")` : 'none');
                    };
                    return (
                      <div className="mt-2.5">
                        <label className="text-[10px] text-slate-500 mb-0.5 block">
                          Background image{useChild ? ' (in block)' : ''} — URL
                        </label>
                        <input type="url" defaultValue={currentBg} key={currentBg || 'empty'}
                          placeholder="https://… or upload below"
                          className="prop-input"
                          onBlur={(e) => applyBg(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') applyBg((e.target as HTMLInputElement).value); }} />
                        <input ref={bgImgUploadRef} type="file" accept="image/*,.gif,.webp,.avif,.svg" className="hidden"
                          onChange={async (e) => {
                            const f = e.target.files?.[0]; e.target.value = '';
                            if (!f || uploading) return;
                            setUploading(true); setUploadError('');
                            try {
                              const url = await directSupabaseUpload(f);
                              applyBg(url);
                              if (!useChild) {
                                setStyle('backgroundSize', 'cover');
                                setStyle('backgroundPosition', 'center');
                                setStyle('backgroundRepeat', 'no-repeat');
                              }
                            } catch (err) {
                              setUploadError(err instanceof Error ? err.message : 'Upload failed');
                            } finally {
                              setUploading(false);
                            }
                          }} />
                        <button
                          onClick={() => bgImgUploadRef.current?.click()}
                          disabled={uploading}
                          className="mt-1.5 w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg bg-blue-50 border border-blue-200 hover:border-blue-300 hover:bg-blue-100 transition-all text-xs font-medium text-blue-700 disabled:opacity-50"
                        >
                          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                          {uploading ? 'Uploading...' : (currentBg ? 'Upload/replace background' : 'Upload background image')}
                        </button>
                        {currentBg && (
                          <button onClick={() => applyBg('')}
                            className="mt-1 w-full text-[10px] text-slate-400 hover:text-red-500">Remove background</button>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Dimensions */}
                <div className="p-3">
                  <PropLabel>Dimensions</PropLabel>
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <div>
                      <label className="text-[10px] text-slate-400">Width</label>
                      <input type="text" defaultValue={el.styles.width} className="prop-input" placeholder="auto"
                        onBlur={(e) => setStyle('width', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Height</label>
                      <input type="text" defaultValue={el.styles.height} className="prop-input" placeholder="auto"
                        onBlur={(e) => setStyle('height', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Max Width</label>
                      <input type="text" defaultValue={el.styles.maxWidth} className="prop-input" placeholder="none"
                        onBlur={(e) => setStyle('maxWidth', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Min Height</label>
                      <input type="text" defaultValue={el.styles.minHeight} className="prop-input" placeholder="0"
                        onBlur={(e) => setStyle('minHeight', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Display</label>
                      <select defaultValue={el.styles.display} className="prop-select"
                        onChange={(e) => setStyle('display', e.target.value)}>
                        <option value="block">block</option>
                        <option value="flex">flex</option>
                        <option value="grid">grid</option>
                        <option value="inline">inline</option>
                        <option value="inline-block">inline-block</option>
                        <option value="inline-flex">inline-flex</option>
                        <option value="none">none</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Overflow</label>
                      <select defaultValue={el.styles.overflow} className="prop-select"
                        onChange={(e) => setStyle('overflow', e.target.value)}>
                        <option value="visible">visible</option>
                        <option value="hidden">hidden</option>
                        <option value="scroll">scroll</option>
                        <option value="auto">auto</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Position</label>
                      <select defaultValue={el.styles.position} className="prop-select"
                        onChange={(e) => setStyle('position', e.target.value)}>
                        <option value="static">static</option>
                        <option value="relative">relative</option>
                        <option value="absolute">absolute</option>
                        <option value="fixed">fixed</option>
                        <option value="sticky">sticky</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Gap</label>
                      <input type="text" defaultValue={el.styles.gap} className="prop-input" placeholder="0"
                        onBlur={(e) => setStyle('gap', e.target.value)} />
                    </div>
                  </div>
                </div>

                {/* Spacing — controlli per-lato Padding/Margin */}
                <div className="p-3">
                  <PropLabel>Spacing</PropLabel>

                  {/* PADDING — interno (spazio tra bordo e contenuto) */}
                  <div className="mt-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-semibold text-slate-500">Padding (inner)</span>
                      <button
                        type="button"
                        onClick={() => setPaddingLinked((v) => !v)}
                        title={paddingLinked ? 'Sides linked — edit one = apply to all' : 'Independent sides — click to link'}
                        className={`p-1 rounded ${paddingLinked ? 'bg-amber-100 text-amber-700' : 'text-slate-400 hover:bg-slate-100'}`}
                      >
                        {paddingLinked ? <Link2 className="h-3 w-3" /> : <Link2Off className="h-3 w-3" />}
                      </button>
                    </div>
                    <div className="grid grid-cols-4 gap-1">
                      {([
                        ['T', 'paddingTop', el.styles.paddingTop],
                        ['R', 'paddingRight', el.styles.paddingRight],
                        ['B', 'paddingBottom', el.styles.paddingBottom],
                        ['L', 'paddingLeft', el.styles.paddingLeft],
                      ] as const).map(([lab, prop, val]) => (
                        <div key={prop}>
                          <label className="text-[10px] text-slate-400 text-center block">{lab}</label>
                          <input
                            type="number"
                            min={0}
                            step={1}
                            defaultValue={pxToNum(val)}
                            key={`pad-${prop}-${pxToNum(val)}`}
                            className="prop-input text-center px-1"
                            onBlur={(e) => {
                              const n = parseInt(e.target.value || '0', 10);
                              const px = `${Number.isFinite(n) && n >= 0 ? n : 0}px`;
                              if (paddingLinked) setStyle('padding', px);
                              else setStyle(prop, px);
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* MARGIN — esterno (spazio tra elemento e vicini) */}
                  <div className="mt-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-semibold text-slate-500">Margin (outer)</span>
                      <button
                        type="button"
                        onClick={() => setMarginLinked((v) => !v)}
                        title={marginLinked ? 'Sides linked — edit one = apply to all' : 'Independent sides — click to link'}
                        className={`p-1 rounded ${marginLinked ? 'bg-amber-100 text-amber-700' : 'text-slate-400 hover:bg-slate-100'}`}
                      >
                        {marginLinked ? <Link2 className="h-3 w-3" /> : <Link2Off className="h-3 w-3" />}
                      </button>
                    </div>
                    <div className="grid grid-cols-4 gap-1">
                      {([
                        ['T', 'marginTop', el.styles.marginTop],
                        ['R', 'marginRight', el.styles.marginRight],
                        ['B', 'marginBottom', el.styles.marginBottom],
                        ['L', 'marginLeft', el.styles.marginLeft],
                      ] as const).map(([lab, prop, val]) => (
                        <div key={prop}>
                          <label className="text-[10px] text-slate-400 text-center block">{lab}</label>
                          <input
                            type="number"
                            step={1}
                            defaultValue={pxToNum(val)}
                            key={`mar-${prop}-${pxToNum(val)}`}
                            className="prop-input text-center px-1"
                            onBlur={(e) => {
                              const raw = e.target.value.trim();
                              if (raw === '' || raw.toLowerCase() === 'auto') {
                                if (marginLinked) setStyle('margin', 'auto');
                                else setStyle(prop, 'auto');
                                return;
                              }
                              const n = parseInt(raw, 10);
                              const px = `${Number.isFinite(n) ? n : 0}px`;
                              if (marginLinked) setStyle('margin', px);
                              else setStyle(prop, px);
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          />
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1">Tip: type <code>auto</code> to center horizontally.</p>
                  </div>

                  {/* Preset rapidi spaziatura verticale (top+bottom) — utile per
                      aumentare/ridurre l'aria sopra/sotto un blocco con un click. */}
                  <div className="mt-3">
                    <div className="text-[10px] font-semibold text-slate-500 mb-1">Vertical preset (T+B)</div>
                    <div className="grid grid-cols-5 gap-1">
                      {([
                        ['0', 0],
                        ['8', 8],
                        ['16', 16],
                        ['32', 32],
                        ['64', 64],
                      ] as const).map(([lab, n]) => (
                        <button
                          key={`pp-${n}`}
                          type="button"
                          onClick={() => {
                            setStyle('paddingTop', `${n}px`);
                            setStyle('paddingBottom', `${n}px`);
                          }}
                          className="text-[10px] py-1 rounded bg-slate-100 hover:bg-amber-100 hover:text-amber-700 text-slate-600"
                          title={`Padding T+B = ${n}px`}
                        >
                          {lab}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Border radius / Border / Opacity */}
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <div>
                      <label className="text-[10px] text-slate-400">Border radius</label>
                      <input type="text" defaultValue={el.styles.borderRadius} className="prop-input"
                        onBlur={(e) => setStyle('borderRadius', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Border</label>
                      <input type="text" defaultValue={el.styles.border} className="prop-input" placeholder="none"
                        onBlur={(e) => setStyle('border', e.target.value)} />
                    </div>
                    <div className="col-span-2">
                      <label className="text-[10px] text-slate-400">Opacity</label>
                      <div className="flex items-center gap-2">
                        <input type="range" min="0" max="1" step="0.05" defaultValue={el.styles.opacity}
                          className="flex-1"
                          onChange={(e) => setStyle('opacity', e.target.value)} />
                        <span className="text-[10px] text-slate-500 w-8 text-right">{el.styles.opacity}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="p-3">
                  <PropLabel>Actions</PropLabel>
                  <div className="grid grid-cols-2 gap-1.5 mt-1">
                    <ActionBtn icon={MoveUp} label="Move up" onClick={() => sendToIframe({ type: 'cmd-move-up' })} />
                    <ActionBtn icon={MoveDown} label="Move down" onClick={() => sendToIframe({ type: 'cmd-move-down' })} />
                    <ActionBtn icon={CopyPlus} label="Duplicate" onClick={() => sendToIframe({ type: 'cmd-duplicate' })} />
                    <ActionBtn icon={Trash2} label="Delete" onClick={() => sendToIframe({ type: 'cmd-delete' })} danger />
                  </div>
                </div>

                {/* Save to Library */}
                <div className="p-3">
                  <button
                    onClick={handleRequestSaveSection}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 transition-all shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/30"
                  >
                    <BookmarkPlus className="h-4 w-4" />
                    Save to Library
                  </button>
                </div>

              </div>
            ) : (
              <div className="flex flex-col p-6 text-center">
                <MousePointer className="h-10 w-10 text-slate-200 mb-3 mx-auto" />
                <p className="text-sm font-medium text-slate-500">No element selected</p>
                <p className="text-xs text-slate-400 mt-1">Click on an element to edit it</p>
                <div className="mt-4 space-y-1.5 text-left w-full">
                  <Hint emoji="👆" text="Click to select an element" />
                  <Hint emoji="✏️" text="Double click to edit text" />
                  <Hint emoji="⎋" text="Esc to deselect" />
                </div>
              </div>
            )}

            {/* AI Chat — always visible at bottom of sidebar */}
            <div className="border-t border-slate-200 mt-auto">
              <div className="px-3 py-2 bg-gradient-to-r from-violet-50 to-purple-50 border-b border-violet-100 flex items-center gap-2">
                <div className="flex items-center justify-center w-5 h-5 rounded-md bg-violet-500/10">
                  <Sparkles className="h-3 w-3 text-violet-600" />
                </div>
                <span className="text-xs font-bold text-violet-700">AI Edit</span>
                <span className="text-[10px] text-violet-400 ml-auto">
                  {el ? `<${el.tagName}>` : 'page'}
                </span>
              </div>

              <div className="max-h-[200px] overflow-y-auto p-2 space-y-1.5">
                {elAiMessages.length === 0 && !elAiLoading && (
                  <p className="text-[10px] text-slate-400 text-center py-2">
                    {el ? 'Describe what to change on this element...' : 'Insert scripts, styles, or modify the page...'}
                  </p>
                )}
                {elAiMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[90%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-violet-600 text-white rounded-br-sm'
                        : 'bg-slate-100 text-slate-700 rounded-bl-sm'
                    }`}>
                      {msg.content}
                    </div>
                  </div>
                ))}
                {elAiLoading && (
                  <div className="flex justify-start">
                    <div className="bg-slate-100 rounded-lg rounded-bl-sm px-2.5 py-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
                    </div>
                  </div>
                )}
                <div ref={elAiChatEndRef} />
              </div>

              <div className="p-2 border-t border-slate-100 flex gap-1 items-end">
                <input ref={elAiFileRef} type="file" accept="image/*,.gif,.webp,.avif,video/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleElAiImageUpload(f); e.target.value = ''; }} />
                <button
                  onClick={() => elAiFileRef.current?.click()}
                  disabled={elAiUploading || elAiLoading}
                  className="p-1.5 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg transition-colors shrink-0 disabled:opacity-40"
                  title="Upload image or video"
                >
                  {elAiUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" /> : <Paperclip className="w-3.5 h-3.5" />}
                </button>
                <input
                  type="text"
                  value={elAiInput}
                  onChange={(e) => setElAiInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleElAiSend(); } }}
                  onPaste={handleElAiPaste}
                  placeholder={el ? 'E.g.: Make text bigger...' : 'E.g.: Add tracking script before </head>...'}
                  className="flex-1 px-2.5 py-2.5 border border-slate-200 rounded-lg text-[12px] text-slate-900 bg-white placeholder:text-slate-400 focus:ring-1 focus:ring-violet-500 focus:border-violet-500 outline-none"
                  disabled={elAiLoading}
                />
                <button
                  onClick={handleElAiSend}
                  disabled={elAiLoading || !elAiInput.trim()}
                  className="px-2 py-1.5 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  {elAiLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ═══ Insert Section Panel (triggered by + button) ═══ */}
      {showInsertPanel && (() => {
        const BUILTIN_BLOCKS = [
          { id: 'b-text', icon: '📝', label: 'Text Block', html: '<div style="padding:40px 20px;max-width:800px;margin:0 auto"><h2 style="font-size:28px;font-weight:700;margin-bottom:16px;color:#1a1a1a">Your Headline Here</h2><p style="font-size:16px;line-height:1.7;color:#444">Write your paragraph text here. You can edit this directly in the visual editor by double-clicking.</p></div>' },
          { id: 'b-image', icon: '🖼️', label: 'Image', html: '<div style="padding:24px 20px;text-align:center"><img src="https://placehold.co/800x400/e2e8f0/64748b?text=Your+Image+Here" alt="Image" style="max-width:100%;height:auto;border-radius:8px" /></div>' },
          { id: 'b-video', icon: '🎬', label: 'Video (Upload)', html: '<div style="padding:24px 20px;max-width:800px;margin:0 auto;text-align:center"><video controls preload="metadata" playsinline poster="https://placehold.co/1280x720/0f172a/94a3b8?text=Click+the+video%2C+then+%22Upload+Video%22+in+the+sidebar" style="width:100%;max-width:800px;aspect-ratio:16/9;border-radius:8px;background:#000;display:block;margin:0 auto;cursor:pointer"></video></div>' },
          { id: 'b-video-embed', icon: '📺', label: 'Video Embed (YouTube/Vimeo)', html: '<div style="padding:24px 20px;max-width:800px;margin:0 auto"><div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;background:#000"><iframe src="" data-placeholder="paste-youtube-or-vimeo-embed-url" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0" allow="autoplay;encrypted-media;picture-in-picture;fullscreen" allowfullscreen></iframe></div><p style="margin-top:8px;font-size:12px;color:#64748b;text-align:center">Click the iframe and paste an embed URL (e.g. https://www.youtube.com/embed/VIDEO_ID) in the sidebar.</p></div>' },
          { id: 'b-2col', icon: '▥', label: '2 Columns', html: '<div style="padding:40px 20px;max-width:960px;margin:0 auto;display:flex;gap:32px;flex-wrap:wrap"><div style="flex:1;min-width:280px"><img src="https://placehold.co/460x300/e2e8f0/64748b?text=Image" alt="" style="width:100%;border-radius:8px" /></div><div style="flex:1;min-width:280px"><h3 style="font-size:22px;font-weight:700;margin-bottom:12px;color:#1a1a1a">Column Title</h3><p style="font-size:15px;line-height:1.7;color:#555">Description text goes here. Edit it in the visual editor.</p><a href="#" style="display:inline-block;margin-top:16px;padding:12px 28px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">Learn More</a></div></div>' },
          { id: 'b-offer', icon: '🏷️', label: 'Offer / CTA', html: '<div style="padding:48px 20px;background:linear-gradient(135deg,#1e40af,#7c3aed);text-align:center"><h2 style="font-size:32px;font-weight:800;color:#fff;margin-bottom:8px">Special Offer</h2><p style="font-size:18px;color:rgba(255,255,255,.85);margin-bottom:24px">Get 50% off for a limited time only</p><div style="display:inline-block;background:#fff;border-radius:12px;padding:24px 40px;margin-bottom:20px"><div style="font-size:14px;color:#6b7280;text-decoration:line-through">$197.00</div><div style="font-size:40px;font-weight:800;color:#1e40af">$97</div></div><br/><a href="#" style="display:inline-block;padding:16px 48px;background:#f59e0b;color:#1a1a1a;text-decoration:none;border-radius:10px;font-weight:800;font-size:18px;text-transform:uppercase;letter-spacing:1px">Buy Now</a><p style="font-size:12px;color:rgba(255,255,255,.6);margin-top:16px">60-day money-back guarantee</p></div>' },
          { id: 'b-testimonial', icon: '💬', label: 'Testimonials', html: '<div style="padding:48px 20px;background:#f8fafc"><div style="max-width:960px;margin:0 auto"><h2 style="text-align:center;font-size:26px;font-weight:700;margin-bottom:32px;color:#1a1a1a">What Our Customers Say</h2><div style="display:flex;gap:20px;flex-wrap:wrap"><div style="flex:1;min-width:260px;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)"><div style="font-size:20px;color:#f59e0b;margin-bottom:12px">★★★★★</div><p style="font-size:14px;line-height:1.6;color:#555;font-style:italic">"This product completely changed my life. I can\'t recommend it enough to anyone looking for real results."</p><div style="margin-top:16px;font-size:13px;font-weight:600;color:#1a1a1a">— Sarah J.</div></div><div style="flex:1;min-width:260px;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)"><div style="font-size:20px;color:#f59e0b;margin-bottom:12px">★★★★★</div><p style="font-size:14px;line-height:1.6;color:#555;font-style:italic">"Amazing results in just a few weeks. The quality exceeded all my expectations. Highly recommended!"</p><div style="margin-top:16px;font-size:13px;font-weight:600;color:#1a1a1a">— Mike R.</div></div><div style="flex:1;min-width:260px;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)"><div style="font-size:20px;color:#f59e0b;margin-bottom:12px">★★★★★</div><p style="font-size:14px;line-height:1.6;color:#555;font-style:italic">"Best purchase I\'ve made this year. Customer service was also outstanding!"</p><div style="margin-top:16px;font-size:13px;font-weight:600;color:#1a1a1a">— Lisa T.</div></div></div></div></div>' },
          { id: 'b-hero', icon: '🎯', label: 'Hero Section', html: '<div style="padding:64px 20px;background:linear-gradient(135deg,#0f172a,#1e3a5f);text-align:center"><h1 style="font-size:42px;font-weight:800;color:#fff;margin-bottom:16px;line-height:1.2">The Headline That Grabs Attention</h1><p style="font-size:18px;color:rgba(255,255,255,.75);max-width:600px;margin:0 auto 32px;line-height:1.6">Your subheadline explains the main benefit and sets expectations</p><a href="#" style="display:inline-block;padding:16px 40px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:16px">Get Started Now →</a></div>' },
          { id: 'b-faq', icon: '❓', label: 'FAQ', html: '<div style="padding:48px 20px;max-width:800px;margin:0 auto"><h2 style="font-size:28px;font-weight:700;text-align:center;margin-bottom:32px;color:#1a1a1a">Frequently Asked Questions</h2><div style="border-top:1px solid #e5e7eb"><div style="padding:20px 0;border-bottom:1px solid #e5e7eb"><h3 style="font-size:16px;font-weight:600;color:#1a1a1a;margin-bottom:8px">How does it work?</h3><p style="font-size:14px;color:#555;line-height:1.6">Explain how your product/service works in simple terms.</p></div><div style="padding:20px 0;border-bottom:1px solid #e5e7eb"><h3 style="font-size:16px;font-weight:600;color:#1a1a1a;margin-bottom:8px">Is there a guarantee?</h3><p style="font-size:14px;color:#555;line-height:1.6">Yes, we offer a 60-day money-back guarantee. No questions asked.</p></div><div style="padding:20px 0;border-bottom:1px solid #e5e7eb"><h3 style="font-size:16px;font-weight:600;color:#1a1a1a;margin-bottom:8px">How long until I see results?</h3><p style="font-size:14px;color:#555;line-height:1.6">Most customers see results within the first week of use.</p></div></div></div>' },
          { id: 'b-carousel', icon: '🎠', label: 'Carousel', html: '<div data-replo-carousel="true" style="max-width:720px;margin:0 auto;padding:24px 20px;position:relative"><div class="slider-for" style="position:relative;overflow:hidden;border-radius:12px;background:#f1f5f9"><div class="r-ldsnaw"><img src="https://placehold.co/720x480/e2e8f0/64748b?text=Slide+1" alt="" style="width:100%;display:block" /></div><div class="r-ldsnaw"><img src="https://placehold.co/720x480/dbeafe/3b82f6?text=Slide+2" alt="" style="width:100%;display:block" /></div><div class="r-ldsnaw"><img src="https://placehold.co/720x480/fef3c7/d97706?text=Slide+3" alt="" style="width:100%;display:block" /></div><button type="button" aria-label="Previous slide" class="lc-arrow lc-arrow-prev" style="position:absolute;top:50%;left:10px;transform:translateY(-50%);z-index:2;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);color:#fff;border:none;border-radius:50%;width:40px;height:40px;font-size:18px;cursor:pointer">❮</button><button type="button" aria-label="Next slide" class="lc-arrow lc-arrow-next" style="position:absolute;top:50%;right:10px;transform:translateY(-50%);z-index:2;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);color:#fff;border:none;border-radius:50%;width:40px;height:40px;font-size:18px;cursor:pointer">❯</button></div><div class="slider-nav" style="display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap"><div style="width:72px;cursor:pointer;border-radius:6px;overflow:hidden"><img src="https://placehold.co/720x480/e2e8f0/64748b?text=1" alt="" style="width:100%;display:block" /></div><div style="width:72px;cursor:pointer;border-radius:6px;overflow:hidden"><img src="https://placehold.co/720x480/dbeafe/3b82f6?text=2" alt="" style="width:100%;display:block" /></div><div style="width:72px;cursor:pointer;border-radius:6px;overflow:hidden"><img src="https://placehold.co/720x480/fef3c7/d97706?text=3" alt="" style="width:100%;display:block" /></div></div></div>' },
          { id: 'b-divider', icon: '➖', label: 'Divider', html: '<div style="padding:8px 20px;max-width:800px;margin:0 auto"><hr style="border:none;border-top:2px solid #e5e7eb" /></div>' },
        ];

        const insertBlock = (html: string) => {
          sendToIframe({ type: 'cmd-insert-after-selected', html });
          setShowInsertPanel(false);
        };

        const filtered = insertSearch.trim()
          ? BUILTIN_BLOCKS.filter(b => b.label.toLowerCase().includes(insertSearch.toLowerCase()))
          : BUILTIN_BLOCKS;

        return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowInsertPanel(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[520px] max-w-[95vw] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3 bg-gradient-to-r from-blue-600 to-cyan-600 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="w-5 h-5" />
                <span className="font-bold text-sm">Insert Block</span>
              </div>
              <button onClick={() => setShowInsertPanel(false)} className="text-white/80 hover:text-white text-lg font-bold">×</button>
            </div>
            <div className="px-4 py-2 border-b">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input value={insertSearch} onChange={e => setInsertSearch(e.target.value)}
                  placeholder="Search blocks & templates..." autoFocus
                  className="w-full pl-8 pr-3 py-1.5 text-xs border rounded-lg focus:ring-1 focus:ring-blue-400 focus:border-blue-400" />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {filtered.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">Blocks</p>
                  <div className="grid grid-cols-4 gap-2">
                    {filtered.map(b => (
                      <button key={b.id} onClick={() => insertBlock(b.html)}
                        className="flex flex-col items-center gap-1.5 p-3 rounded-xl border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-all text-center group">
                        <span className="text-2xl">{b.icon}</span>
                        <span className="text-[10px] font-medium text-gray-600 group-hover:text-blue-700 leading-tight">{b.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {insertPanelSections.length > 0 && (() => {
                const typeIcons: Record<string, string> = {
                  hero: '🎯', cta: '🏷️', 'cta-image': '🏷️', testimonial: '💬', faq: '❓',
                  features: '✨', pricing: '💰', guarantee: '🛡️', 'social-proof': '📰',
                  video: '🎬', form: '📝', footer: '🔻', header: '🔝', comparison: '⚖️',
                  ingredients: '🧪', results: '📊', 'image-section': '🖼️', list: '📋',
                  content: '📄', body: '📄',
                };
                return (
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">Saved Templates ({insertPanelSections.length})</p>
                  <div className="space-y-2">
                    {insertPanelSections.map(section => (
                      <div key={section.id} className="border rounded-lg overflow-hidden hover:shadow-md transition-shadow group">
                        <div className="h-20 bg-gray-50 overflow-hidden relative">
                          <iframe srcDoc={section.html} className="w-full h-full border-0 pointer-events-none" title={section.name}
                            sandbox="allow-same-origin" style={{ transform: 'scale(0.35)', transformOrigin: 'top left', width: '286%', height: '286%' }} />
                          <div className="absolute inset-0 bg-transparent group-hover:bg-blue-500/10 transition-colors" />
                        </div>
                        <div className="px-3 py-1.5 flex items-center justify-between bg-white">
                          <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            <span className="text-sm shrink-0">{typeIcons[section.sectionType] || '📄'}</span>
                            <p className="text-[11px] font-medium truncate min-w-0">{section.name}</p>
                            {section.tags?.includes('auto-saved') && (
                              <span className="text-[8px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium shrink-0">AI</span>
                            )}
                          </div>
                          <button onClick={() => handleInsertAfter(section)}
                            className="px-2.5 py-1 bg-blue-600 text-white text-[10px] rounded-lg hover:bg-blue-700 transition-colors font-medium shrink-0 ml-2">
                            Insert
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>);
              })()}

              {filtered.length === 0 && insertPanelSections.length === 0 && (
                <div className="text-center py-8 text-gray-400 text-xs">
                  <Search className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p>No results for &quot;{insertSearch}&quot;</p>
                </div>
              )}
            </div>
          </div>
        </div>);
      })()}

      {/* ═══ AI Image / Video Generation Popup ═══ */}
      {showAiImagePopup && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => { if (aiGenerating) return; setShowAiImagePopup(false); setSwipeMediaKind(null); setAiExtraImages([]); }}>
          <div className="bg-white text-slate-900 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-violet-600 to-purple-600 px-5 py-4 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                  <Sparkles className="h-4 w-4 text-white" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Generate Media with AI</h3>
                  <p className="text-[10px] text-violet-200">fal.ai — text-to-image, image edit and image-to-video</p>
                </div>
              </div>
              <button onClick={() => { if (aiGenerating) return; setShowAiImagePopup(false); setSwipeMediaKind(null); setAiExtraImages([]); }} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors" disabled={aiGenerating}>
                <X className="h-4 w-4 text-white" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-200 bg-slate-50 shrink-0">
              {([
                { id: 'text2image', label: 'Generate', icon: ImagePlus },
                { id: 'image2image', label: 'Edit', icon: Wand2 },
                { id: 'image2video', label: 'Animate', icon: Film },
                { id: 'text2video', label: 'Swipe', icon: Sparkles },
              ] as const).map((tab) => {
                const Icon = tab.icon;
                const active = aiMode === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => !aiGenerating && setAiMode(tab.id)}
                    disabled={aiGenerating}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                      active
                        ? 'text-violet-700 bg-white border-b-2 border-violet-600'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="p-5 space-y-4 overflow-y-auto">
              {/* Product selector (My Projects): basa il prompt sul prodotto
                  scelto anche se la pagina è solo clonata senza prodotto.
                  Usa `resolvedAvailableProducts` (prop oppure fallback dallo
                  store) — vedi commento sul fallback più sopra: senza questo
                  il selettore appariva solo da front-end-funnel. */}
              {resolvedAvailableProducts.length > 0 && (
                <div>
                  <label className="text-[10px] text-violet-500 font-medium mb-1 block uppercase tracking-wider">Product (My Projects)</label>
                  <select
                    value={selectedProductId}
                    onChange={(e) => handleProductSelect(e.target.value)}
                    disabled={aiGenerating}
                    className="w-full px-2.5 py-2 text-xs text-slate-900 border border-violet-200 rounded-lg focus:border-violet-400 outline-none bg-white"
                  >
                    <option value="">— No product —</option>
                    {resolvedAvailableProducts.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-slate-400 mt-1">
                    {selectedProductId
                      ? 'Claude writes the prompt based on this product.'
                      : 'Select it so Claude can write a targeted prompt (useful on cloned-only pages).'}
                  </p>
                </div>
              )}

              {/* Model selector */}
              <div>
                <label className="text-[10px] text-violet-500 font-medium mb-1 block uppercase tracking-wider">AI Model</label>
                <select
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  disabled={aiGenerating}
                  className="w-full px-2.5 py-2 text-xs text-slate-900 border border-violet-200 rounded-lg focus:border-violet-400 outline-none bg-white"
                >
                  {AI_MODELS[aiMode].map((m) => (
                    <option key={m.id} value={m.id}>{m.label} — {m.hint}</option>
                  ))}
                </select>
              </div>

              {/* Image upload: in Modifica/Anima è la sorgente (obbligatoria),
                  in Genera/Swipe è un riferimento opzionale che Claude può
                  analizzare per scrivere un prompt mirato al prodotto. */}
              {(() => {
                const isSource = aiMode === 'image2image' || aiMode === 'image2video';
                return (
                  <div>
                    <label className="text-[10px] text-violet-500 font-medium mb-1 block uppercase tracking-wider">
                      {isSource ? 'Source image' : 'Reference image (optional)'}
                    </label>
                    {aiSourceImage ? (
                      <div className="space-y-2">
                        <div className="relative">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={aiSourceImage} alt="source" className="w-full max-h-40 object-contain rounded-lg border border-violet-200 bg-slate-50" />
                          <button
                            onClick={() => !aiGenerating && setAiSourceImage('')}
                            className="absolute top-1.5 right-1.5 p-1 rounded-md bg-black/60 hover:bg-black/80 text-white"
                            disabled={aiGenerating}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={handleAnalyzeReferenceImage}
                          disabled={aiGenerating || swipeVisionLoading}
                          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-700 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
                          title={effectiveProduct?.name ? `Claude analyzes the image and writes the prompt for ${effectiveProduct.name}` : 'Select a product above for a targeted prompt'}
                        >
                          {swipeVisionLoading ? (
                            <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Claude is analyzing…</>
                          ) : (
                            <><Sparkles className="h-3.5 w-3.5" /> Analyze with Claude and write the prompt</>
                          )}
                        </button>
                        {/* Permette di sostituire l'immagine senza dover prima
                            cliccare la X: carica direttamente un altro file. */}
                        <label className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-violet-200 hover:border-violet-400 hover:bg-violet-50 transition-colors cursor-pointer text-xs text-violet-600 font-medium ${aiSourceUploading ? 'opacity-60 cursor-wait' : ''}`}>
                          {aiSourceUploading ? (
                            <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading…</>
                          ) : (
                            <><Upload className="h-3.5 w-3.5" /> Upload another image</>
                          )}
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            disabled={aiSourceUploading || aiGenerating}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleAiSourceUpload(f);
                              e.target.value = '';
                            }}
                          />
                        </label>
                      </div>
                    ) : (
                      <label className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-violet-300 hover:border-violet-500 hover:bg-violet-50 transition-colors cursor-pointer text-xs text-violet-600 font-medium ${aiSourceUploading ? 'opacity-60 cursor-wait' : ''}`}>
                        {aiSourceUploading ? (
                          <><Loader2 className="h-4 w-4 animate-spin" /> Uploading…</>
                        ) : (
                          <><Upload className="h-4 w-4" /> {isSource ? 'Upload source image' : 'Upload reference image'}</>
                        )}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          disabled={aiSourceUploading || aiGenerating}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleAiSourceUpload(f);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    )}
                  </div>
                );
              })()}

              {/* Immagine prodotto (solo Modifica): seconda immagine fusa con
                  la sorgente per "metti il nostro prodotto al posto di questo". */}
              {aiMode === 'image2image' && (
                <div>
                  <label className="text-[10px] text-violet-500 font-medium mb-1 block uppercase tracking-wider">Product image (to insert)</label>
                  {aiProductImage ? (
                    <div className="space-y-2">
                      <div className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={aiProductImage} alt="prodotto" className="w-full max-h-40 object-contain rounded-lg border border-emerald-200 bg-slate-50" />
                        <button
                          onClick={() => !aiGenerating && setAiProductImage('')}
                          className="absolute top-1.5 right-1.5 p-1 rounded-md bg-black/60 hover:bg-black/80 text-white"
                          disabled={aiGenerating}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAiPrompt(
                          `Replace the product shown in the first image with the product from the second image. Keep the same scene, composition, framing, lighting and background. Integrate our product naturally and realistically.${effectiveProduct?.name ? ` Our product is ${effectiveProduct.name}.` : ''}`,
                        )}
                        disabled={aiGenerating}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
                      >
                        <Wand2 className="h-3.5 w-3.5" /> Use prompt: replace the product
                      </button>
                    </div>
                  ) : (
                    <label className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-emerald-300 hover:border-emerald-500 hover:bg-emerald-50 transition-colors cursor-pointer text-xs text-emerald-600 font-medium ${aiProductUploading ? 'opacity-60 cursor-wait' : ''}`}>
                      {aiProductUploading ? (
                        <><Loader2 className="h-4 w-4 animate-spin" /> Uploading…</>
                      ) : (
                        <><Upload className="h-4 w-4" /> Upload our product photo</>
                      )}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={aiProductUploading || aiGenerating}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleAiProductUpload(f);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  )}
                  <p className="text-[10px] text-slate-400 mt-1">
                    Works with multi-image edit models (Nano Banana 2 / GPT Image 2).
                  </p>
                </div>
              )}

              {/* Immagini extra (collage): più foto da combinare nell'edit
                  multi-immagine. Pulsante "+" per aggiungerne quante servono. */}
              {aiMode === 'image2image' && (
                <div>
                  <label className="text-[10px] text-violet-500 font-medium mb-1 block uppercase tracking-wider">Extra images (collage)</label>
                  <div className="grid grid-cols-3 gap-2">
                    {aiExtraImages.map((src, i) => (
                      <div key={i} className="relative aspect-square rounded-lg border border-violet-200 overflow-hidden bg-slate-50">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt={`extra ${i + 1}`} className="w-full h-full object-cover" />
                        <button
                          onClick={() => !aiGenerating && setAiExtraImages((prev) => prev.filter((_, j) => j !== i))}
                          className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/60 hover:bg-black/80 text-white"
                          disabled={aiGenerating}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                    <label className={`aspect-square flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-violet-300 hover:border-violet-500 hover:bg-violet-50 transition-colors cursor-pointer text-violet-500 ${aiExtraUploading ? 'opacity-60 cursor-wait' : ''}`}>
                      {aiExtraUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
                      <span className="text-[9px] font-medium">Add</span>
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        disabled={aiExtraUploading || aiGenerating}
                        onChange={(e) => { if (e.target.files?.length) handleAiExtraUpload(e.target.files); e.target.value = ''; }}
                      />
                    </label>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">
                    Add more photos to combine into a collage. They add to the source and the product photo.
                  </p>
                </div>
              )}

              {/* Context (text2image only) */}
              {aiMode === 'text2image' && aiContextText && (
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Automatically detected context</p>
                  <p className="text-xs text-slate-600 leading-relaxed line-clamp-3">{aiContextText}</p>
                </div>
              )}

              {/* Swipe-for-Product banner (text2video o text2image aperto dal bottone Swipe) */}
              {swipeMediaKind && (aiMode === 'text2video' || aiMode === 'text2image') && (swipeVisionLoading || aiContextText || swipeVisionError) && (
                <div className="p-3 rounded-lg bg-gradient-to-r from-violet-50 via-fuchsia-50 to-pink-50 border border-fuchsia-200">
                  <div className="flex items-start gap-2">
                    {(swipeVisionLoading || aiGenerating) ? (
                      <Loader2 className="h-3.5 w-3.5 text-fuchsia-600 mt-0.5 shrink-0 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5 text-fuchsia-600 mt-0.5 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-[11px] font-bold text-fuchsia-800">
                          {swipeVisionLoading
                            ? swipeStage === 'extracting'
                              ? swipeMediaKind === 'image'
                                ? 'Extracting the image context\u2026'
                                : 'Extracting 3 frames from the video\u2026'
                              : swipeMediaKind === 'image'
                                ? 'Claude is examining the image\u2026'
                                : 'Claude is examining the frames\u2026'
                            : aiGenerating
                              ? swipeMediaKind === 'image'
                                ? 'Swiping the image for your product\u2026'
                                : 'Swiping the video for your product\u2026'
                              : swipeMediaKind === 'image'
                                ? 'Swipe Image for Product'
                                : 'Swipe Video for Product'}
                        </p>
                        {!swipeVisionLoading && swipeFramesUsed > 0 && swipeMediaKind === 'video' && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-emerald-100 text-emerald-700" title="Number of frames from the original clip that Claude analyzed">
                            {swipeFramesUsed} frame
                          </span>
                        )}
                        {swipeVisionIntent && !swipeVisionLoading && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-bold bg-fuchsia-100 text-fuchsia-700">
                            {swipeVisionIntent}
                          </span>
                        )}
                        {swipeVisionMode === 'vision' && !swipeVisionLoading && (
                          <span className="text-[9px] uppercase tracking-wider font-semibold text-emerald-600">
                            ◉ vision on
                          </span>
                        )}
                        {swipeVisionMode === 'text' && !swipeVisionLoading && (
                          <span className="text-[9px] uppercase tracking-wider font-medium text-slate-500" title="Source not available, text-only analysis">
                            text-only
                          </span>
                        )}
                        <span
                          className="text-[9px] uppercase tracking-wider font-medium text-violet-600 ml-auto"
                          title={
                            swipeMediaKind === 'image'
                              ? 'Text-to-Image: the AI invents the composition from the prompt, without a source photo'
                              : 'Text-to-Video: the AI invents the scene from the prompt, without a source photo'
                          }
                        >
                          {swipeMediaKind === 'image' ? 'T2I' : 'T2V'}
                        </span>
                      </div>

                      {swipeVisionLoading ? (
                        <p className="text-[11px] text-slate-600 leading-relaxed mt-0.5">
                          {swipeMediaKind === 'image'
                            ? 'Claude is analyzing the image to understand the intent (hero / before-after / lifestyle / diagram\u2026) and suggest a targeted prompt for your product.'
                            : 'Claude is analyzing the clip poster to understand the intent (demo / before-after / lifestyle\u2026) and suggest a targeted prompt for your product.'}
                        </p>
                      ) : (
                        <>
                          {aiContextText && (
                            <p className="text-[11px] text-slate-600 leading-relaxed mt-0.5">
                              <span className="text-slate-500">
                                {swipeMediaKind === 'image' ? 'Original image:' : 'Original clip:'}
                              </span>{' '}
                              <span className="italic text-slate-700">&ldquo;{aiContextText.substring(0, 200)}{aiContextText.length > 200 ? '…' : ''}&rdquo;</span>
                            </p>
                          )}
                          {swipeVisionError ? (
                            <p className="text-[11px] text-amber-700 leading-relaxed mt-1">
                              Vision analysis failed ({swipeVisionError}). I left you a generic prompt — feel free to edit it before generating.
                            </p>
                          ) : (
                            <>
                              {/* Insights estratti da Claude (chain-of-thought) */}
                              {(swipeBigIdea || swipeTargetAudience || swipeAnalysis) && (
                                <div className="mt-2 space-y-1">
                                  {swipeBigIdea && (
                                    <div className="rounded-md bg-white/60 border border-fuchsia-200/70 px-2 py-1.5">
                                      <p className="text-[9px] font-bold uppercase tracking-wider text-fuchsia-700">Big Idea</p>
                                      <p className="text-[11px] text-slate-700 leading-snug mt-0.5 italic">&ldquo;{swipeBigIdea}&rdquo;</p>
                                    </div>
                                  )}
                                  {swipeTargetAudience && (
                                    <div className="rounded-md bg-white/40 border border-fuchsia-200/50 px-2 py-1">
                                      <p className="text-[9px] font-bold uppercase tracking-wider text-fuchsia-700 inline">Audience </p>
                                      <span className="text-[11px] text-slate-700 leading-snug">{swipeTargetAudience}</span>
                                    </div>
                                  )}
                                  {swipeAnalysis && (
                                    <details className="group">
                                      <summary className="cursor-pointer text-[10px] font-semibold text-fuchsia-700 hover:text-fuchsia-900 select-none">
                                        ▸ Technical analysis
                                      </summary>
                                      <p className="text-[10px] text-slate-600 leading-snug mt-1 pl-3 border-l-2 border-fuchsia-200">
                                        {swipeAnalysis}
                                      </p>
                                    </details>
                                  )}
                                </div>
                              )}
                              <p className="text-[11px] text-slate-600 leading-relaxed mt-2">
                                {swipeMediaKind === 'image' ? (
                                  <>
                                    The prompt below describes the <strong>full composition</strong> for the text-to-image model. Edit it or use the presets below.
                                  </>
                                ) : (
                                  <>
                                    The prompt below describes the <strong>entire scene</strong> for Seedance 2.0 text-to-video. Edit it or use the presets below.
                                  </>
                                )}
                              </p>
                            </>
                          )}

                          {/* Rigenera prompt con guidance utente + preset angle */}
                          {!aiGenerating && (
                            <div className="mt-2 pt-2 border-t border-fuchsia-200/60">
                              {/* Preset rapidi: angolazioni narrative pronte */}
                              <div className="flex flex-wrap gap-1 mb-2">
                                {[
                                  { key: 'dramatic', label: 'More dramatic', tip: 'Make it more dramatic and emotional WITHOUT changing the original format/genre: stronger emotional contrast, higher stakes, more intense expression and lighting. If (and only if) it is a before/after, widen the gap between the before-pain and the after-relief; otherwise just intensify the emotion within the same kind of shot.' },
                                  { key: 'scientific', label: 'More scientific', tip: 'Make it more scientific and clinical: a doctor or expert visible, lab/clinic setting, infographic overlays of the mechanism (cross-section, glowing pathways), confident expert voice in the framing.' },
                                  { key: 'emotional', label: 'More emotional', tip: 'Make it more emotional and human: tears of relief, hugging family members, real human moments — the transformation must hit the heart, not just the eyes.' },
                                  { key: 'mechanism', label: 'Show mechanism', tip: 'Make the unique mechanism the absolute hero of the visual: zoom into the mechanism in action (audio waves, ingredient stream, device glow) for the longest middle beat. Make it impossible to miss what makes this product different.' },
                                  { key: 'lifestyle', label: 'More lifestyle', tip: 'Tone it down — make it a confident lifestyle vibe instead of a clinical demo: real-life setting, golden hour, the protagonist living their best life with the product naturally integrated.' },
                                ].map((p) => (
                                  <button
                                    key={p.key}
                                    type="button"
                                    onClick={() => {
                                      if (swipeVisionLoading) return;
                                      setSwipeExtraGuidance(p.tip);
                                      void runSwipeAnalysis({ extraGuidance: p.tip, autoFire: false });
                                    }}
                                    disabled={swipeVisionLoading}
                                    className="px-1.5 py-0.5 text-[10px] font-medium rounded-md bg-white/60 border border-fuchsia-200 text-fuchsia-700 hover:bg-fuchsia-100 hover:border-fuchsia-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                    title={p.tip}
                                  >
                                    {p.label}
                                  </button>
                                ))}
                              </div>

                              <label className="text-[10px] font-bold uppercase tracking-wider text-fuchsia-700 block mb-1">
                                Or write your own (optional)
                              </label>
                              <textarea
                                value={swipeExtraGuidance}
                                onChange={(e) => setSwipeExtraGuidance(e.target.value)}
                                disabled={swipeVisionLoading}
                                placeholder="E.g.: show the unique mechanism — an overweight person listening to the frequency with headphones and then slimmed down."
                                rows={2}
                                className="w-full px-2 py-1.5 text-[11px] rounded-md border border-fuchsia-200 bg-white text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-fuchsia-400 resize-none"
                              />
                              <button
                                type="button"
                                onClick={handleRegenerateSwipePrompt}
                                disabled={swipeVisionLoading}
                                className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-md bg-fuchsia-600 hover:bg-fuchsia-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white transition-colors"
                              >
                                {swipeVisionLoading ? (
                                  <><Loader2 className="h-3 w-3 animate-spin" /> Regenerating…</>
                                ) : (
                                  <><Sparkles className="h-3 w-3" /> Regenerate prompt</>
                                )}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="text-xs text-violet-700 font-semibold mb-1.5 block">
                  {aiMode === 'text2image'
                    ? 'Prompt (optional)'
                    : aiMode === 'image2image'
                      ? 'What to edit'
                      : aiMode === 'text2video'
                        ? 'Describe the video scene'
                        : 'How to animate'}
                </label>
                <textarea
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder={
                    aiMode === 'text2image'
                      ? (aiContextText ? 'Leave empty to generate from the context above, or describe the image...' : 'Describe the image you want to generate...')
                      : aiMode === 'image2image'
                        ? 'E.g.: change the background to a tropical beach, add sunglasses...'
                        : aiMode === 'text2video'
                          ? 'E.g.: medium shot of a woman on the couch wearing Metabolic Wave headphones, warm light, 5s slow push-in, cinematic, no text, no audio.'
                          : 'E.g.: the person smiles and winks, slight zoom in...'
                  }
                  rows={3}
                  className="w-full px-3 py-2.5 text-sm text-slate-900 border border-violet-200 rounded-xl focus:border-violet-400 focus:ring-2 focus:ring-violet-100 outline-none resize-none transition-all placeholder:text-slate-400"
                  disabled={aiGenerating}
                />
              </div>

              {/* Format + style for text2image */}
              {aiMode === 'text2image' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-violet-500 font-medium mb-1 block">Format</label>
                    <select
                      value={aiSize}
                      onChange={(e) => setAiSize(e.target.value as typeof aiSize)}
                      className="w-full px-2.5 py-2 text-xs text-slate-900 border border-violet-200 rounded-lg focus:border-violet-400 outline-none bg-white"
                      disabled={aiGenerating}
                    >
                      <option value="1024x1024">Square (1:1)</option>
                      <option value="1792x1024">Landscape (16:9)</option>
                      <option value="1024x1792">Portrait (9:16)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-violet-500 font-medium mb-1 block">Style</label>
                    <select
                      value={aiStyle}
                      onChange={(e) => setAiStyle(e.target.value as typeof aiStyle)}
                      className="w-full px-2.5 py-2 text-xs text-slate-900 border border-violet-200 rounded-lg focus:border-violet-400 outline-none bg-white"
                      disabled={aiGenerating}
                    >
                      <option value="vivid">Vivid (intense colors)</option>
                      <option value="natural">Natural (photorealistic)</option>
                    </select>
                  </div>
                </div>
              )}

              {/* Duration + loop for image2video */}
              {aiMode === 'image2video' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-violet-500 font-medium mb-1 block">Duration</label>
                    <select
                      value={aiVideoDuration}
                      onChange={(e) => setAiVideoDuration(Number(e.target.value) as 5 | 10)}
                      className="w-full px-2.5 py-2 text-xs text-slate-900 border border-violet-200 rounded-lg focus:border-violet-400 outline-none bg-white"
                      disabled={aiGenerating}
                    >
                      <option value={5}>5 seconds</option>
                      <option value={10}>10 seconds</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-violet-500 font-medium mb-1 block">Playback</label>
                    <label className="flex items-center gap-2 px-2.5 py-2 text-xs border border-violet-200 rounded-lg bg-white cursor-pointer">
                      <input
                        type="checkbox"
                        checked={aiVideoLoop}
                        onChange={(e) => setAiVideoLoop(e.target.checked)}
                        disabled={aiGenerating}
                        className="accent-violet-600"
                      />
                      <span className="text-slate-700">Loop (like GIF)</span>
                    </label>
                  </div>
                </div>
              )}

              <button
                onClick={handleAiGenerate}
                disabled={aiGenerating || aiSourceUploading}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 disabled:opacity-60 disabled:cursor-not-allowed transition-all shadow-md hover:shadow-lg"
              >
                {aiGenerating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {aiMode === 'image2video' || aiMode === 'text2video'
                      ? 'Generating video... (may take 1-2 min)'
                      : 'Generating...'}
                  </>
                ) : aiMode === 'text2image' ? (
                  <>
                    <ImagePlus className="h-4 w-4" />
                    {aiPrompt.trim() ? 'Generate Image' : aiContextText ? 'Generate from Context' : 'Generate Image'}
                  </>
                ) : aiMode === 'image2image' ? (
                  <>
                    <Wand2 className="h-4 w-4" />
                    Edit Image
                  </>
                ) : aiMode === 'text2video' ? (
                  <>
                    <Sparkles className="h-4 w-4" />
                    Generate Video (Swipe)
                  </>
                ) : (
                  <>
                    <Film className="h-4 w-4" />
                    Animate Image
                  </>
                )}
              </button>

              {aiError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200">
                  <p className="text-xs text-red-600 font-medium">{aiError}</p>
                </div>
              )}

              {aiRevisedPrompt && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                  <p className="text-[10px] text-emerald-600 font-semibold mb-0.5">Description generated by the model:</p>
                  <p className="text-xs text-emerald-700 leading-relaxed">{aiRevisedPrompt}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ Tracking Snippet Dialog ═══
          Popup attivato dal pulsante "Tracking" in toolbar. L'utente
          incolla un URL (es. https://cdn.example.com/track.js) o un
          tag completo (Meta Pixel, GA4, custom). Lo snippet viene
          iniettato subito dopo `<head>` da handleApplyTracking. */}
      {showTrackingDialog && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => !trackingApplied && setShowTrackingDialog(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-[560px] max-w-[95vw] overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 bg-gradient-to-r from-emerald-500 to-teal-500 text-white">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-white/15">
                  <Activity className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-base leading-tight">Insert tracking snippet</h3>
                  <p className="text-xs text-white/80 leading-tight">Injected right after &lt;head&gt;</p>
                </div>
              </div>
              <button
                onClick={() => setShowTrackingDialog(false)}
                className="p-1 rounded-lg hover:bg-white/20 transition-colors"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-3">
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide">
                URL or HTML snippet
              </label>
              <textarea
                value={trackingInput}
                onChange={e => {
                  setTrackingInput(e.target.value);
                  if (trackingError) setTrackingError(null);
                }}
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    handleApplyTracking();
                  }
                }}
                placeholder={'https://cdn.example.com/track.js\n\nor paste a full tag:\n\n<script>\n  !function(){/* Meta Pixel / GA4 / custom */}();\n</script>'}
                rows={8}
                className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm font-mono text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent resize-y"
                autoFocus
              />
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Bare URLs are wrapped in <code className="font-mono bg-slate-100 px-1 rounded">&lt;script src async&gt;</code>.
                Tags starting with <code className="font-mono bg-slate-100 px-1 rounded">&lt;</code> are used as-is.
                Re-applying the same snippet does NOT duplicate it.
              </p>

              {trackingError && (
                <div className="p-2.5 rounded-lg bg-red-50 border border-red-200">
                  <p className="text-xs text-red-600 font-medium">{trackingError}</p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 bg-slate-50 border-t border-slate-200">
              <button
                onClick={() => setShowTrackingDialog(false)}
                className="px-3 py-1.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleApplyTracking}
                disabled={trackingApplied || !trackingInput.trim()}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  trackingApplied ? 'bg-emerald-500' : 'bg-emerald-600 hover:bg-emerald-500'
                }`}
              >
                {trackingApplied ? (
                  <>
                    <CheckCircle className="h-4 w-4" />
                    Inserted
                  </>
                ) : (
                  <>
                    <Activity className="h-4 w-4" />
                    Insert into &lt;head&gt;
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Save Section Dialog ═══ */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-[520px] max-w-[95vw] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-emerald-600 to-teal-600 text-white">
              <div className="flex items-center gap-2.5">
                <BookmarkPlus className="h-5 w-5" />
                <div>
                  <h3 className="text-sm font-bold">Save Section to Library</h3>
                  <p className="text-[10px] text-emerald-100">Make the section reusable across other funnels</p>
                </div>
              </div>
              <button onClick={() => setShowSaveDialog(false)} className="p-1 rounded-lg hover:bg-white/20 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Preview */}
              <div className="bg-slate-50 rounded-xl border border-slate-200 p-3">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Section preview</p>
                <p className="text-xs text-slate-600 leading-relaxed line-clamp-3">
                  {pendingSectionHtml.replace(/<[^>]*>/g, '').substring(0, 200) || '(empty section)'}
                </p>
                <p className="text-[10px] text-slate-400 mt-1">{pendingSectionHtml.length.toLocaleString()} HTML characters</p>
              </div>

              {/* Name */}
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1 block">Section name *</label>
                <input
                  type="text"
                  value={saveSectionName}
                  onChange={(e) => setSaveSectionName(e.target.value)}
                  placeholder="E.g.: Hero with video testimonial, red urgency CTA..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 outline-none transition-all"
                  autoFocus
                />
              </div>

              {/* Type + Tags */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-700 mb-1 block">Section type</label>
                  <select
                    value={saveSectionType}
                    onChange={(e) => setSaveSectionType(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:border-emerald-500 outline-none"
                  >
                    {SECTION_TYPE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-700 mb-1 block">Tags (comma sep.)</label>
                  <input
                    type="text"
                    value={saveSectionTags}
                    onChange={(e) => setSaveSectionTags(e.target.value)}
                    placeholder="cta, red, urgency..."
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:border-emerald-500 outline-none"
                  />
                </div>
              </div>

              {/* AI Rewrite toggle */}
              <div className="bg-violet-50 rounded-xl border border-violet-200 p-3">
                <label className="flex items-center justify-between cursor-pointer">
                  <div className="flex items-center gap-2.5">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-violet-500/10">
                      <Sparkles className="h-4 w-4 text-violet-600" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-violet-800">Rewrite with AI</p>
                      <p className="text-[10px] text-violet-500">Make the section standalone, ready to share</p>
                    </div>
                  </div>
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={saveSectionAiRewrite}
                      onChange={(e) => setSaveSectionAiRewrite(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-10 h-5 bg-slate-300 rounded-full peer-checked:bg-violet-600 transition-colors" />
                    <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5 shadow" />
                  </div>
                </label>

                {saveSectionAiRewrite && (
                  <div className="mt-3 space-y-3">
                    {/* Model selector */}
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-violet-500 shrink-0">Model:</span>
                      <div className="flex bg-white rounded-lg p-0.5 border border-violet-200">
                        <button
                          onClick={() => setSaveSectionModel('claude')}
                          className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all ${
                            saveSectionModel === 'claude' ? 'bg-amber-500 text-white' : 'text-slate-400 hover:text-slate-600'
                          }`}
                        >Claude</button>
                        <button
                          onClick={() => setSaveSectionModel('gemini')}
                          className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all ${
                            saveSectionModel === 'gemini' ? 'bg-blue-500 text-white' : 'text-slate-400 hover:text-slate-600'
                          }`}
                        >Gemini</button>
                      </div>
                    </div>

                    {/* Output Stack selector */}
                    <div>
                      <label className="text-[10px] font-bold text-violet-600 uppercase tracking-wider mb-1.5 block">Output Stack</label>
                      <div className="grid grid-cols-3 gap-1.5">
                        {OUTPUT_STACK_OPTIONS.map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => setSaveSectionStack(opt.value)}
                            className={`flex flex-col items-start px-2.5 py-2 rounded-lg text-left transition-all border ${
                              saveSectionStack === opt.value
                                ? 'bg-violet-600 text-white border-violet-600 shadow-md shadow-violet-500/20'
                                : 'bg-white text-slate-600 border-slate-200 hover:border-violet-300 hover:bg-violet-50'
                            }`}
                          >
                            <span className={`text-[11px] font-bold ${saveSectionStack === opt.value ? 'text-white' : 'text-slate-700'}`}>
                              {opt.label}
                            </span>
                            <span className={`text-[9px] leading-tight mt-0.5 ${saveSectionStack === opt.value ? 'text-violet-200' : 'text-slate-400'}`}>
                              {opt.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Custom instructions (only for 'custom' stack) */}
                    {saveSectionStack === 'custom' && (
                      <div>
                        <label className="text-[10px] font-semibold text-violet-600 mb-1 block">Custom instructions</label>
                        <textarea
                          value={saveSectionCustomInstructions}
                          onChange={(e) => setSaveSectionCustomInstructions(e.target.value)}
                          placeholder="E.g.: Use only semantic HTML with BEM naming, CSS custom properties, and native Web Components..."
                          rows={3}
                          className="w-full px-3 py-2 border border-violet-200 rounded-lg text-xs focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 outline-none resize-none"
                        />
                      </div>
                    )}

                    {/* Stack info hint */}
                    {saveSectionStack === 'bootstrap' && (
                      <div className="flex items-start gap-2 p-2 rounded-lg bg-blue-50 border border-blue-200">
                        <FileCode className="h-3.5 w-3.5 text-blue-500 shrink-0 mt-0.5" />
                        <p className="text-[10px] text-blue-600 leading-relaxed">
                          AI will rewrite the section using Bootstrap 5 classes (.container, .row, .col-*, .btn, .card, etc.) with vanilla JS for interactivity. Ready to paste into any Bootstrap project.
                        </p>
                      </div>
                    )}
                    {saveSectionStack === 'tailwind' && (
                      <div className="flex items-start gap-2 p-2 rounded-lg bg-cyan-50 border border-cyan-200">
                        <FileCode className="h-3.5 w-3.5 text-cyan-500 shrink-0 mt-0.5" />
                        <p className="text-[10px] text-cyan-600 leading-relaxed">
                          AI will use Tailwind utility classes (flex, grid, p-*, text-*, bg-*, etc.) without a separate &lt;style&gt; tag. Requires Tailwind CSS in the target project.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Error */}
              {saveSectionError && (
                <div className="p-2.5 rounded-lg bg-red-50 border border-red-200">
                  <p className="text-xs text-red-600 font-medium">{saveSectionError}</p>
                </div>
              )}

              {/* Success */}
              {saveSectionSuccess && (
                <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-emerald-600" />
                  <p className="text-xs text-emerald-700 font-semibold">Section saved to library!</p>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => setShowSaveDialog(false)}
                  disabled={saveSectionRunning}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
                >Cancel</button>
                <button
                  onClick={handleSaveSection}
                  disabled={!saveSectionName.trim() || saveSectionRunning || saveSectionSuccess}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-bold text-white bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg"
                >
                  {saveSectionRunning ? (
                    <><Loader2 className="h-4 w-4 animate-spin" />Saving{saveSectionAiRewrite ? ' + AI...' : '...'}</>
                  ) : (
                    <><Save className="h-4 w-4" />Save to Library</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Section Library Panel ═══ */}
      {showSectionLibrary && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-[780px] max-w-[95vw] max-h-[85vh] overflow-hidden flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white shrink-0">
              <div className="flex items-center gap-2.5">
                <Library className="h-5 w-5" />
                <div>
                  <h3 className="text-sm font-bold">Saved Sections Library</h3>
                  <p className="text-[10px] text-indigo-200">{savedSections.length} sections available</p>
                </div>
              </div>
              <button onClick={() => setShowSectionLibrary(false)} className="p-1 rounded-lg hover:bg-white/20 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Filters */}
            <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                  <input
                    type="text"
                    value={librarySearch}
                    onChange={(e) => setLibrarySearch(e.target.value)}
                    placeholder="Search by name, text or tag..."
                    className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 outline-none"
                  />
                </div>
                <select
                  value={libraryFilterType}
                  onChange={(e) => setLibraryFilterType(e.target.value)}
                  className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:border-indigo-500 outline-none"
                >
                  <option value="all">All types</option>
                  {SECTION_TYPE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Sections Grid */}
            <div className="flex-1 overflow-y-auto p-4">
              {filteredLibrarySections.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <BookOpen className="h-12 w-12 text-slate-200 mb-3" />
                  <p className="text-sm font-medium text-slate-500">
                    {savedSections.length === 0 ? 'No saved sections' : 'No results for this search'}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    {savedSections.length === 0
                      ? 'Select an element in the editor and click "Save Section" to get started'
                      : 'Try changing the search filters'}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {filteredLibrarySections.map((section) => (
                    <div
                      key={section.id}
                      className="bg-white rounded-xl border border-slate-200 hover:border-indigo-300 hover:shadow-md transition-all group overflow-hidden"
                    >
                      {/* Section Card Header */}
                      <div className="px-3.5 pt-3 pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <h4 className="text-sm font-bold text-slate-800 truncate">{section.name}</h4>
                            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded-full">
                                <Tag className="h-2.5 w-2.5" />
                                {SECTION_TYPE_OPTIONS.find(o => o.value === section.sectionType)?.label || section.sectionType}
                              </span>
                              {section.aiRewritten && (
                                <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded-full">
                                  <Sparkles className="h-2.5 w-2.5" />AI
                                </span>
                              )}
                              {section.outputStack && section.outputStack !== 'pure_css' && (
                                <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full">
                                  <FileCode className="h-2.5 w-2.5" />
                                  {OUTPUT_STACK_OPTIONS.find(o => o.value === section.outputStack)?.label || section.outputStack}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Text preview */}
                      <div className="px-3.5 pb-2">
                        <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-2">
                          {section.textPreview || '(empty)'}
                        </p>
                      </div>

                      {/* Tags */}
                      {section.tags.length > 0 && (
                        <div className="px-3.5 pb-2 flex items-center gap-1 flex-wrap">
                          {section.tags.map((tag, i) => (
                            <span key={i} className="text-[9px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Preview iframe (collapsible) */}
                      {previewSectionId === section.id && (
                        <div className="mx-3.5 mb-2 rounded-lg overflow-hidden border border-slate-200 bg-white" style={{ height: '180px' }}>
                          <iframe
                            srcDoc={section.html}
                            className="w-full h-full border-0"
                            title={`Preview: ${section.name}`}
                            sandbox="allow-same-origin"
                            style={{ transform: 'scale(0.5)', transformOrigin: 'top left', width: '200%', height: '200%' }}
                          />
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex items-center justify-between px-3.5 py-2 bg-slate-50 border-t border-slate-100">
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                          <Clock className="h-3 w-3" />
                          {new Date(section.createdAt).toLocaleDateString('en-US')}
                          <span className="text-slate-300">·</span>
                          <FileCode className="h-3 w-3" />
                          {(section.html.length / 1024).toFixed(1)}KB
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setPreviewSectionId(previewSectionId === section.id ? null : section.id)}
                            className="p-1.5 rounded-md text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            title="Preview"
                          >
                            <EyeIcon className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(section.html);
                            }}
                            className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                            title="Copy HTML"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleImportSection(section)}
                            disabled={importingId === section.id}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold text-white bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 transition-all shadow-sm"
                            title="Import into current page"
                          >
                            {importingId === section.id ? (
                              <><CheckCircle className="h-3 w-3" />Imported!</>
                            ) : (
                              <><ArrowDownToLine className="h-3 w-3" />Import</>
                            )}
                          </button>
                          <button
                            onClick={() => handleDeleteSection(section.id)}
                            className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                            title="Delete section"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ AI Edit Panel (Floating) ═══ */}
      {showAiEditPanel && (
        <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-[70] w-[680px] max-w-[95vw]">
          <div className="bg-slate-900/98 backdrop-blur-xl rounded-2xl border border-violet-500/30 shadow-2xl shadow-violet-500/10 overflow-hidden">
            {/* Panel Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-700/50">
              <div className="flex items-center gap-2.5">
                <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 shadow-lg shadow-violet-500/30">
                  <Bot className="h-4 w-4 text-white" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">AI Code Editor</h3>
                  <p className="text-[10px] text-slate-400">Edit the entire page with AI using intelligent chunking</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Model Switcher */}
                <div className="flex items-center bg-slate-800 rounded-lg p-0.5 border border-slate-700">
                  <button
                    onClick={() => setAiEditModel('claude')}
                    disabled={aiEditRunning}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                      aiEditModel === 'claude'
                        ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-md'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Zap className="h-3 w-3" />Claude
                  </button>
                  <button
                    onClick={() => setAiEditModel('gemini')}
                    disabled={aiEditRunning}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                      aiEditModel === 'gemini'
                        ? 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-md'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Sparkles className="h-3 w-3" />Gemini
                  </button>
                </div>
                <button onClick={() => setShowAiEditPanel(false)} className="p-1 rounded-lg text-slate-500 hover:text-white hover:bg-slate-700 transition-colors">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Quick Presets */}
            <div className="px-4 py-2 border-b border-slate-800/50">
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
                <span className="text-[10px] text-slate-500 shrink-0 mr-1">Quick:</span>
                {aiPresetPrompts.map((preset, i) => (
                  <button
                    key={i}
                    onClick={() => setAiEditPrompt(preset.prompt)}
                    disabled={aiEditRunning}
                    className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-medium bg-slate-800 text-slate-300 hover:bg-violet-600/30 hover:text-violet-200 border border-slate-700 hover:border-violet-500/50 transition-all disabled:opacity-40"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Prompt Input */}
            <div className="p-4">
              <div className="relative">
                <textarea
                  value={aiEditPrompt}
                  onChange={(e) => setAiEditPrompt(e.target.value)}
                  placeholder="Describe how you want to edit the page... E.g.: 'Transform the entire brand to conspiracy style with dark colors, red and gold, mysterious and urgent tone'"
                  rows={3}
                  disabled={aiEditRunning}
                  className="w-full bg-slate-800/60 text-slate-200 text-sm rounded-xl border border-slate-700 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 px-4 py-3 pr-12 resize-none outline-none placeholder:text-slate-500 disabled:opacity-50 transition-all leading-relaxed"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleAiEdit();
                    }
                  }}
                />
                <button
                  onClick={handleAiEdit}
                  disabled={!aiEditPrompt.trim() || aiEditRunning}
                  className="absolute right-2 bottom-2 p-2 rounded-lg bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-lg shadow-violet-500/20 hover:shadow-violet-500/40"
                  title="Start AI edit (Ctrl+Enter)"
                >
                  {aiEditRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </div>

              {/* Progress Bar */}
              {aiEditRunning && aiEditProgress && (
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-violet-300 font-medium flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {aiEditProgress.label}
                    </span>
                    <span className="text-slate-500">
                      {aiEditProgress.chunkIndex + 1} / {aiEditProgress.totalChunks}
                    </span>
                  </div>
                  <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-violet-500 to-purple-500 rounded-full transition-all duration-500 ease-out"
                      style={{ width: `${((aiEditProgress.chunkIndex + 1) / aiEditProgress.totalChunks) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {aiEditRunning && !aiEditProgress && (
                <div className="mt-3 flex items-center gap-2 text-[11px] text-violet-300">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Preparing edit with {aiEditModel === 'claude' ? 'Claude' : 'Gemini'}...</span>
                </div>
              )}

              {/* Error */}
              {aiEditError && (
                <div className="mt-3 p-2.5 rounded-lg bg-red-500/10 border border-red-500/30">
                  <p className="text-[11px] text-red-400 font-medium">{aiEditError}</p>
                </div>
              )}

              {/* AI Edit Undo + Info */}
              <div className="mt-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {aiEditHistory.length > 0 && (
                    <button
                      onClick={handleAiEditUndo}
                      disabled={aiEditRunning}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20 transition-colors disabled:opacity-40"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Undo AI ({aiEditHistory.length})
                    </button>
                  )}
                </div>
                <span className="text-[10px] text-slate-600">
                  {currentHtml.length.toLocaleString()} chars · Ctrl+Enter to send
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Brand Colors Panel (Floating) ═══ */}
      {showBrandColorsPanel && (
        <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-[70] w-[640px] max-w-[95vw]">
          <div className="bg-slate-900/98 backdrop-blur-xl rounded-2xl border border-fuchsia-500/30 shadow-2xl shadow-fuchsia-500/10 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-700/50">
              <div className="flex items-center gap-2.5">
                <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-pink-500 via-fuchsia-500 to-orange-400 shadow-lg shadow-fuchsia-500/30">
                  <Palette className="h-4 w-4 text-white" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Brand Colors</h3>
                  <p className="text-[10px] text-slate-400">
                    Auto-extract a palette from the brief, market research or product photo,
                    then recolor the entire page.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowBrandColorsPanel(false)}
                className="p-1 rounded-lg text-slate-500 hover:text-white hover:bg-slate-700 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="p-4 space-y-3">
              {/* Hidden file input shared by all upload triggers in the panel */}
              <input
                ref={brandFileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/avif"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleBrandImageUpload(f);
                  e.target.value = '';
                }}
              />

              {/* Loading initial extract */}
              {brandExtractRunning && !brandPalette && (
                <div className="flex items-center gap-2 text-[12px] text-fuchsia-300">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Analyzing brief, market research and product photo…</span>
                </div>
              )}

              {/* Needs image upload */}
              {brandNeedsImage && !brandExtractRunning && (
                <div className="space-y-2">
                  <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                    <p className="text-[12px] text-amber-200">
                      No brief, market research or product photo is available for this project.
                      Upload a product photo and I&apos;ll pick the palette from it.
                    </p>
                  </div>
                  <button
                    onClick={() => brandFileInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-pink-500 via-fuchsia-500 to-orange-400 text-white text-sm font-semibold hover:opacity-95 transition-all shadow-lg shadow-fuchsia-500/20"
                  >
                    <ImagePlus className="h-4 w-4" />
                    Upload product photo
                  </button>
                </div>
              )}

              {/* Palette shown */}
              {brandPalette && !brandExtractRunning && (
                <div className="space-y-3">
                  {brandPalette.mood && (
                    <div className="text-[11px] text-slate-400">
                      Detected vibe:{' '}
                      <span className="text-fuchsia-300 font-medium">{brandPalette.mood}</span>
                      <span className="ml-2 text-slate-600">
                        ·{' '}
                        {brandPalette.source === 'image-llm' ? 'from product photo'
                          : brandPalette.source === 'text-hex' ? 'hex colors found in brief'
                          : 'inferred from brief / research'}
                      </span>
                    </div>
                  )}
                  <div className="grid grid-cols-5 gap-2">
                    {([
                      ['primary',    brandPalette.primary],
                      ['secondary',  brandPalette.secondary],
                      ['accent',     brandPalette.accent],
                      ['background', brandPalette.background],
                      ['text',       brandPalette.text],
                    ] as const).map(([role, hex]) => (
                      <label key={role} className="flex flex-col items-stretch gap-1 cursor-pointer group">
                        <div
                          className="h-14 rounded-lg border border-slate-700 shadow-inner relative overflow-hidden group-hover:ring-2 group-hover:ring-fuchsia-400/50 transition-all"
                          style={{ background: hex }}
                        >
                          <input
                            type="color"
                            value={hex}
                            onChange={(e) => {
                              const v = e.target.value.toLowerCase();
                              setBrandPalette(p => p ? { ...p, [role]: v } as BrandPalette : p);
                            }}
                            className="absolute inset-0 opacity-0 cursor-pointer"
                            disabled={brandApplying}
                          />
                        </div>
                        <div className="text-[10px] text-slate-400 text-center capitalize">{role}</div>
                        <div className="text-[10px] text-slate-500 text-center font-mono">{hex}</div>
                      </label>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => runBrandExtract()}
                      disabled={brandExtractRunning || brandApplying}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700 transition-colors disabled:opacity-40"
                      title="Re-run extraction"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Regenerate
                    </button>
                    <button
                      onClick={() => brandFileInputRef.current?.click()}
                      disabled={brandApplying}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700 transition-colors disabled:opacity-40"
                      title="Use a different product photo"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Use other photo
                    </button>
                    <div className="flex-1" />
                    <button
                      onClick={handleApplyBrandColors}
                      disabled={brandApplying}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-gradient-to-r from-pink-500 via-fuchsia-500 to-orange-400 text-white hover:opacity-95 shadow-lg shadow-fuchsia-500/20 transition-all disabled:opacity-50 disabled:cursor-wait"
                    >
                      {brandApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                      {brandApplying ? 'Recoloring…' : 'Apply to page'}
                    </button>
                  </div>

                  {/* progress shared con AI Edit (riusiamo aiEditProgress) */}
                  {brandApplying && aiEditProgress && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-fuchsia-300 font-medium flex items-center gap-1.5">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {aiEditProgress.label}
                        </span>
                        <span className="text-slate-500">
                          {aiEditProgress.chunkIndex + 1} / {aiEditProgress.totalChunks}
                        </span>
                      </div>
                      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-pink-500 via-fuchsia-500 to-orange-400 rounded-full transition-all duration-500 ease-out"
                          style={{ width: `${((aiEditProgress.chunkIndex + 1) / aiEditProgress.totalChunks) * 100}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Error */}
              {brandExtractError && !brandNeedsImage && (
                <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30">
                  <p className="text-[11px] text-red-400 font-medium">{brandExtractError}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ Bottom Bar ═══ */}
      {mode === 'visual' && (
        <div className="px-4 py-1.5 bg-slate-50 border-t border-slate-200 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4 text-[11px] text-slate-400">
              {el && (
                <span className="font-mono">
                  {el.path.split(' > ').slice(-3).join(' > ')}
                </span>
              )}
              {el && (
                <span>{Math.round(el.rect.width)}×{Math.round(el.rect.height)}px</span>
              )}
            </div>
            <span className="text-[10px] text-slate-400 flex items-center gap-2">
              {editorViewport === 'mobile' && (
                <span className="flex items-center gap-1 text-blue-400">
                  <Smartphone className="h-3 w-3" /> Mobile
                </span>
              )}
              {activeHtml.length.toLocaleString()} characters
            </span>
          </div>
        </div>
      )}

      <style jsx global>{`
        .prop-input {
          width: 100%;
          padding: 4px 8px;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          font-size: 11px;
          color: #334155;
          outline: none;
          transition: border-color 0.15s;
        }
        .prop-input:focus {
          border-color: #f59e0b;
          box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.1);
        }
        .prop-select {
          width: 100%;
          padding: 3px 6px;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          font-size: 11px;
          color: #334155;
          outline: none;
          background: white;
          cursor: pointer;
        }
        .prop-select:focus {
          border-color: #f59e0b;
        }
      `}</style>
    </div>
  );
}

/* ─────────── Sub-components ─────────── */

function ToolBtn({ icon: Icon, title, onClick, danger }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    // onMouseDown→preventDefault: cliccando il pulsante NON spostiamo il
    // focus/selezione fuori dall'editor. Senza questo, mousedown rubava il
    // focus all'elemento in editing nell'iframe → la selezione collassava e
    // execCommand('bold'/'italic'/…) non aveva nulla su cui agire ("a volte
    // non fa il grassetto").
    <button onClick={onClick} onMouseDown={(e) => e.preventDefault()} title={title}
      className={`p-1.5 rounded-md transition-colors ${
        danger
          ? 'text-slate-500 hover:bg-red-50 hover:text-red-600'
          : 'text-slate-600 hover:bg-white hover:text-slate-900 hover:shadow-sm'
      }`}>
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

const COLOR_SWATCHES = [
  '#000000','#434343','#666666','#999999','#b7b7b7','#cccccc','#d9d9d9','#efefef','#f3f3f3','#ffffff',
  '#980000','#ff0000','#ff9900','#ffff00','#00ff00','#00ffff','#4a86e8','#0000ff','#9900ff','#ff00ff',
  '#e6b8af','#f4cccc','#fce5cd','#fff2cc','#d9ead3','#d0e0e3','#c9daf8','#cfe2f3','#d9d2e9','#ead1dc',
  '#dd7e6b','#ea9999','#f9cb9c','#ffe599','#b6d7a8','#a2c4c9','#a4c2f4','#9fc5e8','#b4a7d6','#d5a6bd',
  '#cc4125','#e06666','#f6b26b','#ffd966','#93c47d','#76a5af','#6d9eeb','#6fa8dc','#8e7cc3','#c27ba0',
  '#a61c00','#cc0000','#e69138','#f1c232','#6aa84f','#45818e','#3c78d8','#3d85c6','#674ea7','#a64d79',
  '#85200c','#990000','#b45f06','#bf9000','#38761d','#134f5c','#1155cc','#0b5394','#351c75','#741b47',
  '#5b0f00','#660000','#783f04','#7f6000','#274e13','#0c343d','#1c4587','#073763','#20124d','#4c1130',
];

function ColorPicker({ label, title, value, onChange, textColor }: {
  label: string;
  title: string;
  value: string;
  onChange: (color: string) => void;
  textColor?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="relative" ref={ref} title={title}>
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); setOpen(!open); }}
        className={`flex items-center justify-center w-7 h-7 rounded-md border border-slate-200 hover:border-amber-300 transition-colors relative ${textColor ? 'text-slate-700 font-bold text-xs' : ''}`}
      >
        {textColor ? label : <Palette className="h-3.5 w-3.5 text-slate-500" />}
        <div className="absolute bottom-0 left-0 right-0 h-1 rounded-b-md" style={{ backgroundColor: value }} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-white rounded-lg shadow-xl border border-slate-200 p-2 w-[220px]"
          onMouseDown={(e) => e.preventDefault()}>
          <div className="grid grid-cols-10 gap-0.5">
            {COLOR_SWATCHES.map((c) => (
              <button key={c} type="button"
                onMouseDown={(e) => { e.preventDefault(); onChange(c); setOpen(false); }}
                className={`w-[18px] h-[18px] rounded-sm border transition-transform hover:scale-125 ${c === value ? 'border-blue-500 ring-1 ring-blue-500' : 'border-slate-300/50'}`}
                style={{ backgroundColor: c }}
                title={c} />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5 border-t border-slate-100 pt-2">
            <input type="color" value={value}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => { onChange(e.target.value); setOpen(false); }}
              className="w-6 h-6 rounded cursor-pointer border border-slate-200" />
            <span className="text-[10px] text-slate-400">Custom</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PropLabel({ children, icon: Icon }: { children: React.ReactNode; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1 mb-1">
      {Icon && <Icon className="h-3 w-3 text-amber-500" />}
      {children}
    </h4>
  );
}

function ActionBtn({ icon: Icon, label, onClick, danger }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
        danger
          ? 'text-red-600 bg-red-50 hover:bg-red-100'
          : 'text-slate-600 bg-slate-50 hover:bg-slate-100'
      }`}>
      <Icon className="h-3 w-3" />{label}
    </button>
  );
}

function Hint({ emoji, text }: { emoji: string; text: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-400">
      <span className="w-6 text-center">{emoji}</span>
      <span>{text}</span>
    </div>
  );
}
