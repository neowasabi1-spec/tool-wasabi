/**
 * Swipe injects a "relax fixed heights" stylesheet so longer copy can grow
 * out of Tailwind cards. The selector `[style*="height:"]` also matches the
 * page shell: Funnelish's root is
 *   <div class="main_wrapper_main desktop_grid" style="width:100%;height:100%">
 *   <main style="min-height:100vh">
 * and both contain paragraphs, so the rule forces height:auto and
 * min-height:0 on the whole grid. The clone never gets this sheet, which is
 * why the clone stays intact and the swipe collapses.
 *
 * Already-saved swipes still carry the old rule. This rewrites that rule
 * (and the matching JS) so the shell is left alone. Tailwind `h-[…]` cards
 * are unchanged.
 */

const OLD_HEIGHT_RULE =
  'html body [style*="height:"]:has(p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,dl),';

const SAFE_HEIGHT_RULE =
  'html body [style*="height:"]:not(main):not([class*="main_wrapper"]):not([class*="desktop_grid"]):not([style*="height:100%"]):not([style*="height: 100%"]):not([style*="100vh"]):has(p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,dl),';

const MEDIA_SKIP =
  "if(tn==='IMG'||tn==='VIDEO'||tn==='SVG'||tn==='svg'||tn==='CANVAS'||tn==='IFRAME'||tn==='PICTURE')continue;";

const SHELL_SKIP =
  "if(tn==='MAIN'||tn==='HTML'||tn==='BODY')continue;" +
  "var shellSt=el.getAttribute('style')||'';" +
  "var shellCl=typeof el.className==='string'?el.className:'';" +
  "if(/main_wrapper|desktop_grid/.test(shellCl)||/height: *100%|100vh/i.test(shellSt))continue;";

const TRUNCATE_BROKEN =
  'html body [class*="line-clamp-"],html body [class*="truncate"]{-webkit-line-clamp:unset !important;line-clamp:unset !important;display:block !important;overflow:visible !important;text-overflow:clip !important;white-space:normal !important;}';

const TRUNCATE_SAFE =
  'html body [class*="line-clamp-"],html body [class*="truncate"]{-webkit-line-clamp:unset !important;line-clamp:unset !important;overflow:visible !important;text-overflow:clip !important;white-space:normal !important;}';

const RELAX_CONTINUE =
  "if(tn==='MAIN'||tn==='HTML'||tn==='BODY')continue;var shellSt=el.getAttribute('style')||'';var shellCl=typeof el.className==='string'?el.className:'';if(/main_wrapper|desktop_grid/.test(shellCl)||/height: *100%|100vh/i.test(shellSt))continue;";

const RELAX_CONTINUE_SAFE =
  RELAX_CONTINUE +
  "var pos='';try{pos=window.getComputedStyle(el).position;}catch(e){}" +
  "if(pos==='absolute'||pos==='fixed'||pos==='sticky')continue;";

export function preservePageShellLayout(html: string): string {
  if (!html || !html.includes('layout-overflow-fix') && !html.includes('relaxFixedHeights')) {
    return html;
  }
  let out = html;
  if (out.includes(OLD_HEIGHT_RULE) && !out.includes(':not(main):not([class*="main_wrapper"])')) {
    out = out.replaceAll(OLD_HEIGHT_RULE, SAFE_HEIGHT_RULE);
  }
  if (out.includes(TRUNCATE_BROKEN)) {
    out = out.replaceAll(TRUNCATE_BROKEN, TRUNCATE_SAFE);
  }
  if (out.includes("c.style.setProperty('display','block','important');")) {
    out = out.replaceAll("c.style.setProperty('display','block','important');", '');
  }
  if (out.includes(RELAX_CONTINUE) && !out.includes("pos==='absolute'")) {
    out = out.replaceAll(RELAX_CONTINUE, RELAX_CONTINUE_SAFE);
  }
  if (out.includes(MEDIA_SKIP) && !out.includes("tn==='MAIN'")) {
    out = out.replaceAll(MEDIA_SKIP, MEDIA_SKIP + SHELL_SKIP);
  }
  return out;
}
