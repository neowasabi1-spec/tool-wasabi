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
  Link2, Link2Off,
} from 'lucide-react';
import { SavedSection, SECTION_TYPE_OPTIONS, OUTPUT_STACK_OPTIONS, type OutputStack } from '@/types';
import { createClient } from '@supabase/supabase-js';

/* ── Direct browser → Supabase Storage upload (bypasses Vercel 4.5MB body limit) ── */
const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
  'video/quicktime': 'mov',
};
const UPLOAD_MAX_SIZE = 20 * 1024 * 1024; // 20MB

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
  onClose: () => void;
  pageTitle?: string;
  /** Project context: passato dal parent (front-end-funnel) e usato per
   *  pre-compilare il prompt quando l'utente clicca "Swipe for Product"
   *  su un video. Senza questo, il bottone esiste comunque e usa solo
   *  il contesto della pagina (alt del video + heading vicino). */
  productContext?: {
    name?: string;
    description?: string;
    brief?: string;
    /** URL di una foto del prodotto (es. logo[0].url del Project).
     *  Quando presente, "Swipe for Product" parte in modalità FULLY AUTO:
     *  l'AI usa direttamente questa immagine come prima frame, scrive il
     *  prompt da sola, lancia Seedance 2.0 e sostituisce il <video>
     *  senza nessun altro click dell'utente. */
    imageUrl?: string;
  };
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

  function gi(el){
    if(!el)return null;
    var cs=getComputedStyle(el),r=el.getBoundingClientRect();
    return{
      path:gp(el),tagName:el.tagName.toLowerCase(),id:el.id||'',
      className:typeof el.className==='string'?el.className:'',
      textContent:el.childNodes.length<=3?(el.textContent||'').substring(0,300):'',
      innerHTML:el.innerHTML?(el.innerHTML).substring(0,2000):'',
      outerHTML:el.outerHTML?(el.outerHTML).substring(0,300):'',
      href:el.getAttribute('href')||'',src:el.getAttribute('src')||'',
      alt:el.getAttribute('alt')||'',
      videoAttrs:(el.tagName==='VIDEO'?{
        controls:el.hasAttribute('controls'),
        autoplay:el.hasAttribute('autoplay'),
        loop:el.hasAttribute('loop'),
        muted:el.hasAttribute('muted'),
        playsinline:el.hasAttribute('playsinline')||el.hasAttribute('webkit-playsinline'),
        preload:el.getAttribute('preload')||'metadata',
        poster:el.getAttribute('poster')||'',
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
  plusBtn.innerHTML='+';
  plusBtn.style.cssText='position:absolute;z-index:999999;width:32px;height:32px;border-radius:50%;background:#3b82f6;color:#fff;font-size:20px;line-height:32px;text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);display:none;pointer-events:auto;transition:transform .15s;user-select:none;';
  plusBtn.onmouseenter=function(){plusBtn.style.transform='scale(1.15)';};
  plusBtn.onmouseleave=function(){plusBtn.style.transform='scale(1)';};
  var insertTarget=null;
  plusBtn.onclick=function(e){e.preventDefault();e.stopPropagation();
    window.parent.postMessage({type:'request-insert-after'},'*');};
  document.body.appendChild(plusBtn);

  var delBtn=document.createElement('div');
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
    positionPlus();positionDel(el);
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
    var h='<!DOCTYPE html>'+document.documentElement.outerHTML;
    delBtn.style.display='';plusBtn.style.display='';
    if(sel){sel.style.outline=saved;sel.style.outlineOffset=so;positionPlus();}
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
  window.addEventListener('scroll',function(){positionPlus();if(sel)positionDel(sel);else if(hover)positionDel(hover);},true);
  window.addEventListener('resize',function(){positionPlus();if(sel)positionDel(sel);else if(hover)positionDel(hover);});

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

  function isUI(el){return el===plusBtn||el===delBtn||plusBtn.contains(el)||delBtn.contains(el);}

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
      case 'cmd-exec':document.execCommand(m.command,false,m.value||null);sendHtml();
        if(sel)window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');break;
      case 'cmd-set-style':if(sel){sel.style[m.property]=m.value;sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-remove-attr':if(sel){sel.removeAttribute(m.name);sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-set-attr':if(sel){sel.setAttribute(m.name,m.value);sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-set-text':if(sel){sel.textContent=m.value;sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-set-inner-html':if(sel){sel.innerHTML=m.value;sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-delete':if(sel){sel.remove();sel=null;sendHtml();
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
        plusBtn.style.display='none';hideDel();
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

  window.parent.postMessage({type:'editor-ready'},'*');
})();
`;

/* ─────────── Helpers ─────────── */

function prepareEditorHtml(html: string): string {
  let clean = html;
  clean = clean.replace(/<meta[^>]*content-security-policy[^>]*>/gi, '');
  clean = clean.replace(/loading=["']lazy["']/gi, 'loading="eager"');
  // Strip server/client fallback init che installano click-delegate FAQ/Swiper
  // e un HUD: dentro l'editor visuale rubano i click di selezione.
  clean = clean.replace(/<script\b[^>]*data-fallback=[^>]*>[\s\S]*?<\/script>/gi, '');
  clean = clean.replace(/<style\b[^>]*data-fallback=[^>]*>[\s\S]*?<\/style>/gi, '');
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

/* ─────────── Component ─────────── */

export default function VisualHtmlEditor({ initialHtml, initialMobileHtml, onSave, onClose, pageTitle, productContext }: VisualHtmlEditorProps) {
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
  /** Indicazioni extra che l'utente può scrivere per guidare la
   *  rigenerazione del prompt (es. "fai vedere persona prima grassa con
   *  cuffie e poi magra"). */
  const [swipeExtraGuidance, setSwipeExtraGuidance] = useState('');
  /** Snapshot del contesto in cui è stato avviato lo Swipe (alt, poster,
   *  brief…), così il bottone "Rigenera prompt" può rifare la chiamata
   *  anche dopo che selectedElement è cambiato. */
  const swipeAnalysisCtxRef = useRef<{
    posterUrl: string;
    currentAlt: string;
    pageTitle: string;
    productName: string;
    productDesc: string;
    productBrief: string;
    fallbackPrompt: string;
  } | null>(null);

  const AI_MODELS: Record<AiMode, { id: string; label: string; hint: string }[]> = {
    text2image: [
      { id: 'nano-banana-2', label: 'Nano Banana 2 (Gemini 3.1 Flash)', hint: 'Veloce, qualita alta, default' },
      { id: 'gpt-image-2', label: 'ChatGPT Image 2 (OpenAI)', hint: 'Top per testo nelle immagini, costoso' },
      { id: 'flux-schnell', label: 'FLUX Schnell', hint: 'Super rapido (~2s), economico' },
      { id: 'flux-dev', label: 'FLUX Dev', hint: 'Qualita superiore, piu lento' },
      { id: 'imagen4', label: 'Google Imagen 4 Fast', hint: 'Buono per realismo' },
    ],
    image2image: [
      { id: 'nano-banana-2-edit', label: 'Nano Banana 2 Edit', hint: 'Edit mirato, conserva soggetto' },
      { id: 'gpt-image-2-edit', label: 'ChatGPT Image 2 Edit (OpenAI)', hint: 'Editing fine, costoso' },
      { id: 'flux-kontext', label: 'FLUX Pro Kontext', hint: 'Riedit avanzato' },
    ],
    image2video: [
      { id: 'seedance-2', label: 'Bytedance Seedance 2.0', hint: '5/10s, qualità top, multi-resolution' },
      { id: 'veo3-fast', label: 'Google Veo 3 Fast', hint: 'Qualita top, 5/8s' },
      { id: 'kling-21', label: 'Kling 2.1 Standard', hint: '5/10s, naturalezza alta' },
    ],
    text2video: [
      { id: 'seedance-2-t2v', label: 'Bytedance Seedance 2.0 (T2V)', hint: '5/10s, scena inventata da prompt, qualità top' },
      { id: 'seedance-2-t2v-fast', label: 'Bytedance Seedance 2.0 Fast (T2V)', hint: '5/10s, più economico, render più rapido' },
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
            ? `Timeout della funzione (${res.status}). Riprova: il modello ci ha messo troppo.`
            : `Risposta non-JSON (${res.status}): ${snippet}`,
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
      setAiError(err instanceof Error ? `Upload fallito: ${err.message}` : 'Upload fallito');
    } finally {
      setAiSourceUploading(false);
    }
  }, [aiSourceUploading]);

  const handleAiGenerate = useCallback(async () => {
    if (aiGenerating) return;
    let finalPrompt = aiPrompt.trim();
    if (!finalPrompt && aiMode === 'text2image' && aiContextText.trim()) {
      finalPrompt = `Create a professional, high-quality image that visually represents the following content. Make it suitable for a landing page or marketing material. Context: "${aiContextText.trim().substring(0, 500)}"`;
    }
    if (!finalPrompt) {
      setAiError(
        aiMode === 'image2video'
          ? "Inserisci una descrizione di come animare l'immagine"
          : aiMode === 'image2image'
            ? "Descrivi la modifica da applicare all'immagine"
            : aiMode === 'text2video'
              ? 'Descrivi la scena del video da generare'
              : 'Inserisci un prompt o seleziona un elemento con testo vicino',
      );
      return;
    }
    if ((aiMode === 'image2image' || aiMode === 'image2video') && !aiSourceImage) {
      setAiError("Carica prima un'immagine sorgente.");
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
        throw new Error(data.error || 'Errore generazione');
      }

      const POLL_DEADLINE = Date.now() + 5 * 60_000;
      while (data.status === 'pending' && data.requestId) {
        if (Date.now() > POLL_DEADLINE) {
          throw new Error('Timeout: la generazione ha richiesto piu di 5 minuti.');
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
        throw new Error(data.error || 'Nessun media ritornato dal modello');
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
    aiVideoDuration,
    aiVideoLoop,
    aiGenerating,
    aiContextText,
    selectedElement,
    setAttr,
    sendToIframe,
  ]);

  /* ── Media Upload ── */
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const imgUploadRef = useRef<HTMLInputElement>(null);
  const vidUploadRef = useRef<HTMLInputElement>(null);

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

  /* runSwipeAnalysis — chiama l'analyzer Claude e, se va a buon fine,
   * popola aiPrompt / aiContextText / intent / duration. È usata sia in
   * apertura iniziale (autoFire=true → l'utente clicca solo "Swipe" e
   * il video parte da solo) sia dal bottone "Rigenera prompt" del banner
   * (autoFire=false, l'utente legge prima e poi conferma con Genera).
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

      try {
        const resp = await fetch('/api/swipe-video/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            posterUrl: ctx.posterUrl,
            currentAlt: ctx.currentAlt,
            pageTitle: ctx.pageTitle,
            productContext: {
              name: ctx.productName,
              description: ctx.productDesc,
              brief: ctx.productBrief,
            },
            userGuidance: extraGuidance || undefined,
          }),
        });
        const data = (await resp.json()) as {
          ok: boolean;
          intent?: string;
          originalDescription?: string;
          uniqueMechanism?: string;
          transformation?: string;
          suggestedPrompt?: string;
          suggestedDuration?: number;
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
        setAiPrompt(suggested);
        const ctxParts: string[] = [];
        if (desc) ctxParts.push(`Originale: ${desc}`);
        if (mech) ctxParts.push(`Meccanismo: ${mech}`);
        if (transf) ctxParts.push(`Trasformazione: ${transf}`);
        if (ctxParts.length > 0) setAiContextText(ctxParts.join(' • '));
        setSwipeVisionMode(data.mode || 'text');
        setSwipeVisionIntent(data.intent || '');
        const duration =
          data.suggestedDuration === 10 || data.suggestedDuration === 5
            ? (data.suggestedDuration as 5 | 10)
            : 10;
        setAiVideoDuration(duration);
        if (autoFire) setSwipeAutoMode(true);
      } catch (err) {
        if (!aiPrompt.trim()) {
          /* Solo al primo tentativo lasciamo il fallback. Per un retry
             manuale teniamo quello che c'è già nel textarea, così l'utente
             non perde le sue modifiche. */
          setAiPrompt(ctx.fallbackPrompt);
        }
        setSwipeVisionMode(null);
        setSwipeVisionError(
          err instanceof Error ? err.message : 'Analisi non disponibile'
        );
      } finally {
        setSwipeVisionLoading(false);
      }
    },
    [aiPrompt],
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

    const productName = (productContext?.name || '').trim();
    const productDesc = (productContext?.description || '').trim();
    const productBrief = (productContext?.brief || '').trim().slice(0, 600);
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

    /* Salviamo il contesto in un ref così il bottone "Rigenera prompt"
       può rifare la chiamata Claude senza ricalcolare nulla. */
    swipeAnalysisCtxRef.current = {
      posterUrl,
      currentAlt,
      pageTitle: pageTitle || '',
      productName,
      productDesc,
      productBrief,
      fallbackPrompt,
    };

    /* 1. Apriamo il modal subito con uno stato di "analisi in corso", così
       l'utente vede feedback istantaneo. Disattiviamo l'auto-fire della
       generazione (resterà disabilitato finché l'analisi non finisce o
       l'utente non sceglie di procedere). */
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
    setShowAiImagePopup(true);

    await runSwipeAnalysis({ extraGuidance: '', autoFire: true });
  }, [selectedElement, productContext, pageTitle, runSwipeAnalysis]);

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
  const stableSrcDoc = useMemo(() => prepareEditorHtml(activeHtml), [iframeVersion, editorViewport]);
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
    setPreviewSnapshot(activeHtml);
    const t = setTimeout(() => setPreviewReady(true), 30);
    return () => clearTimeout(t);
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
                        title="Sostituisce il video con uno coerente per il tuo prodotto, generato con AI (Seedance 2.0). Pre-compila il prompt usando il contesto della pagina e i dati del Project."
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
                              hint="Mostra/nascondi i comandi (play, volume, ecc.) sul video"
                              on={va.controls}
                              onChange={(v) => setBoolAttr('controls', v)}
                            />
                            <Toggle
                              label="Loop"
                              hint="Riavvia automaticamente il video alla fine"
                              on={va.loop}
                              onChange={(v) => setBoolAttr('loop', v)}
                            />
                            <Toggle
                              label="Autoplay"
                              hint="Parte automaticamente al caricamento (di solito serve anche Muted)"
                              on={va.autoplay}
                              onChange={(v) => {
                                setBoolAttr('autoplay', v);
                                if (v && !va.muted) setBoolAttr('muted', true);
                              }}
                            />
                            <Toggle
                              label="Muted"
                              hint="Audio disattivato di default. Necessario per autoplay sui browser moderni."
                              on={va.muted}
                              onChange={(v) => setBoolAttr('muted', v)}
                            />
                            <Toggle
                              label="Inline (mobile)"
                              hint="Riproduzione in linea su iPhone (senza fullscreen forzato)"
                              on={va.playsinline}
                              onChange={(v) => setBoolAttr('playsinline', v)}
                            />
                            <div>
                              <label className="text-[10px] text-slate-400 block mb-0.5">Preload</label>
                              <select
                                value={va.preload}
                                className="prop-select"
                                onChange={(e) => setAttr('preload', e.target.value)}
                                title="Quanto del video pre-caricare prima del play"
                              >
                                <option value="none">none (lazy)</option>
                                <option value="metadata">metadata</option>
                                <option value="auto">auto (full)</option>
                              </select>
                            </div>
                          </div>
                          <div>
                            <label className="text-[10px] text-slate-400 block mb-0.5 mt-1">Poster (immagine prima del play)</label>
                            <input
                              type="url"
                              defaultValue={va.poster}
                              key={`poster-${va.poster}`}
                              placeholder="https://... (oppure lascia vuoto)"
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
                              title="Autoplay + Loop + Muted, senza barra controlli — come una GIF"
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
                              title="Solo controlli visibili, niente autoplay/loop/muted"
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
                      Incolla un URL YouTube/Vimeo (anche /watch?v=) o un embed pronto.
                    </p>

                    {/* Convert iframe → native <video>. UX:
                        - Pulsante principale: apre subito il file picker; dopo
                          l'upload sostituisce l'iframe con un <video src="...">
                          gia' pronto a partire. Cosi' non si rimane mai con un
                          placeholder vuoto che "lampeggia" senza src.
                        - Link secondario: converte in <video> vuoto se l'utente
                          vuole solo cambiare la sorgente in un secondo momento. */}
                    <div className="mt-3 pt-3 border-t border-slate-100">
                      <p className="text-[10px] text-slate-500 mb-1.5">Vuoi caricare un tuo video invece di usare un embed?</p>
                      <button
                        type="button"
                        onClick={handleIframeToVideoUpload}
                        disabled={uploading}
                        className="w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg bg-purple-50 border border-purple-200 hover:border-purple-300 hover:bg-purple-100 transition-all text-xs font-medium text-purple-700 disabled:opacity-50"
                        title="Apre la finestra di scelta file, carica il video, e lo inserisce gia' pronto."
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
                        title="Crea un &lt;video&gt; vuoto. Dovrai poi cliccare il video e usare 'Upload Video' nella sidebar."
                      >
                        oppure converti in &lt;video&gt; vuoto (carico dopo)
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
                        // Pre-fill source image with the currently selected img,
                        // useful if the user immediately switches to Modifica/Anima.
                        const currentSrc = el.src;
                        setAiSourceImage(currentSrc && /^https?:\/\//.test(currentSrc) ? currentSrc : '');
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
                      <span className="text-[10px] font-semibold text-slate-500">Padding (interno)</span>
                      <button
                        type="button"
                        onClick={() => setPaddingLinked((v) => !v)}
                        title={paddingLinked ? 'Lati legati — modifica uno = applica a tutti' : 'Lati indipendenti — clicca per legare'}
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
                      <span className="text-[10px] font-semibold text-slate-500">Margin (esterno)</span>
                      <button
                        type="button"
                        onClick={() => setMarginLinked((v) => !v)}
                        title={marginLinked ? 'Lati legati — modifica uno = applica a tutti' : 'Lati indipendenti — clicca per legare'}
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
                    <p className="text-[10px] text-slate-400 mt-1">Tip: scrivi <code>auto</code> per centrare orizzontalmente.</p>
                  </div>

                  {/* Preset rapidi spaziatura verticale (top+bottom) — utile per
                      aumentare/ridurre l'aria sopra/sotto un blocco con un click. */}
                  <div className="mt-3">
                    <div className="text-[10px] font-semibold text-slate-500 mb-1">Preset verticale (T+B)</div>
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
                  className="flex-1 px-2.5 py-1.5 border border-slate-200 rounded-lg text-[11px] focus:ring-1 focus:ring-violet-500 focus:border-violet-500 outline-none"
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
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => !aiGenerating && setShowAiImagePopup(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-violet-600 to-purple-600 px-5 py-4 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                  <Sparkles className="h-4 w-4 text-white" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Genera Media con AI</h3>
                  <p className="text-[10px] text-violet-200">fal.ai — text-to-image, image edit e image-to-video</p>
                </div>
              </div>
              <button onClick={() => !aiGenerating && setShowAiImagePopup(false)} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors" disabled={aiGenerating}>
                <X className="h-4 w-4 text-white" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-200 bg-slate-50 shrink-0">
              {([
                { id: 'text2image', label: 'Genera', icon: ImagePlus },
                { id: 'image2image', label: 'Modifica', icon: Wand2 },
                { id: 'image2video', label: 'Anima', icon: Film },
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
              {/* Model selector */}
              <div>
                <label className="text-[10px] text-violet-500 font-medium mb-1 block uppercase tracking-wider">Modello AI</label>
                <select
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  disabled={aiGenerating}
                  className="w-full px-2.5 py-2 text-xs border border-violet-200 rounded-lg focus:border-violet-400 outline-none bg-white"
                >
                  {AI_MODELS[aiMode].map((m) => (
                    <option key={m.id} value={m.id}>{m.label} — {m.hint}</option>
                  ))}
                </select>
              </div>

              {/* Source image upload (image2image / image2video) */}
              {(aiMode === 'image2image' || aiMode === 'image2video') && (
                <div>
                  <label className="text-[10px] text-violet-500 font-medium mb-1 block uppercase tracking-wider">Immagine sorgente</label>
                  {aiSourceImage ? (
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
                  ) : (
                    <label className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-violet-300 hover:border-violet-500 hover:bg-violet-50 transition-colors cursor-pointer text-xs text-violet-600 font-medium ${aiSourceUploading ? 'opacity-60 cursor-wait' : ''}`}>
                      {aiSourceUploading ? (
                        <><Loader2 className="h-4 w-4 animate-spin" /> Caricamento…</>
                      ) : (
                        <><Upload className="h-4 w-4" /> Carica immagine sorgente</>
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
              )}

              {/* Context (text2image only) */}
              {aiMode === 'text2image' && aiContextText && (
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Contesto rilevato automaticamente</p>
                  <p className="text-xs text-slate-600 leading-relaxed line-clamp-3">{aiContextText}</p>
                </div>
              )}

              {/* Swipe-for-Product banner (text2video aperto dal bottone Swipe) */}
              {aiMode === 'text2video' && (swipeVisionLoading || aiContextText || swipeVisionError) && (
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
                            ? 'Sto guardando il video originale…'
                            : aiGenerating
                              ? 'Sto facendo lo swipe del video per il tuo prodotto…'
                              : 'Swipe Video for Product'}
                        </p>
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
                          <span className="text-[9px] uppercase tracking-wider font-medium text-slate-500" title="Poster non disponibile, analisi solo testuale">
                            text-only
                          </span>
                        )}
                        <span className="text-[9px] uppercase tracking-wider font-medium text-violet-600 ml-auto" title="Text-to-Video: l'AI inventa la scena da prompt, senza foto sorgente">
                          T2V
                        </span>
                      </div>

                      {swipeVisionLoading ? (
                        <p className="text-[11px] text-slate-600 leading-relaxed mt-0.5">
                          Claude sta analizzando il poster del clip per capire l&apos;intent (demo / before-after / lifestyle…) e suggerire un prompt mirato per il tuo prodotto.
                        </p>
                      ) : (
                        <>
                          {aiContextText && (
                            <p className="text-[11px] text-slate-600 leading-relaxed mt-0.5">
                              <span className="text-slate-500">Clip originale:</span>{' '}
                              <span className="italic text-slate-700">&ldquo;{aiContextText.substring(0, 200)}{aiContextText.length > 200 ? '…' : ''}&rdquo;</span>
                            </p>
                          )}
                          {swipeVisionError ? (
                            <p className="text-[11px] text-amber-700 leading-relaxed mt-1">
                              Analisi vision non riuscita ({swipeVisionError}). Ti ho lasciato un prompt generico — modificalo pure prima di generare.
                            </p>
                          ) : (
                            <p className="text-[11px] text-slate-600 leading-relaxed mt-1">
                              Il prompt qui sotto descrive l&apos;<strong>intera scena</strong> per Seedance 2.0 text-to-video — niente foto sorgente, l&apos;AI ricrea il setting (con il TUO prodotto al centro) coerente con l&apos;intent del clip originale. Modificalo se vuoi.
                            </p>
                          )}

                          {/* Rigenera prompt con guidance utente */}
                          {!aiGenerating && (
                            <div className="mt-2 pt-2 border-t border-fuchsia-200/60">
                              <label className="text-[10px] font-bold uppercase tracking-wider text-fuchsia-700 block mb-1">
                                Vuoi guidare lo swipe? (opzionale)
                              </label>
                              <textarea
                                value={swipeExtraGuidance}
                                onChange={(e) => setSwipeExtraGuidance(e.target.value)}
                                disabled={swipeVisionLoading}
                                placeholder="Es: fai vedere il meccanismo unico — una persona grassa che ascolta la frequenza con le cuffie e poi è dimagrita."
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
                                  <><Loader2 className="h-3 w-3 animate-spin" /> Rigenero…</>
                                ) : (
                                  <><Sparkles className="h-3 w-3" /> Rigenera prompt</>
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
                    ? 'Prompt (opzionale)'
                    : aiMode === 'image2image'
                      ? 'Cosa modificare'
                      : aiMode === 'text2video'
                        ? 'Descrivi la scena del video'
                        : 'Come animare'}
                </label>
                <textarea
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder={
                    aiMode === 'text2image'
                      ? (aiContextText ? "Lascia vuoto per generare dal contesto sopra, oppure descrivi l'immagine..." : "Descrivi l'immagine che vuoi generare...")
                      : aiMode === 'image2image'
                        ? "Es: cambia lo sfondo in una spiaggia tropicale, aggiungi occhiali da sole..."
                        : aiMode === 'text2video'
                          ? "Es: medium shot di una donna sul divano che indossa Metabolic Wave headphones, luce calda, slow push-in di 5s, cinematic, no text, no audio."
                          : "Es: la persona sorride e fa l'occhiolino, leggero zoom in..."
                  }
                  rows={3}
                  className="w-full px-3 py-2.5 text-sm border border-violet-200 rounded-xl focus:border-violet-400 focus:ring-2 focus:ring-violet-100 outline-none resize-none transition-all placeholder:text-slate-400"
                  disabled={aiGenerating}
                />
              </div>

              {/* Format + style for text2image */}
              {aiMode === 'text2image' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-violet-500 font-medium mb-1 block">Formato</label>
                    <select
                      value={aiSize}
                      onChange={(e) => setAiSize(e.target.value as typeof aiSize)}
                      className="w-full px-2.5 py-2 text-xs border border-violet-200 rounded-lg focus:border-violet-400 outline-none bg-white"
                      disabled={aiGenerating}
                    >
                      <option value="1024x1024">Quadrato (1:1)</option>
                      <option value="1792x1024">Landscape (16:9)</option>
                      <option value="1024x1792">Portrait (9:16)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-violet-500 font-medium mb-1 block">Stile</label>
                    <select
                      value={aiStyle}
                      onChange={(e) => setAiStyle(e.target.value as typeof aiStyle)}
                      className="w-full px-2.5 py-2 text-xs border border-violet-200 rounded-lg focus:border-violet-400 outline-none bg-white"
                      disabled={aiGenerating}
                    >
                      <option value="vivid">Vivid (colori intensi)</option>
                      <option value="natural">Natural (fotorealistico)</option>
                    </select>
                  </div>
                </div>
              )}

              {/* Duration + loop for image2video */}
              {aiMode === 'image2video' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-violet-500 font-medium mb-1 block">Durata</label>
                    <select
                      value={aiVideoDuration}
                      onChange={(e) => setAiVideoDuration(Number(e.target.value) as 5 | 10)}
                      className="w-full px-2.5 py-2 text-xs border border-violet-200 rounded-lg focus:border-violet-400 outline-none bg-white"
                      disabled={aiGenerating}
                    >
                      <option value={5}>5 secondi</option>
                      <option value={10}>10 secondi</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-violet-500 font-medium mb-1 block">Riproduzione</label>
                    <label className="flex items-center gap-2 px-2.5 py-2 text-xs border border-violet-200 rounded-lg bg-white cursor-pointer">
                      <input
                        type="checkbox"
                        checked={aiVideoLoop}
                        onChange={(e) => setAiVideoLoop(e.target.checked)}
                        disabled={aiGenerating}
                        className="accent-violet-600"
                      />
                      <span className="text-slate-700">Loop (come GIF)</span>
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
                      ? 'Generando video... (puo richiedere 1-2 min)'
                      : 'Generando...'}
                  </>
                ) : aiMode === 'text2image' ? (
                  <>
                    <ImagePlus className="h-4 w-4" />
                    {aiPrompt.trim() ? 'Genera Immagine' : aiContextText ? 'Genera dal Contesto' : 'Genera Immagine'}
                  </>
                ) : aiMode === 'image2image' ? (
                  <>
                    <Wand2 className="h-4 w-4" />
                    Modifica Immagine
                  </>
                ) : aiMode === 'text2video' ? (
                  <>
                    <Sparkles className="h-4 w-4" />
                    Genera Video (Swipe)
                  </>
                ) : (
                  <>
                    <Film className="h-4 w-4" />
                    Anima Immagine
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
                  <p className="text-[10px] text-emerald-600 font-semibold mb-0.5">Descrizione generata dal modello:</p>
                  <p className="text-xs text-emerald-700 leading-relaxed">{aiRevisedPrompt}</p>
                </div>
              )}
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
    <button onClick={onClick} title={title}
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
