// SPA rescue: detect when an HTML payload is a JS-rendered SPA shell with
// no server-rendered text, and reach into r.jina.ai to obtain the post-
// render content as markdown, then convert back into a minimal HTML that
// the rewrite extractor can scan.
//
// Used by:
//   - /api/clone-funnel        (server-side fallback inside fetchPageWithFallbacks)
//   - /api/funnel-swap-proxy   (defence in depth: rescues `renderedHtml`
//     before forwarding to the Supabase Edge Function so the Edge Function
//     never sees an empty SPA shell)
//
// Pure functions, no Next.js / Supabase deps — safe to import from any
// route handler or library code.

/**
 * Detect when an HTML payload is a JS-rendered SPA shell with essentially
 * no server-rendered text. Catches Vite/CRA/React-Router/Vue/Svelte/Nuxt
 * static-only builds that ship "<div id=root></div>" and inject everything
 * client-side. Strips scripts/styles/svgs/tags from <body> and checks the
 * residual visible text — less than ~200 chars = empty SPA shell.
 */
export function isSpaShell(html: string): boolean {
  if (!html || html.length < 100) return true;
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const visibleText = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return visibleText.length < 200;
}

/**
 * Render a JS-only page via r.jina.ai. Tries two strategies in order so
 * that we ALWAYS prefer the highest-fidelity output available:
 *
 *   1) `X-Engine: browser` + `X-Return-Format: html`
 *      Jina spins up a real headless Chromium, executes the JS, then
 *      serialises the post-render DOM. The result preserves images,
 *      CSS classes, attributes and the original tag structure — i.e. it
 *      looks like a Playwright snapshot. Slower (10-30s) but allows the
 *      downstream rewrite to keep the visual identity of the page.
 *
 *   2) Markdown fallback (default Jina mode)
 *      If the browser-engine attempt fails (rate-limited, timeout,
 *      Jina free-tier limits, etc.) we fall back to the markdown reader
 *      which is fast and reliable but text-only. We then convert that
 *      markdown into a minimal HTML so the rewrite extractor still
 *      finds <h1>/<p>/<li>/... — the user gets the COPY but loses the
 *      design (no images, no original layout).
 *
 * Returns null when both strategies fail. Optionally pass an
 * `apiKey` (or set JINA_API_KEY env var) to lift Jina's free-tier rate
 * limits and unlock faster browser-mode renders.
 */
export async function rescueViaJina(url: string): Promise<string | null> {
  const apiKey = process.env.JINA_API_KEY?.trim() || '';
  const html = await tryJinaBrowserHtml(url, apiKey);
  if (html) return html;
  const md = await tryJinaMarkdown(url, apiKey);
  if (md) return md;
  return null;
}

/**
 * Strategy 1: Real browser render → full post-render HTML.
 * Preserves visual identity (images, CSS classes, structure).
 */
async function tryJinaBrowserHtml(url: string, apiKey: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'text/html',
      'X-Return-Format': 'html',
      // Force a real headless Chromium server-side. Without this header
      // Jina uses a "direct" fetch which returns the raw SPA shell.
      'X-Engine': 'browser',
      // Bypass cache so we always get a fresh render — competitors update
      // pricing, dates and offers daily and we want the latest copy.
      'X-No-Cache': 'true',
      // Auto-generate alt text for images so the downstream extractor can
      // pick up image-only content too (testimonial photos, badges, ...).
      'X-With-Generated-Alt': 'true',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      redirect: 'follow',
      // Real browser renders are slow — give them up to 60s before we
      // fall back to the markdown path (which is much faster).
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      console.warn(`[spa-rescue] jina browser-html HTTP ${res.status} for ${url}`);
      return null;
    }
    const html = await res.text();
    if (!html || html.length < 1000) {
      console.warn(`[spa-rescue] jina browser-html returned ${html?.length ?? 0} chars for ${url}`);
      return null;
    }
    if (isSpaShell(html)) {
      console.warn(`[spa-rescue] jina browser-html still SPA shell (${html.length} chars) for ${url} — JS likely failed to execute`);
      return null;
    }

    // Critical post-processing: stabilize the HTML so it renders
    // correctly when served from a different origin (Netlify clone vs.
    // tsl.burnfatfrequency.com). See stabilizeClonedHtml for the three
    // layers (absolutize URLs + <base href> + neutralize <a> links).
    const stabilized = stabilizeClonedHtml(html, url);
    console.log(`[spa-rescue] jina browser-html OK: ${stabilized.length} chars for ${url} (stabilized)`);
    return stabilized;
  } catch (err) {
    const e = err as { message?: string; cause?: { code?: string } };
    console.warn(`[spa-rescue] jina browser-html failed for ${url}: ${e?.message || String(err)}${e?.cause?.code ? ` (${e.cause.code})` : ''}`);
    return null;
  }
}

/**
 * One-shot stabilizer for cloned HTML that will be served from a
 * different origin than the source page (typical when publishing a
 * Wasabi-rewritten clone on Netlify).
 *
 * Three layers, in order:
 *
 *   1. Absolutize every relative URL (img/css/js/srcset/url()/data-*).
 *      Without this, /figmaAssets/*.png → 404 from cute-cupcake.netlify.app.
 *
 *   2. Inject <base href="https://origin/"> as a safety net so URLs
 *      created at runtime by the bundle JS (Vite/React/Next dynamic
 *      imports, lazy <picture>, fetch('/api/...')) also resolve to the
 *      original origin. The static absolutize covers ~95%; <base>
 *      catches the rest for free.
 *
 *   3. Neutralize <a href> so a visitor clicking on the published
 *      clone doesn't get hijacked to the competitor site. The original
 *      href is preserved in data-original-href so the editor / a future
 *      "Replace CTAs" step can pick them up. Anchors (#…),
 *      javascript:, mailto:, tel: are left alone.
 *
 * Idempotent: running it twice is a no-op (already-absolute URLs are
 * detected, an existing <base> is replaced, neutralized anchors keep
 * their data-original-href).
 */
export function stabilizeClonedHtml(html: string, originUrl: string): string {
  let out = absolutizeUrlsInHtml(html, originUrl);
  out = injectBaseHref(out, originUrl);
  out = neutralizeAnchorHrefs(out);
  out = unlockPageScroll(out);
  out = resetAccordionState(out);
  out = injectInteractivityRescue(out);
  // Aggiunge `referrerpolicy="no-referrer"` a <img>/<video>/<source> e
  // `<meta name="referrer" content="no-referrer">` in <head>. Senza
  // questo, alcuni CDN (Cloudflare hotlink protection, Bunny, Replit
  // free-tier) rifiutano la richiesta del media quando il Referer
  // arriva dal nostro dominio Netlify -> immagini mancanti nel clone
  // anche se l'URL e' corretto. Idempotente (lookahead negativo +
  // skip se <meta name="referrer"> gia' presente). Protegge i tag
  // <script>/<noscript> dalle regex.
  out = injectNoReferrerAndEagerLoading(out);
  return out;
}

