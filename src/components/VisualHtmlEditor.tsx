'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
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
} from 'lucide-react';
import { SavedSection, SECTION_TYPE_OPTIONS, OUTPUT_STACK_OPTIONS, type OutputStack } from '@/types';

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
      rect:{x:r.x,y:r.y,width:r.width,height:r.height},
      isTextNode:el.childNodes.length===1&&el.childNodes[0].nodeType===3,
      hasChildren:el.children.length>0,childCount:el.children.length,
      styles:{
        color:cs.color,backgroundColor:cs.backgroundColor,
        fontSize:cs.fontSize,fontWeight:cs.fontWeight,fontFamily:cs.fontFamily,
        fontStyle:cs.fontStyle,textDecoration:cs.textDecoration,
        textAlign:cs.textAlign,lineHeight:cs.lineHeight,
        padding:cs.padding,margin:cs.margin,borderRadius:cs.borderRadius,
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

  function sendHtml(){
    var saved=null,so=null;
    if(sel){saved=sel.style.outline;so=sel.style.outlineOffset;sel.style.outline='';sel.style.outlineOffset='';}
    if(editEl){editEl.contentEditable='false';}
    var h='<!DOCTYPE html>'+document.documentElement.outerHTML;
    if(sel){sel.style.outline=saved;sel.style.outlineOffset=so;}
    if(editEl){editEl.contentEditable='true';}
    window.parent.postMessage({type:'html-updated',data:h},'*');
  }

  function finishEdit(){
    if(!editEl)return;
    editEl.contentEditable='false';co(editEl);
    if(sel===editEl){editEl.style.outline=SS;editEl.style.outlineOffset='2px';}
    window.parent.postMessage({type:'editing-finished',data:gi(editEl)},'*');
    editing=false;editEl=null;sendHtml();
  }

  document.addEventListener('mouseover',function(e){
    if(editing)return;var el=e.target;if(sk(el)||el===sel)return;
    if(hover&&hover!==sel)co(hover);hover=el;el.style.outline=HS;el.style.outlineOffset='1px';
  },true);

  document.addEventListener('mouseout',function(e){
    var el=e.target;if(el!==sel)co(el);if(hover===el)hover=null;
  },true);

  document.addEventListener('click',function(e){
    if(editing&&editEl&&!editEl.contains(e.target)){finishEdit();}
    if(editing&&editEl&&editEl.contains(e.target))return;
    e.preventDefault();e.stopPropagation();
    var el=e.target;if(sk(el))return;
    if(sel)co(sel);sel=el;
    el.style.outline=SS;el.style.outlineOffset='2px';
    window.parent.postMessage({type:'element-selected',data:gi(el)},'*');
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
      case 'cmd-set-attr':if(sel){sel.setAttribute(m.name,m.value);sendHtml();
        window.parent.postMessage({type:'element-selected',data:gi(sel)},'*');}break;
      case 'cmd-set-text':if(sel){sel.textContent=m.value;sendHtml();}break;
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
      case 'cmd-deselect':if(editing)finishEdit();if(sel)co(sel);sel=null;hover=null;
        window.parent.postMessage({type:'element-deselected'},'*');break;
      case 'cmd-select-path':try{var found=document.querySelector(m.path);
        if(found){if(sel)co(sel);sel=found;found.style.outline=SS;found.style.outlineOffset='2px';
        found.scrollIntoView({behavior:'smooth',block:'center'});
        window.parent.postMessage({type:'element-selected',data:gi(found)},'*');}}catch(x){}break;
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
    }
  });

  window.parent.postMessage({type:'editor-ready'},'*');
})();
`;

/* ─────────── Helpers ─────────── */

function prepareEditorHtml(html: string): string {
  let clean = html;
  clean = clean.replace(/<meta[^>]*content-security-policy[^>]*>/gi, '');
  const script = `<script>${EDITOR_SCRIPT}<\/script>`;
  if (clean.includes('</body>')) return clean.replace('</body>', `${script}</body>`);
  if (clean.includes('</html>')) return clean.replace('</html>', `${script}</html>`);
  return clean + script;
}

function stripEditorScript(html: string): string {
  const idx = html.indexOf(EDITOR_SCRIPT.substring(0, 40));
  if (idx === -1) return html;
  const scriptStart = html.lastIndexOf('<script>', idx);
  const scriptEnd = html.indexOf('</script>', idx);
  if (scriptStart !== -1 && scriptEnd !== -1) {
    return html.substring(0, scriptStart) + html.substring(scriptEnd + 9);
  }
  return html;
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

const TAG_LABELS: Record<string, string> = {
  h1: 'Heading H1', h2: 'Heading H2', h3: 'Heading H3', h4: 'Heading H4',
  p: 'Paragraph', span: 'Text', a: 'Link', button: 'Button',
  img: 'Image', div: 'Section', section: 'Section', header: 'Header',
  footer: 'Footer', nav: 'Navigation', ul: 'List', ol: 'Ordered List',
  li: 'List Item', form: 'Form', input: 'Input', textarea: 'Text Area',
  video: 'Video', figure: 'Figure', figcaption: 'Caption', main: 'Main Content',
  article: 'Article', aside: 'Sidebar', blockquote: 'Blockquote',
};

/* ─────────── Component ─────────── */

export default function VisualHtmlEditor({ initialHtml, initialMobileHtml, onSave, onClose, pageTitle }: VisualHtmlEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [mode, setMode] = useState<EditorMode>('visual');
  const [selectedElement, setSelectedElement] = useState<ElementInfo | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [showSections, setShowSections] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [saved, setSaved] = useState(false);

  const [currentHtml, setCurrentHtml] = useState(initialHtml);
  const [codeHtml, setCodeHtml] = useState(initialHtml);
  const undoStack = useRef<string[]>([initialHtml]);
  const redoStack = useRef<string[]>([]);
  const undoIdx = useRef(0);

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

  /* ── AI Image Generation ── */
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiSize, setAiSize] = useState<'1024x1024' | '1792x1024' | '1024x1792'>('1024x1024');
  const [aiStyle, setAiStyle] = useState<'vivid' | 'natural'>('vivid');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiRevisedPrompt, setAiRevisedPrompt] = useState('');
  const [showAiPanel, setShowAiPanel] = useState(false);

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

  const handleUndo = useCallback(() => {
    if (undoIdx.current <= 0) return;
    undoIdx.current--;
    const html = undoStack.current[undoIdx.current];
    setCurrentHtml(html);
    setCodeHtml(html);
  }, []);

  const handleRedo = useCallback(() => {
    if (undoIdx.current >= undoStack.current.length - 1) return;
    undoIdx.current++;
    const html = undoStack.current[undoIdx.current];
    setCurrentHtml(html);
    setCodeHtml(html);
  }, []);

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

  const filteredLibrarySections = savedSections.filter(s => {
    if (libraryFilterType !== 'all' && s.sectionType !== libraryFilterType) return false;
    if (librarySearch.trim()) {
      const q = librarySearch.toLowerCase();
      return s.name.toLowerCase().includes(q) ||
             s.textPreview.toLowerCase().includes(q) ||
             s.tags.some(t => t.toLowerCase().includes(q));
    }
    return true;
  });

  /* ── Mode switching ── */
  const switchMode = useCallback((newMode: EditorMode) => {
    if (newMode === mode) return;
    if (mode === 'code' && newMode === 'visual') {
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

  /* ── Export ── */
  const handleSave = () => {
    onSave(currentHtml, mobileHtml || undefined);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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
  const handleAiGenerate = useCallback(async () => {
    if (!aiPrompt.trim() || aiGenerating) return;
    setAiGenerating(true);
    setAiError('');
    setAiRevisedPrompt('');
    try {
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: aiPrompt, size: aiSize, style: aiStyle }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error generating image');
      if (data.url) {
        setAttr('src', data.url);
        if (data.revisedPrompt) {
          setAiRevisedPrompt(data.revisedPrompt);
          setAttr('alt', data.revisedPrompt.substring(0, 120));
        }
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setAiGenerating(false);
    }
  }, [aiPrompt, aiSize, aiStyle, aiGenerating, setAttr]);

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
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload-media', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      if (data.url) {
        setAttr('src', data.url);
        if (target === 'image' && file.name) {
          setAttr('alt', file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '));
        }
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [uploading, setAttr]);

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
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload-media', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      if (data.url) {
        if (selectedElement?.tagName === 'img') {
          setAttr('src', data.url);
          setAttr('alt', file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '));
          setElAiMessages(prev => [...prev,
            { role: 'user', content: `📎 Uploaded: ${file.name}` },
            { role: 'assistant', content: `Done! Image replaced with uploaded file.` },
          ]);
        } else {
          setElAiInput(prev => prev + (prev ? ' ' : '') + data.url);
          setElAiMessages(prev => [...prev,
            { role: 'user', content: `📎 Uploaded: ${file.name} → ${data.url}` },
          ]);
        }
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
      if (e.key === 'Escape' && mode !== 'visual') { switchMode('visual'); return; }
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
  const editorSrcDoc = prepareEditorHtml(activeHtml);
  const el = selectedElement;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-white">
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
            <button onClick={handleUndo} disabled={!canUndo}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors" title="Undo (Ctrl+Z)">
              <Undo2 className="h-4 w-4" />
            </button>
            <button onClick={handleRedo} disabled={!canRedo}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors" title="Redo (Ctrl+Shift+Z)">
              <Redo2 className="h-4 w-4" />
            </button>
          </div>

          {/* Mode switcher */}
          <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5">
            {([['visual', Paintbrush, 'Visual'], ['code', Code, 'Code'], ['preview', Eye, 'Preview']] as const).map(([m, Icon, label]) => (
              <button key={m} onClick={() => switchMode(m)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
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
              onClick={() => setEditorViewport('desktop')}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                editorViewport === 'desktop'
                  ? 'bg-blue-500 text-white shadow'
                  : 'text-slate-400 hover:text-white hover:bg-slate-700'
              }`}
            >
              <Monitor className="h-3.5 w-3.5" />Desktop
            </button>
            <button
              onClick={() => setEditorViewport('mobile')}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
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
          <button onClick={onClose} className="ml-1 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors" title="Close editor">
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
              onChange={(c) => execCmd('foreColor', c)} textColor />
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
      <div className="flex-1 flex overflow-hidden">
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
                key={`${editorViewport}-${activeHtml.length}-${undoIdx.current}`}
                srcDoc={editorSrcDoc}
                className={`h-full border-0 transition-all duration-300 ${
                  editorViewport === 'mobile'
                    ? 'w-[390px] border-x-2 border-gray-300 shadow-2xl'
                    : 'w-full'
                }`}
                title="Visual Editor Canvas"
                sandbox="allow-scripts allow-same-origin"
              />
              {!editorReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/80">
                  <div className="flex items-center gap-2 text-slate-500">
                    <MousePointer className="h-5 w-5 animate-pulse" />
                    <span className="text-sm">Loading editor...</span>
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
            <div className="w-full h-full flex items-start justify-center bg-gray-100 overflow-auto">
              <iframe
                srcDoc={activeHtml}
                className={`h-full border-0 transition-all duration-300 ${
                  editorViewport === 'mobile'
                    ? 'w-[390px] shadow-2xl border-2 border-gray-300 rounded-[2rem] my-4'
                    : 'w-full'
                }`}
                title="Preview"
                sandbox="allow-scripts allow-same-origin"
              />
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
                    <textarea value={el.textContent} rows={3} className="prop-input font-normal"
                      onChange={(e) => sendToIframe({ type: 'cmd-set-text', value: e.target.value })} />
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
                    <input ref={imgUploadRef} type="file" accept="image/*" className="hidden"
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
                  </div>
                )}

                {/* AI Image Generation */}
                {el.tagName === 'img' && (
                  <div className="p-3">
                    <button
                      onClick={() => setShowAiPanel(!showAiPanel)}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-gradient-to-r from-violet-50 to-purple-50 border border-violet-200 hover:border-violet-300 transition-all group"
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex items-center justify-center w-6 h-6 rounded-md bg-violet-500/10">
                          <Sparkles className="h-3.5 w-3.5 text-violet-600" />
                        </div>
                        <span className="text-xs font-semibold text-violet-700">Generate with AI</span>
                      </div>
                      <Wand2 className={`h-3.5 w-3.5 text-violet-400 transition-transform ${showAiPanel ? 'rotate-45' : ''}`} />
                    </button>

                    {showAiPanel && (
                      <div className="mt-2 space-y-2.5 p-2.5 rounded-lg bg-gradient-to-b from-violet-50/50 to-transparent border border-violet-100">
                        <div>
                          <label className="text-[10px] text-violet-600 font-medium mb-0.5 block">Describe the image</label>
                          <textarea
                            value={aiPrompt}
                            onChange={(e) => setAiPrompt(e.target.value)}
                            placeholder="E.g.: A premium olive oil bottle with Mediterranean background, warm light, professional photography style..."
                            rows={3}
                            className="prop-input text-[11px] leading-relaxed resize-none !border-violet-200 focus:!border-violet-400 focus:!shadow-[0_0_0_2px_rgba(139,92,246,0.1)]"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[10px] text-violet-500">Size</label>
                            <select
                              value={aiSize}
                              onChange={(e) => setAiSize(e.target.value as typeof aiSize)}
                              className="prop-select !border-violet-200 text-[10px]"
                            >
                              <option value="1024x1024">Square</option>
                              <option value="1792x1024">Landscape</option>
                              <option value="1024x1792">Portrait</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-[10px] text-violet-500">Style</label>
                            <select
                              value={aiStyle}
                              onChange={(e) => setAiStyle(e.target.value as typeof aiStyle)}
                              className="prop-select !border-violet-200 text-[10px]"
                            >
                              <option value="vivid">Vivid</option>
                              <option value="natural">Natural</option>
                            </select>
                          </div>
                        </div>

                        <button
                          onClick={handleAiGenerate}
                          disabled={!aiPrompt.trim() || aiGenerating}
                          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow-md"
                        >
                          {aiGenerating ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Generating...
                            </>
                          ) : (
                            <>
                              <ImagePlus className="h-3.5 w-3.5" />
                              Generate Image
                            </>
                          )}
                        </button>

                        {aiError && (
                          <div className="p-2 rounded-md bg-red-50 border border-red-200">
                            <p className="text-[10px] text-red-600 font-medium">{aiError}</p>
                          </div>
                        )}

                        {aiRevisedPrompt && (
                          <div className="p-2 rounded-md bg-emerald-50 border border-emerald-200">
                            <p className="text-[10px] text-emerald-600 font-medium mb-0.5">Prompt used by DALL-E:</p>
                            <p className="text-[10px] text-emerald-700 leading-relaxed">{aiRevisedPrompt}</p>
                          </div>
                        )}
                      </div>
                    )}
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
                          onChange={(e) => setStyle('color', e.target.value)} />
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

                {/* Spacing */}
                <div className="p-3">
                  <PropLabel>Spacing</PropLabel>
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <div>
                      <label className="text-[10px] text-slate-400">Padding</label>
                      <input type="text" defaultValue={el.styles.padding} className="prop-input"
                        onBlur={(e) => setStyle('padding', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Margin</label>
                      <input type="text" defaultValue={el.styles.margin} className="prop-input"
                        onBlur={(e) => setStyle('margin', e.target.value)} />
                    </div>
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
                <input ref={elAiFileRef} type="file" accept="image/*,video/*" className="hidden"
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

function ColorPicker({ label, title, value, onChange, textColor }: {
  label: string;
  title: string;
  value: string;
  onChange: (color: string) => void;
  textColor?: boolean;
}) {
  return (
    <label className="relative flex items-center gap-1 cursor-pointer group" title={title}>
      <div className={`flex items-center justify-center w-7 h-7 rounded-md border border-slate-200 group-hover:border-amber-300 transition-colors ${textColor ? 'text-slate-700 font-bold text-xs' : ''}`}>
        {textColor ? label : <Palette className="h-3.5 w-3.5 text-slate-500" />}
        <div className="absolute bottom-0 left-0 right-0 h-1 rounded-b-md" style={{ backgroundColor: value }} />
      </div>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
    </label>
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