/**
 * Marketing SPAs frequently lock body scroll on mount (bootstrap modals,
 * body-scroll-lock library, exit-intent popups, cookie banners, video
 * lightboxes…). When Jina captures the post-render snapshot the lock
 * state is frozen into the HTML — the published clone inherits a body
 * stuck at `overflow:hidden` and the visitor can't scroll past the
 * first viewport.
 *
 * Two-step defence:
 *   1. Strip `overflow:*` and `position:fixed` declarations from any
 *      inline `style=""` on the <html> or <body> root tag (the most
 *      common vector — a modal library typically does this with
 *      `document.body.style.overflow = 'hidden'`).
 *   2. Inject a final <style> at the end of <head> with !important
 *      overrides so any stylesheet rule (including ones we can't
 *      easily parse) loses the cascade against ours.
 *
 * We deliberately avoid touching `position` on body (some legitimate
 * layouts rely on it). Overflow alone unlocks ~95% of cases.
 */
function unlockPageScroll(html: string): string {
  let out = html;

  // Strip blocking inline overflow on <html> / <body>.
  out = out.replace(
    /(<(?:html|body)\b[^>]*?\bstyle\s*=\s*)(["'])([^"']*)\2/gi,
    (_full, prefix: string, q: string, val: string) => {
      const cleaned = val
        // overflow / overflow-x / overflow-y declarations
        .replace(/(?:^|;)\s*overflow(?:-x|-y)?\s*:[^;]+;?/gi, ';')
        // position:fixed (would prevent normal page flow scroll on root)
        .replace(/(?:^|;)\s*position\s*:\s*fixed\b[^;]*;?/gi, ';')
        // height / max-height that would clip the document
        .replace(/(?:^|;)\s*(?:max-)?height\s*:\s*100(?:vh|%)\s*;?/gi, ';')
        .replace(/;{2,}/g, ';')
        .replace(/^\s*;|;\s*$/g, '')
        .trim();
      return cleaned ? `${prefix}${q}${cleaned}${q}` : '';
    },
  );

  // Inject an !important override as the LAST rule in <head> so it
  // wins the cascade against the page's own stylesheets.
  // NOTE: deliberately NOT touching `position` on body — many
  // legitimate layouts use position:relative on body to anchor
  // absolute children. Forcing static was an overreach that broke
  // sticky bars and side panels on some pages.
  const fixStyle =
    '<style id="wasabi-scroll-fix">' +
    'html,body{overflow:visible!important;overflow-x:hidden!important;' +
    'overflow-y:auto!important;height:auto!important;' +
    'min-height:100vh!important}' +
    // Keep clickable elements clickable even if a fullscreen overlay
    // captured pointer-events: none at render time.
    'a,button,summary,[role="button"]{pointer-events:auto!important;cursor:pointer}' +
    '</style>';

  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${fixStyle}</head>`);
  } else if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/(<head\b[^>]*>)/i, `$1${fixStyle}`);
  } else {
    out = `<head>${fixStyle}</head>${out}`;
  }
  return out;
}

/**
 * Jina opens collapsible widgets (details/summary, FAQ accordions,
 * tabs) at render time so it can extract the inner text. The captured
 * snapshot therefore has every panel stuck in the "expanded" state:
 *
 *   - `<details open>` everywhere
 *   - buttons with `aria-expanded="true"` whose linked `aria-controls`
 *     panel is visible
 *   - Bootstrap `.collapse.show`, `.accordion-item.active`
 *   - generic `.is-open`, `.is-active`, `.expanded` classes
 *
 * We reset all of this server-side so the page loads in the natural
 * "all closed" state, and `injectInteractivityRescue` below wires up
 * the click handlers to toggle them again.
 *
 * Heuristic — we only touch elements that are clearly accordion-like
 * (have a sibling/related panel or aria-controls). Toggling EVERY
 * `.active` would break navigation menus and tab bars.
 */
function resetAccordionState(html: string): string {
  return html
    // <details open> → <details>
    .replace(/(<details\b[^>]*?)\sopen(\s|>|=)/gi, '$1$2')
    // aria-expanded="true" → "false" — the rescue script will toggle it
    // on click. Non-accordion buttons rarely use aria-expanded so this
    // is safe.
    .replace(/\baria-expanded\s*=\s*(["'])true\1/gi, 'aria-expanded="false"')
    // Bootstrap collapse: ".collapse show" → ".collapse"
    .replace(
      /(\bclass\s*=\s*["'][^"']*?\bcollapse)\s+show\b/gi,
      '$1',
    )
    // Bootstrap accordion: ".accordion-collapse.show" → just collapse
    .replace(
      /(\bclass\s*=\s*["'][^"']*?\baccordion-collapse)\s+show\b/gi,
      '$1',
    )
    // Funnelish/generic FAQ: strip "open" state classes from .faq /
    // .faq-item / .accordion-item containers so the rescue script can
    // re-toggle them. We only touch classes ON elements that ALSO have
    // a .faq* / .accordion* base class to avoid hitting unrelated
    // navigation menus that share .is-active.
    .replace(
      /(\bclass\s*=\s*["'][^"']*?\b(?:faq|faq-item|faq-wrapper|accordion-item)\b[^"']*?)\s+(?:is-open|is-active|active|expanded|open|show)\b/gi,
      '$1',
    );
}

/**
 * Tiny client-side script (~1.2 KB minified) injected at the end of
 * <body> that re-arms accordion toggling for the four most common
 * patterns found on marketing/landing pages:
 *
 *   1. Native <details>/<summary> — browsers already toggle these,
 *      we just make sure summary stays clickable (some pages disable
 *      it via pointer-events: none on parents).
 *   2. ARIA pattern: button[aria-expanded] + element[id=aria-controls
 *      target]. Toggle aria-expanded and the target's display.
 *   3. Bootstrap pattern: [data-bs-toggle="collapse"][data-bs-target]
 *      or [data-toggle="collapse"][href]. Toggle .show on target.
 *   4. Generic pattern: .accordion-header / .faq-question siblings to
 *      .accordion-content / .faq-answer. Toggle .is-open on the parent
 *      and inline display on the next-sibling content.
 *
 * Event-delegated on document so dynamically-added accordions also
 * work. Runs once on DOMContentLoaded.
 */
/**
 * Strip every <script> tag (inline + external) from the cloned HTML.
 *
 * Why: when we render the snapshot in a Preview iframe the page's
 * original scripts re-bind their own click handlers (Funnelish's
 * jQuery accordion, Shopify Dawn's <details> polyfill, custom
 * "show/hide FAQ" inline scripts). Those handlers fight with our
 * rescue delegate (capture vs bubble, double-toggle, race condition
 * with closeAll), so accordions either don't open or instantly
 * snap back closed/open.
 *
 * Mirrors the same stripping the Visual editor does in
 * `prepareEditorHtml` so behaviour is consistent between Editor and
 * Preview. Loses live interactivity on purpose - if the user needs
 * the real runtime they can open "Live navigable".
 */
function stripAllScripts(html: string): string {
  let out = html;
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<script\b[^>]*\/>/gi, '');
  return out;
}

export function injectInteractivityRescue(html: string): string {
  // 1) Buttiamo via gli script della pagina (vedi stripAllScripts).
  //    Senza questo, in Preview gli accordion non rispondevano al click
  //    pur essendoci il rescue: la pagina riassegnava i suoi handler in
  //    bubble e annullava il toggle del rescue (capture).
  html = stripAllScripts(html);

  // CSS guard: only kicks in when the rescue script has tagged <html>
  // with `data-wasabi-rescue="1"`. This avoids hiding/clobbering FAQs
  // on pages whose own runtime is fine — the script only sets the
  // flag if it actually finds accordion-shaped DOM and binds to it.
  // Funnelish/.faq pattern: panel hidden by default, opened when the
  // .faq parent (or nearest accordion container) gets .is-open.
  const styleTag =
    '<style id="wasabi-accordion-rescue-style">' +
    'html[data-wasabi-rescue="1"] .faq .faq-content-wrapper,' +
    'html[data-wasabi-rescue="1"] .faq .faq-content,' +
    'html[data-wasabi-rescue="1"] .faq-wrapper .faq-content-wrapper,' +
    'html[data-wasabi-rescue="1"] .faq-wrapper .faq-content,' +
    'html[data-wasabi-rescue="1"] .faq-item .faq-body,' +
    'html[data-wasabi-rescue="1"] .faq-item .faq-answer{display:none}' +
    'html[data-wasabi-rescue="1"] .faq.is-open>.faq-content-wrapper,' +
    'html[data-wasabi-rescue="1"] .faq.is-open .faq-content-wrapper,' +
    'html[data-wasabi-rescue="1"] .faq.is-open .faq-content,' +
    'html[data-wasabi-rescue="1"] .faq-wrapper.is-open .faq-content-wrapper,' +
    'html[data-wasabi-rescue="1"] .faq-wrapper.is-open .faq-content,' +
    'html[data-wasabi-rescue="1"] .faq-item.is-open .faq-body,' +
    'html[data-wasabi-rescue="1"] .faq-item.is-open .faq-answer{display:block}' +
    'html[data-wasabi-rescue="1"] .faq-header,' +
    'html[data-wasabi-rescue="1"] .faq-title,' +
    'html[data-wasabi-rescue="1"] .faq-question,' +
    'html[data-wasabi-rescue="1"] .accordion-header,' +
    'html[data-wasabi-rescue="1"] .accordion-button,' +
    'html[data-wasabi-rescue="1"] .accordion-toggle,' +
    'html[data-wasabi-rescue="1"] .toggle-header{cursor:pointer}' +
    'html[data-wasabi-rescue="1"] .faq.is-open .faq-icon,' +
    'html[data-wasabi-rescue="1"] .faq-wrapper.is-open .faq-icon,' +
    'html[data-wasabi-rescue="1"] .faq-item.is-open .faq-icon{transform:rotate(180deg);transition:transform .2s}' +
    // Funnelish leftover noise: empty <li> items used as vertical
    // spacers in the original page. Without Funnelish's CSS they show
    // as bare `•` bullets between real list items. Hide them.
    'html[data-wasabi-rescue="1"] li:empty,' +
    'html[data-wasabi-rescue="1"] li>br:only-child{display:none}' +
    '</style>';

  // UNIVERSAL accordion handler. Strategy: on every click (capture phase,
  // so we win over the site's own bubble-phase handlers) we look for the
  // nearest "accordion item" ancestor — by KNOWN selector OR by a fuzzy
  // class match (faq/accordion/toggle/collaps/expand/question/dropdown) —
  // that actually contains a hide-able panel, then toggle that panel by
  // reading its REAL computed state. This works even when the original
  // site CSS/JS keeps the panel closed and the framework script never
  // runs (Funnelish/ClickFunnels snapshots, stripped <script> in editor).
  const script = `<script id="wasabi-accordion-rescue">(function(){
var TRIG='.faq-header,.faq-title,.faq-question,.accordion-header,.accordion-button,.accordion-toggle,.toggle-header,.elFAQItemQuestion,[data-accordion-trigger],[data-faq-toggle],label[for],.fk-collapsible-list-label,.fk-collapsible-list-right-label';
var ITEM='.faq,.faq-wrapper,.faq-item,.accordion-item,.accordion,.toggle-item,.elFAQItem,[data-faq],details,.fk-collapsible-list-item,li.fk-collapsible-list-item';
var PANEL='.faq-content-wrapper,.faq-content,.accordion-content,.accordion-body,.accordion-collapse,.faq-body,.faq-answer,.elFAQItemAnswer,.toggle-content,.collapse-content,[data-accordion-content],.fk-collapsible-list-content';
var ITEM_RE=/(faq|accordion|toggle|collaps|expand|question|drop.?down)/i;
var PANEL_RE=/(content|answer|body|panel|collaps|detail|inner|text|wrapper)/i;
function cls(el){if(!el)return '';var c=el.className;if(c&&typeof c==='object'&&'baseVal'in c)return c.baseVal;return ''+(c||'');}
// Classi che chiaramente NON sono pannelli di contenuto: header/icone/
// toggle/label. Senza questo filtro, librerie tipo FunnelKit (dove TUTTE
// le sub-classi contengono "collaps" perche' fa parte del nome) facevano
// matchare .fk-collapsible-list-label-icon come "panel" e il sibling-walk
// si fermava la' invece di salire fino al .fk-collapsible-list-content.
var PANEL_REJECT_RE=/(^|[\s\-_])(icon|toggle|header|footer|label|title|caption|trigger|button|chevron|arrow|caret|plus|minus|indicator|spacer|symbol|sign|head|nav|menu)([\s\-_]|$)/i;
function isPanelLike(el){
  if(!el||el.nodeType!==1)return false;
  var c=cls(el);
  if(PANEL_REJECT_RE.test(c))return false;
  return PANEL_RE.test(c)||(el.matches&&el.matches(PANEL));
}
function findPanel(trigger,item){
  // 1) Il FRATELLO dopo il trigger: gestisce sia le strutture "flat"
  //    (header/answer alternati nello stesso contenitore) sia gli item in
  //    cui header e pannello sono fratelli. PRIORITA' MASSIMA: senza questo,
  //    querySelector(PANEL) tornava sempre il PRIMO pannello del contenitore
  //    e il click apriva/chiudeva la FAQ sbagliata.
  var n=trigger&&trigger.nextElementSibling;
  while(n){if(isPanelLike(n))return n;n=n.nextElementSibling;}
  // 2) pannello esplicito dentro l'item
  try{var p=item&&item.querySelector(PANEL);if(p)return p;}catch(e){}
  // 3) figlio diretto panel-like / fallback ultimo figlio
  if(item&&item.children){
    for(var i=0;i<item.children.length;i++){var k=item.children[i];if(k!==trigger&&isPanelLike(k))return k;}
    if(item.children.length>=2){var last=item.children[item.children.length-1];if(last!==trigger&&!(trigger&&last.contains&&last.contains(trigger)))return last;}
  }
  return null;
}
function findItem(t){
  try{var hit=t.closest&&t.closest(ITEM);if(hit)return hit;}catch(_){}
  var el=t,depth=0;
  while(el&&el.nodeType===1&&depth<10){
    if(ITEM_RE.test(cls(el))&&findPanel(null,el))return el;
    el=el.parentElement;depth++;
  }
  return null;
}
function setOpen(p,open){
  if(!p)return;
  // setProperty(...,'important') vince anche sui rule "!important" della
  // pagina originale. Brute-force: copriamo display/max-height/height/
  // overflow/visibility/opacity/pointer-events/transform/clip-path
  // perche' framework diversi nascondono in modi diversi (Funnelish:
  // display:none, FunnelKit: max-height:0 + opacity, Elementor:
  // transform:scaleY(0), etc.). Inoltre rimuoviamo aria-hidden e
  // l'attributo hidden che alcuni framework leggono per "mostrare".
  if(open){
    try{
      p.style.setProperty('display','block','important');
      p.style.setProperty('max-height','none','important');
      p.style.setProperty('height','auto','important');
      p.style.setProperty('min-height','0','important');
      p.style.setProperty('overflow','visible','important');
      p.style.setProperty('visibility','visible','important');
      p.style.setProperty('opacity','1','important');
      p.style.setProperty('pointer-events','auto','important');
      p.style.setProperty('transform','none','important');
      p.style.setProperty('clip-path','none','important');
      p.style.setProperty('clip','auto','important');
    }catch(e){p.style.display='block';p.style.maxHeight='none';p.style.height='auto';p.style.overflow='visible';p.style.visibility='visible';p.style.opacity='1';}
    p.hidden=false;
    try{p.removeAttribute('hidden');p.removeAttribute('aria-hidden');}catch(e){}
  }else{
    try{
      p.style.setProperty('display','none','important');
      p.style.removeProperty('max-height');
      p.style.removeProperty('opacity');
      p.style.removeProperty('transform');
    }catch(e){p.style.display='none';}
  }
  p.setAttribute('data-wasabi-open',open?'1':'0');
}
function panelOpen(p){
  if(!p)return false;
  if(p.hasAttribute('data-wasabi-open'))return p.getAttribute('data-wasabi-open')==='1';
  try{return getComputedStyle(p).display!=='none';}catch(e){return false;}
}
function toggle(item,trigger){
  var panel=findPanel(trigger,item);
  if(!panel)return;
  var willOpen=!panelOpen(panel);
  setOpen(panel,willOpen);
  // Aggiungi classi "open" comuni a piu' framework: alcuni (FunnelKit,
  // Elementor, Bootstrap) hanno CSS che mostra/nasconde il pannello in
  // base alla classe sull'ITEM (non sull'inline style del pannello).
  // Senza queste classi il nostro display:block !important viene
  // sovrascritto perche' la regola .container .panel{display:none} ha
  // specificita' maggiore (e !important).
  if(item&&item!==panel&&item.classList){
    item.classList.toggle('is-open',willOpen);
    item.classList.toggle('active',willOpen);
    item.classList.toggle('expanded',willOpen);
    item.classList.toggle('open',willOpen);
    item.classList.toggle('show',willOpen);
    item.classList.toggle('fk-collapsible-list-item-open',willOpen);
    item.classList.toggle('elementor-active',willOpen);
    item.classList.toggle('uk-open',willOpen);
  }
  // Anche sul pannello: alcuni framework (Bootstrap collapse, Foundation)
  // applicano lo stato sul pannello stesso via classe.
  if(panel&&panel.classList){
    panel.classList.toggle('show',willOpen);
    panel.classList.toggle('in',willOpen);
    panel.classList.toggle('active',willOpen);
  }
  if(item&&item.tagName==='DETAILS'){if(willOpen)item.setAttribute('open','');else item.removeAttribute('open');}
  if(trigger&&trigger.setAttribute)trigger.setAttribute('aria-expanded',willOpen?'true':'false');
  // Accordion CSS-only basati su <input type="checkbox">: se trigger e'
  // un <label for="x"> o c'e' un input checkbox/radio dentro l'item,
  // sincronizziamo .checked cosi' eventuali selettori :checked della
  // pagina (icona/colore) si aggiornano coerentemente.
  try{
    var box=null;
    if(trigger&&trigger.tagName==='LABEL'&&trigger.htmlFor)box=document.getElementById(trigger.htmlFor);
    if(!box&&item&&item.querySelector)box=item.querySelector('input[type="checkbox"],input[type="radio"]');
    if(box){box.checked=willOpen;if(willOpen)box.setAttribute('checked','');else box.removeAttribute('checked');}
  }catch(e){}
}
// Trova ancestor toggleabile dal click handler (matches ITEM o classe FAQ-like
// con un pannello rilevabile). Se manca, NON chiudere il pannello: senza un
// ancestor riconoscibile, il click handler non trovera' findItem e il pannello
// resterebbe chiuso per sempre = bug "prende i click ma non apre nulla".
function findToggleAncestor(el){
  var p=el&&el.parentElement, d=0;
  while(p&&d<10){
    try{if(p.matches&&p.matches(ITEM))return p;}catch(_){}
    if(ITEM_RE.test(cls(p)))return p;
    p=p.parentElement;d++;
  }
  return null;
}
function closeAll(){
  try{
    // Pannelli con classi note: chiudi SOLO se hanno ancestor toggleabile
    var panels=document.querySelectorAll(PANEL);
    for(var i=0;i<panels.length;i++){
      if(!findToggleAncestor(panels[i]))continue;
      try{panels[i].style.setProperty('display','none','important');}catch(_){panels[i].style.display='none';}
      panels[i].setAttribute('data-wasabi-open','0');
    }
    var dets=document.querySelectorAll('details');
    for(var k=0;k<dets.length;k++)dets[k].removeAttribute('open');
    var its=document.querySelectorAll(ITEM);
    for(var j=0;j<its.length;j++){its[j].classList.remove('is-open');its[j].classList.remove('active');its[j].classList.remove('expanded');its[j].classList.remove('open');}
  }catch(e){}
}
// ---- CAROSELLO RESCUE ----------------------------------------------------
// Gli slider clonati (Replo/slick: .slider-for + frecce .lc-arrow + miniature
// .slider-nav, oppure Swiper: .swiper-wrapper) perdono il loro JS: le frecce
// non fanno nulla e le slide restano statiche. Ricostruiamo un carosello
// minimale in vanilla JS: mostriamo una slide per volta e colleghiamo
// frecce prev/next + click sulle miniature. Nessuna dipendenza esterna.
function wbSlides(track){
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
function bindCarousel(track){
  if(!track||track.__wbCar)return;
  var slides=wbSlides(track);
  if(slides.length<2)return;
  track.__wbCar=1;
  var scope=(track.closest&&track.closest('[data-replo-carousel],.left-slider,.carousel,.swiper,.slick-slider,.r-16fpy55'))||track.parentElement||track;
  var nav=scope.querySelector('.slider-nav,.slick-dots,.slider-nav-thumbnails,.swiper-pagination');
  var thumbs=[];
  if(nav){for(var n=0;n<nav.children.length;n++){var tc=nav.children[n];if(tc&&tc.nodeType===1&&((tc.querySelector&&tc.querySelector('img'))||tc.tagName==='IMG'))thumbs.push(tc);}}
  var idx=0;
  function show(k){
    idx=(k%slides.length+slides.length)%slides.length;
    for(var i=0;i<slides.length;i++){slides[i].style.display=(i===idx?'':'none');}
    for(var j=0;j<thumbs.length;j++){
      var on=(j===idx);
      thumbs[j].style.opacity=on?'1':'0.5';
      try{thumbs[j].classList.toggle('r-19wtxcv',on);thumbs[j].classList.toggle('slick-current',on);thumbs[j].classList.toggle('slick-active',on);thumbs[j].classList.toggle('swiper-pagination-bullet-active',on);}catch(e){}
    }
  }
  var prev=scope.querySelector('.lc-arrow-prev,.slick-prev,.slider-prev,.swiper-button-prev,[aria-label="Previous slide"]');
  var next=scope.querySelector('.lc-arrow-next,.slick-next,.slider-next,.swiper-button-next,[aria-label="Next slide"]');
  if(prev){prev.style.cursor='pointer';prev.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();show(idx-1);},true);}
  if(next){next.style.cursor='pointer';next.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();show(idx+1);},true);}
  for(var t=0;t<thumbs.length;t++){(function(kk){thumbs[kk].style.cursor='pointer';thumbs[kk].addEventListener('click',function(e){e.preventDefault();e.stopPropagation();show(kk);},true);})(t);}
  show(0);
}
function initCarousels(){
  try{
    var tracks=document.querySelectorAll('.slider-for,.swiper-wrapper');
    for(var i=0;i<tracks.length;i++)bindCarousel(tracks[i]);
  }catch(e){}
}
function once(){
  try{document.documentElement.setAttribute('data-wasabi-rescue','1');}catch(e){}
  closeAll();
  initCarousels();
  // Retry: alcune pagine popolano le slide via script inline dopo il load.
  // initCarousels e' idempotente (guard __wbCar), quindi e' sicuro ripetere.
  setTimeout(initCarousels,600);setTimeout(initCarousels,1600);
  document.addEventListener('click',function(ev){
    var t=ev.target;if(!(t instanceof Element))return;
    var actionable=t.closest('a[href]:not([href="#"]):not([href=""]),button[type="submit"],input,select,textarea');
    // 0) FunnelKit Collapsible List - handler DEDICATO.
    //    Le pagine FunnelKit (Rosabella, AICashClone, etc.) hanno una
    //    struttura specifica dove TUTTE le sub-classi contengono "collaps"
    //    (e' nel nome della libreria: fk-COLLAPSIBLE-list-*), il che fa
    //    impazzire le euristiche generiche. Qui detection diretta:
    //    qualsiasi click su un elemento .fk-collapsible-list-* (eccetto
    //    dentro al content gia' aperto) -> trova l'antenato che CONTIENE
    //    direttamente un .fk-collapsible-list-content figlio -> toggle.
    var fkHit=t.closest('[class*="fk-collapsible-list"]');
    if(fkHit){
      // Click DENTRO un content gia' aperto = lascia passare (l'utente
      // legge/seleziona la risposta, non vuole richiuderla).
      var fkInside=t.closest('.fk-collapsible-list-content');
      if(fkInside){try{if(getComputedStyle(fkInside).display!=='none')return;}catch(e){}}
      // Trova l'ITEM: ancestor che ha un .fk-collapsible-list-content come
      // figlio diretto. Questo e' SEMPRE il vero contenitore della FAQ.
      var fkItem=null, fkP=fkHit;
      while(fkP&&fkP.nodeType===1){
        for(var fci=0;fci<fkP.children.length;fci++){
          var fcc=fkP.children[fci];
          if(fcc.classList&&fcc.classList.contains('fk-collapsible-list-content')){fkItem=fkP;break;}
        }
        if(fkItem)break;
        if(fkP===document.body)break;
        fkP=fkP.parentElement;
      }
      if(fkItem){
        var fkContent=null;
        for(var fci2=0;fci2<fkItem.children.length;fci2++){
          var fcc2=fkItem.children[fci2];
          if(fcc2.classList&&fcc2.classList.contains('fk-collapsible-list-content')){fkContent=fcc2;break;}
        }
        if(fkContent){
          var fkWillOpen=!panelOpen(fkContent);
          setOpen(fkContent,fkWillOpen);
          try{fkItem.classList.toggle('fk-collapsible-list-item-open',fkWillOpen);}catch(_){}
          ev.preventDefault();ev.stopPropagation();
          return;
        }
      }
    }
    // 1) ARIA pattern
    var btn=t.closest('[aria-expanded][aria-controls]');
    if(btn){
      if(actionable&&btn.contains(actionable)&&actionable!==btn)return;
      var op=btn.getAttribute('aria-expanded')==='true';
      btn.setAttribute('aria-expanded',op?'false':'true');
      var pid=btn.getAttribute('aria-controls');var ap=pid?document.getElementById(pid):null;
      if(ap)setOpen(ap,!op);
      ev.preventDefault();ev.stopPropagation();return;
    }
    // 2) Bootstrap collapse
    var bs=t.closest('[data-bs-toggle="collapse"],[data-toggle="collapse"]');
    if(bs){
      if(actionable&&bs.contains(actionable)&&actionable!==bs)return;
      var sel=bs.getAttribute('data-bs-target')||bs.getAttribute('data-target')||bs.getAttribute('href');
      if(sel){try{var be=document.querySelector(sel);if(be){be.classList.toggle('show');setOpen(be,be.classList.contains('show'));}}catch(e){}}
      ev.preventDefault();ev.stopPropagation();return;
    }
    // 3) native details/summary: NON delegare al browser. Alcuni builder
    //    (FunnelKit/.fk-collapsible-list) mettono onclick return-false SUL
    //    details, che annulla il toggle nativo -> la FAQ resta bloccata.
    //    Gestiamo noi il toggle dell attributo open e fermiamo l evento in
    //    capture, cosi il loro onclick velenoso non viene mai raggiunto.
    var det0=t.closest('details');
    if(det0){
      if(t.closest('summary')){
        var willOpenD=!det0.hasAttribute('open');
        if(willOpenD)det0.setAttribute('open','');else det0.removeAttribute('open');
        var sm0=det0.querySelector('summary');
        if(sm0&&sm0.setAttribute)sm0.setAttribute('aria-expanded',willOpenD?'true':'false');
        ev.preventDefault();ev.stopPropagation();
      }
      return; // mai cadere nel generico per i <details> (evita doppio toggle)
    }
    // 4) Trova accordion. Strategia in tre passi:
    //   4a) ITEM ESPLICITO via closest (.faq-item, .accordion-item, etc.)
    //   4b) SIBLING-WALK: risali dal target cercando l'ancestor il cui
    //       NEXT SIBLING e' panel-like. Questo gestisce strutture nidificate
    //       come FunnelKit dove il click target e' DENTRO l'header e il
    //       panel e' fratello di un ancestor di 2+ livelli su:
    //         <li>
    //           <div.label>                   <- ancestor con sibling panel
    //             <div.right-label>           <- click target
    //               <div.label-text>Q?</div>
    //             <div.toggle>+</div>
    //           </div>
    //           <div.content>A</div>          <- panel (sibling di .label)
    //         </li>
    //       Il vecchio findItem fuzzy matchava .right-label su 'collaps' e
    //       findPanel restituiva .label-text come "panel" (matcha 'text'),
    //       quindi cliccare nascondeva la domanda invece di aprire la risposta.
    //   4c) FUZZY class match come last resort per pagine senza struttura
    //       sibling-walk pulita.
    var item=null, itemTrig=null;
    try{var ex=t.closest&&t.closest(ITEM); if(ex){item=ex; itemTrig=t.closest(TRIG)||t;}}catch(_){}
    if(!item){
      var w=t, wd=0;
      while(w&&w.nodeType===1&&wd<8&&w!==document.body&&w!==document.documentElement){
        var ws=w.nextElementSibling;
        while(ws){
          if(isPanelLike(ws)){itemTrig=w; item=w.parentElement||w; break;}
          ws=ws.nextElementSibling;
        }
        if(item)break;
        w=w.parentElement;wd++;
      }
    }
    if(!item){
      var fz=findItem(t); if(fz){item=fz; itemTrig=t.closest(TRIG)||t;}
    }
    if(item){
      if(actionable&&item.contains(actionable)&&actionable!==item)return;
      var inPanel=t.closest(PANEL);
      if(inPanel&&panelOpen(inPanel)){try{if(getComputedStyle(inPanel).display!=='none')return;}catch(e){}}
      toggle(item,itemTrig||t);
      ev.preventDefault();ev.stopPropagation();
    }
  },true);
}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',once)}else{once()}
})();</script>`;
  // Idempotenza: rimuovi eventuali iniezioni precedenti (lo snapshot
  // clonato puo' gia' contenerle da una pipeline precedente). Due copie
  // dello stesso handler in fase di capture si annullerebbero (doppio
  // toggle = nessun toggle).
  let out = html
    .replace(/<style id="wasabi-accordion-rescue-style">[\s\S]*?<\/style>/gi, '')
    .replace(/<script id="wasabi-accordion-rescue">[\s\S]*?<\/script>/gi, '');
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${styleTag}</head>`);
  } else if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/(<head\b[^>]*>)/i, `$1${styleTag}`);
  } else {
    out = `<head>${styleTag}</head>${out}`;
  }
  if (/<\/body>/i.test(out)) {
    return out.replace(/<\/body>/i, `${script}</body>`);
  }
  return out + script;
}

/**
 * Inject `<base href="https://origin/">` into <head> (after <meta charset>
 * if present so it doesn't fight with byte-order-mark detection). If the
 * page already has a <base> we replace it. If <head> is missing we
 * synthesise a minimal one. Without an explicit trailing slash the
 * browser may treat the base as a file rather than a directory, so we
 * always end with `/`.
 */
function injectBaseHref(html: string, originUrl: string): string {
  let baseHref: string;
  try {
    const u = new URL(originUrl);
    baseHref = `${u.origin}/`;
  } catch {
    return html;
  }
  const tag = `<base href="${baseHref}">`;

  // Replace any existing <base ...> tag.
  if (/<base\b[^>]*>/i.test(html)) {
    return html.replace(/<base\b[^>]*>/i, tag);
  }
  // Inject right after <head> (preserving whatever attributes head has).
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/(<head\b[^>]*>)/i, `$1\n  ${tag}`);
  }
  // No <head> at all — wrap the whole thing.
  return `<head>${tag}</head>${html}`;
}

/**
 * Replace every `<a href="…">` (or `<a … href='…'>`) whose href would
 * navigate the visitor away from our domain with a neutralized version:
 *
 *   <a href="#" data-original-href="https://competitor.com/buy" data-cloned-cta="1" …>
 *
 * Skips:
 *   - Anchors (`#section`) — same-page navigation, harmless.
 *   - `mailto:`, `tel:`, `javascript:` — non-navigational protocols.
 *   - Already-neutralized anchors (idempotent re-runs).
 *
 * The `data-original-href` lets a future "Replace CTAs" step in the
 * editor surface every external link the user needs to swap. The
 * `data-cloned-cta` flag makes them queryable from one selector.
 */
function neutralizeAnchorHrefs(html: string): string {
  return html.replace(
    /<a\b([^>]*?)\bhref\s*=\s*(["'])([^"']+)\2([^>]*)>/gi,
    (full, pre: string, q: string, href: string, post: string) => {
      const hrefTrim = href.trim();
      // Keep harmless / non-navigational hrefs as-is.
      if (
        !hrefTrim ||
        hrefTrim === '#' ||
        /^(?:#|mailto:|tel:|javascript:)/i.test(hrefTrim)
      ) {
        return full;
      }
      // Already neutralized? skip.
      if (/\bdata-original-href\s*=/.test(pre + post)) return full;
      const safeHref = hrefTrim.replace(/"/g, '&quot;');
      return `<a${pre}href="#" data-original-href="${safeHref}" data-cloned-cta="1"${post}>`;
    },
  );
}

/**
 * Rewrite every relative URL in `html` to an absolute URL using
 * `originUrl` as the base. Operates on:
 *   - src=  on <img>, <script>, <source>, <video>, <audio>, <iframe>, <embed>
 *   - href= on <a>, <link>, <area>, <use>
 *   - srcset= on <img> and <source>  (comma-separated descriptors)
 *   - url(...) inside <style>...</style>
 *   - url(...) inside inline style="..." attributes
 *   - data-bg, data-src, data-image, data-original (lazy-load conventions)
 *
 * Skips URLs that are already absolute (http://, https://, //), data:,
 * blob:, mailto:, tel:, javascript:, or pure anchors (#xxx).
 *
 * Exported because the same logic is useful for any cloned-HTML pipeline
 * (e.g. /api/clone-funnel could opt in for non-SPA pages too if needed).
 */
export function absolutizeUrlsInHtml(html: string, originUrl: string): string {
  let base: URL;
  try { base = new URL(originUrl); } catch { return html; }

  const out = html
    // src= on common asset-bearing tags
    .replace(
      /(<(?:img|script|source|video|audio|iframe|embed|track|input)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, prefix: string, q: string, val: string) => `${prefix}${q}${absolutize(val, base)}${q}`,
    )
    // href= on link/anchor/area/use/base
    .replace(
      /(<(?:a|link|area|use|base|form)\b[^>]*?\bhref\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, prefix: string, q: string, val: string) => `${prefix}${q}${absolutize(val, base)}${q}`,
    )
    // <form action="...">
    .replace(
      /(<form\b[^>]*?\baction\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, prefix: string, q: string, val: string) => `${prefix}${q}${absolutize(val, base)}${q}`,
    )
    // srcset="x.png 1x, y.png 2x"
    .replace(
      /(<(?:img|source)\b[^>]*?\bsrcset\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, prefix: string, q: string, val: string) => {
        const fixed = val.split(',').map((part) => {
          const trimmed = part.trim();
          if (!trimmed) return part;
          const segments = trimmed.split(/\s+/);
          const u = segments[0];
          const rest = segments.slice(1);
          return [absolutize(u, base), ...rest].join(' ');
        }).join(', ');
        return `${prefix}${q}${fixed}${q}`;
      },
    )
    // url(...) inside <style>...</style>
    .replace(
      /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
      (_m, attrs: string, css: string) => `<style${attrs}>${rewriteCssUrls(css, base)}</style>`,
    )
    // url(...) inside inline style="" attributes
    .replace(
      /(\bstyle\s*=\s*)(["'])([^"']*)\2/gi,
      (_m, prefix: string, q: string, val: string) => `${prefix}${q}${rewriteCssUrls(val, base)}${q}`,
    )
    // Lazy-load attributes (single URL): allineato 1:1 alla lista che
    // VisualHtmlEditor.prepareEditorHtml promuove a src/srcset/poster.
    // Senza assolutizzarli QUI, lazy-loader Shopify/Flickity/lozad/
    // PhotoSwipe/Webflow/Cloudflare/Complianz/Funnelish lasciano src
    // relativi (es. /cdn/shop/files/foo.jpg) e l'editor srcdoc, che
    // ha origin null, non riesce a risolverli => immagini bianche.
    .replace(
      /(\bdata-(?:src|bg|background|background-image|bg-src|lazy-bg|bgset|image|image-src|thumb|original|original-src|orig-src|lazy|lazy-src|lazyload|lazy-load|url|cfsrc|cmplz-src|wf-src|echo|defer-src|hi-res-src|actual|srcfallback|poster|lazy-poster|cfsrc-poster|video-src|poster-src|flickity-lazyload|flickity-lazyload-src|photoswipe-src)\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, prefix: string, q: string, val: string) => `${prefix}${q}${absolutize(val, base)}${q}`,
    )
    // Lazy-load attributes (srcset format: "url1 1x, url2 2x"): assolutizza
    // ogni URL nella lista, preservando i descriptor.
    .replace(
      /(\bdata-(?:srcset|lazy-srcset|cfsrcset|cmplz-srcset|wf-srcset|flickity-lazyload-srcset)\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, prefix: string, q: string, val: string) => {
        const fixed = val.split(',').map((part) => {
          const trimmed = part.trim();
          if (!trimmed) return part;
          const segments = trimmed.split(/\s+/);
          const u = segments[0];
          const rest = segments.slice(1);
          return [absolutize(u, base), ...rest].join(' ');
        }).join(', ');
        return `${prefix}${q}${fixed}${q}`;
      },
    );

  return out;
}

// Strip-pa le HTML entity di quote (`&quot;`, `&#34;`, `&apos;`, `&#39;`)
// che possono trovarsi attorno (o dentro) un URL di `url(...)`. Si
// presentano quando l'HTML originale conteneva un inline style con
// CSS quotato:
//   <div style="background-image: url(&quot;/foo.webp&quot;)">
// Il parser CSS del browser decodifica `&quot;` come `"` e ottiene
// `url("/foo.webp")` legale. MA se prima passa per il NOSTRO rewriter
// (regex su stringa raw HTML), vede `&quot;/foo.webp&quot;` come URL
// e fa `new URL(...).toString()` -> URL letterale contenente `&quot;`
// -> 404 al fetch dell'immagine. Stripping idempotente.
function stripHtmlQuoteEntities(s: string): string {
  let v = s.trim();
  // Loop perche' possono essere doppi-encoded (`&amp;quot;`).
  let prev: string;
  do {
    prev = v;
    v = v
      .replace(/^(?:&quot;|&#34;|&apos;|&#39;)+/i, '')
      .replace(/(?:&quot;|&#34;|&apos;|&#39;)+$/i, '');
  } while (v !== prev);
  return v;
}

function rewriteCssUrls(css: string, base: URL): string {
  return css.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/g,
    (_m, q: string, u: string) => `url(${q}${absolutize(stripHtmlQuoteEntities(u), base)}${q})`,
  );
}

/**
 * Aggiunge `referrerpolicy="no-referrer"` a <img>/<video>/<source>, un
 * `<meta name="referrer" content="no-referrer">` in `<head>`, e converte
 * `loading="lazy"` -> `loading="eager"` (utile per i preview di clone
 * che non vogliamo lazy: il visitatore della clone deve vedere TUTTO
 * subito altrimenti il primo render appare bianco e "rotto").
 *
 * REGOLE FONDAMENTALI (motivo per cui c'e' una utility dedicata e non
 * piu' regex sparse in 3 route diverse):
 *
 *   1) PROTEZIONE DEGLI <script> / <noscript>. La versione precedente
 *      applicava `<img\b` direttamente sull'HTML completo: matchava
 *      ANCHE letterali tipo `'<img src="/x">'` dentro stringhe JS in
 *      <script> inline o JSON serializzato in
 *      <script type="application/json">. Risultato: bundle JS
 *      modificato a runtime (template literal o JSON con valore
 *      sbagliato) e SPA che non si monta -> pagina "tutta rotta"
 *      anche prima del rewrite LLM. Qui ESTRAIAMO PRIMA gli
 *      <script>/<noscript> in placeholder, applichiamo le regex sul
 *      resto, poi li REINSERIAMO intatti.
 *
 *   2) IDEMPOTENZA. La pipeline puo' richiamare la stessa pass piu'
 *      volte (clone -> swipe -> nuovo swipe). Senza idempotenza,
 *      `<img>` accumulava `referrerpolicy="no-referrer"
 *      referrerpolicy="no-referrer" ...` e `<head>` si riempiva di
 *      `<meta name="referrer">` duplicati. Qui usiamo:
 *        - lookahead negativo per skip se l'attributo c'e' gia';
 *        - test sull'intero HTML per il <meta> nel <head>.
 *
 *   3) `loading="lazy"` -> `loading="eager"` e' gia' idempotente
 *      (dopo non c'e' piu' "lazy" da matchare).
 */
export function injectNoReferrerAndEagerLoading(html: string): string {
  if (!html || typeof html !== 'string') return html;

  // Estrai script/noscript in placeholder commento (non collide con
  // pattern HTML reali — il prefisso __WS_PROTECT__ e' unico).
  const SCRIPT_RE = /<(script|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  const stash: string[] = [];
  let cleaned = html.replace(SCRIPT_RE, (m) => {
    const idx = stash.length;
    stash.push(m);
    return `<!--__WS_PROTECT_${idx}__-->`;
  });

  cleaned = cleaned.replace(/loading=["']lazy["']/gi, 'loading="eager"');
  cleaned = cleaned.replace(
    /<img\b(?![^>]*\breferrerpolicy\s*=)/gi,
    '<img referrerpolicy="no-referrer" ',
  );
  cleaned = cleaned.replace(
    /<video\b(?![^>]*\breferrerpolicy\s*=)/gi,
    '<video referrerpolicy="no-referrer" ',
  );
  cleaned = cleaned.replace(
    /<source\b(?![^>]*\breferrerpolicy\s*=)/gi,
    '<source referrerpolicy="no-referrer" ',
  );

  // Inject meta referrer (idempotente)
  if (!/<meta\b[^>]*\bname\s*=\s*["']referrer["'][^>]*>/i.test(cleaned)) {
    if (/<head\b[^>]*>/i.test(cleaned)) {
      cleaned = cleaned.replace(
        /<head\b[^>]*>/i,
        (m) => `${m}<meta name="referrer" content="no-referrer">`,
      );
    } else {
      cleaned = `<meta name="referrer" content="no-referrer">${cleaned}`;
    }
  }

  // Reinserisci gli script/noscript ESATTAMENTE come erano.
  return cleaned.replace(
    /<!--__WS_PROTECT_(\d+)__-->/g,
    (_m, n: string) => stash[Number(n)] ?? '',
  );
}

function absolutize(u: string, base: URL): string {
  if (!u) return u;
  const trimmed = u.trim();
  // Already absolute, protocol-relative, data/blob/mailto/tel/js, or pure anchor
  if (/^(?:https?:\/\/|\/\/|data:|blob:|mailto:|tel:|javascript:|#)/i.test(trimmed)) return u;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return u;
  }
}

/**
 * Strategy 2: Markdown fallback → text-only HTML. Used when the browser
 * render times out or hits rate limits. Loses design but keeps the copy.
 */
async function tryJinaMarkdown(url: string, apiKey: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'text/plain',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.warn(`[spa-rescue] jina markdown HTTP ${res.status} for ${url}`);
      return null;
    }
    const md = await res.text();
    if (!md || md.length < 200) {
      console.warn(`[spa-rescue] jina markdown returned ${md?.length ?? 0} chars for ${url}`);
      return null;
    }
    const html = jinaMarkdownToHtml(md, url);
    if (isSpaShell(html)) {
      console.warn(`[spa-rescue] jina markdown converted but still empty for ${url}`);
      return null;
    }
    console.log(`[spa-rescue] jina markdown fallback: ${md.length} md → ${html.length} html for ${url}`);
    return html;
  } catch (err) {
    const e = err as { message?: string; cause?: { code?: string } };
    console.warn(`[spa-rescue] jina markdown failed for ${url}: ${e?.message || String(err)}${e?.cause?.code ? ` (${e.cause.code})` : ''}`);
    return null;
  }
}

/**
 * Convert r.jina.ai markdown output into minimal HTML that the rewrite
 * extractor can scan. Tiny, dependency-free converter — we only need
 * structural tags (h1..h6, p, ul/li, ol/li, blockquote) so the extractor
 * finds the texts.
 *
 * Jina's response begins with a small header block (Title / URL Source /
 * Published Time / Markdown Content:) which we strip before converting.
 */
export function jinaMarkdownToHtml(md: string, url: string): string {
  const startIdx = md.indexOf('Markdown Content:');
  const body = startIdx >= 0 ? md.slice(startIdx + 'Markdown Content:'.length) : md;
  const lines = body.split(/\r?\n/);

  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let paragraphBuf: string[] = [];

  function flushParagraph() {
    if (paragraphBuf.length === 0) return;
    const text = paragraphBuf.join(' ').trim();
    if (text) out.push(`<p>${escapeHtml(stripMdInline(text))}</p>`);
    paragraphBuf = [];
  }
  function closeList() {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    // Drop standalone images: ![alt](url)
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(line)) continue;

    // Headers
    const hMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (hMatch) {
      flushParagraph();
      closeList();
      const level = hMatch[1].length;
      out.push(`<h${level}>${escapeHtml(stripMdInline(hMatch[2]))}</h${level}>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^[-*+]\s+(.+?)\s*$/);
    if (ulMatch) {
      flushParagraph();
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${escapeHtml(stripMdInline(ulMatch[1]))}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\d+)[.)]\s+(.+?)\s*$/);
    if (olMatch) {
      flushParagraph();
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${escapeHtml(stripMdInline(olMatch[2]))}</li>`);
      continue;
    }

    // Blockquote
    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${escapeHtml(stripMdInline(bqMatch[1]))}</blockquote>`);
      continue;
    }

    // Horizontal rule — drop
    if (/^[-*_]{3,}\s*$/.test(line)) {
      flushParagraph();
      closeList();
      continue;
    }

    closeList();
    paragraphBuf.push(line.trim());
  }

  flushParagraph();
  closeList();

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    `<title>${escapeHtml(stripMdInline(extractFirstHeading(body) || url))}</title>`,
    '</head>',
    '<body>',
    out.join('\n'),
    '</body>',
    '</html>',
  ].join('\n');
}

function extractFirstHeading(md: string): string {
  const m = md.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

function stripMdInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
