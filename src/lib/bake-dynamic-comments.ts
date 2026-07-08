// Bake JS-generated live-chat comments into static, editable DOM.
//
// Pages like mobileincome.co/live-stream render their "live chat" from an
// inline array inside a closure:
//
//   var TIMED = [
//     {d:500, n:"Jake Dobbs", t:"Welcome everyone!...", isHost:true},
//     ...
//   ];
//
// A runtime engine reveals each entry over time by calling renderComment(),
// which appends a `.citem` node into `<div id="clist">`. Because those nodes
// don't exist at clone time, the Visual Editor (which shows the static DOM)
// can't display or edit them.
//
// bakeDynamicComments() pre-renders every TIMED entry as a static `.citem`
// node (replicating the engine's exact markup + helpers) and injects them
// into #clist so the editor shows real, editable comment text. It then blanks
// the TIMED array in the script so the runtime engine adds no duplicates —
// counters/countdown/video keep working, only the comment timeline is now the
// baked (editable) DOM.
//
// No-op on any page that doesn't use this engine (no `var TIMED = [...]`).

interface TimedComment {
  d?: number;
  n?: string;
  t?: string;
  isHost?: boolean;
}

// Mirror of the engine's avatar palette + helpers so baked nodes look
// identical to the runtime-rendered ones.
const AV_COLORS = [
  '#cc0000', '#0866ff', '#e65100', '#2e7d32', '#6a1b9a',
  '#ad1457', '#0097a7', '#5d4037', '#1565c0', '#f57f17',
];

function avColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h += name.charCodeAt(i);
  return AV_COLORS[h % AV_COLORS.length];
}

function initials(name: string): string {
  const p = name.trim().split(/\s+/);
  return p.length > 1
    ? (p[0][0] + p[p.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Locate `var TIMED = [ ... ];` (the array literal spanning multiple lines).
// Non-greedy up to the first `];` that closes the array at statement level.
const TIMED_RE = /var\s+TIMED\s*=\s*(\[[\s\S]*?\n\s*\])\s*;/;

function parseTimed(arrayLiteral: string): TimedComment[] | null {
  try {
    // The literal uses unquoted keys + JS strings (apostrophes, emojis), so
    // it isn't valid JSON. Evaluate it as a plain array expression. Content
    // is our own cloned page, not third-party input.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const value = new Function(`return (${arrayLiteral});`)();
    return Array.isArray(value) ? (value as TimedComment[]) : null;
  } catch {
    return null;
  }
}

function buildCommentRow(c: TimedComment, ts: number): string {
  const name = c.n || '';
  const text = c.t || '';
  const isHost = !!c.isHost;
  const color = avColor(name);
  // data-d / data-host carry the original timing + role so unbakeDynamicComments
  // can rebuild the runtime TIMED array from the (edited) static DOM.
  const dAttr = ' data-d="' + (c.d || 0) + '"' + (isHost ? ' data-host="1"' : '');
  return (
    '<div class="citem no-anim"' + dAttr + ' data-ts="' + ts + '">' +
    '<div class="cav" style="background:' + color + '">' + escHtml(initials(name)) + '</div>' +
    '<div class="cright">' +
    '<div class="cbubble' + (isHost ? ' host-bub' : '') + '">' +
    '<div class="cname">' + escHtml(name) +
    (isHost ? '<span class="badge badge-host">HOST</span>' : '') +
    '</div>' +
    '<div class="ctext">' + escHtml(text) + '</div>' +
    '</div>' +
    '<div class="cmeta">' +
    '<span class="ctime">just now</span>' +
    '<button class="clbtn" onclick="this.classList.toggle(\'clk\');' +
    'this.textContent=this.classList.contains(\'clk\')?\'Liked 👍\':\'Like\'">Like</button>' +
    '</div>' +
    '</div>' +
    '</div>'
  );
}

export function bakeDynamicComments(html: string): { html: string; baked: number } {
  if (!html || typeof html !== 'string') return { html, baked: 0 };

  const match = html.match(TIMED_RE);
  if (!match) return { html, baked: 0 };

  const entries = parseTimed(match[1]);
  if (!entries || entries.length === 0) return { html, baked: 0 };

  // Timeline order (ascending d). The engine prepends each new comment
  // (insertBefore firstChild), so the final DOM order is newest-first.
  const sorted = entries
    .filter((c) => c && (c.t || c.n))
    .slice()
    .sort((a, b) => (a.d || 0) - (b.d || 0));
  if (sorted.length === 0) return { html, baked: 0 };

  const now = Date.now();
  const maxD = sorted[sorted.length - 1].d || 0;

  // Emit rows newest-first (highest d at top) to match runtime DOM order,
  // and backdate data-ts so relTime() shows a sensible "x ago".
  const rows = sorted
    .slice()
    .reverse()
    .map((c) => buildCommentRow(c, now - Math.max(0, maxD - (c.d || 0))))
    .join('');

  let out = html;

  // 1) Inject the baked rows as the first children of #clist. The cloned
  //    #clist is empty (comments were runtime-generated), so this simply
  //    populates it. Insert right after the opening tag to avoid the nested
  //    </div> ambiguity of a full inner-content replace.
  const clistOpenRe = /(<[a-z]+\b[^>]*\bid=["']clist["'][^>]*>)/i;
  if (!clistOpenRe.test(out)) return { html, baked: 0 };
  out = out.replace(clistOpenRe, (m) => m + rows);

  // 2) Update the comment counter (` · N comments`) if present.
  out = out.replace(
    /(<[a-z]+\b[^>]*\bid=["']cc-cnt["'][^>]*>)[\s\S]*?(<\/[a-z]+>)/i,
    (_m, open: string, close: string) =>
      `${open} · ${sorted.length} comment${sorted.length !== 1 ? 's' : ''}${close}`,
  );

  // 3) Blank the runtime timeline so the engine adds no duplicate comments.
  //    buildFullTimeline() over an empty array yields nothing; counters,
  //    countdown and video logic are untouched.
  out = out.replace(match[0], 'var TIMED = [];');

  return { html: out, baked: sorted.length };
}

function jsString(s: string): string {
  // Produce a safe single-line JS double-quoted string literal.
  return JSON.stringify(String(s));
}

// Reverse of bakeDynamicComments: read the (edited) static .citem nodes back
// into the runtime TIMED array so the live engine re-animates the comments with
// the user's edited text, then remove the static nodes. Keeps original timing
// (data-d) and host role (data-host). No-op when there's nothing baked or when
// DOMParser is unavailable (server-side).
// Matches a `var TIMED = [ ... ];` assignment, whether blanked (`[]`) or full.
const TIMED_ASSIGN_RE = /var\s+TIMED\s*=\s*\[[\s\S]*?\]\s*;/;

export function unbakeDynamicComments(html: string): { html: string; restored: number } {
  if (!html || typeof html !== 'string') return { html, restored: 0 };
  if (typeof DOMParser === 'undefined') return { html, restored: 0 };
  // Fast bail-outs: needs baked rows + a TIMED assignment to restore into.
  if (!/data-d=/.test(html) || !TIMED_ASSIGN_RE.test(html)) {
    return { html, restored: 0 };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return { html, restored: 0 };
  }

  const list = doc.getElementById('clist');
  if (!list) return { html, restored: 0 };

  const baked = Array.from(list.querySelectorAll('.citem[data-d]'));
  if (baked.length === 0) return { html, restored: 0 };

  const entries = baked
    .map((el) => {
      const d = parseInt(el.getAttribute('data-d') || '0', 10) || 0;
      const isHost = el.getAttribute('data-host') === '1';
      let name = '';
      const nameEl = el.querySelector('.cname');
      if (nameEl) {
        const clone = nameEl.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.badge').forEach((b) => b.remove());
        name = (clone.textContent || '').trim();
      }
      const text = (el.querySelector('.ctext')?.textContent || '').trim();
      return { d, n: name, t: text, isHost };
    })
    .filter((e) => e.n || e.t);

  if (entries.length === 0) return { html, restored: 0 };

  // Restore original firing order.
  entries.sort((a, b) => a.d - b.d);

  // Remove the static baked nodes — the engine will regenerate them.
  baked.forEach((el) => el.remove());

  const literal =
    'var TIMED = [\n' +
    entries
      .map((e) => {
        const parts = [`d:${e.d}`, `n:${jsString(e.n)}`, `t:${jsString(e.t)}`];
        if (e.isHost) parts.push('isHost:true');
        return '  {' + parts.join(', ') + '}';
      })
      .join(',\n') +
    '\n];';

  // Re-serialize. DOMParser preserves <script> bodies verbatim, so the TIMED
  // assignment survives and we swap in the rebuilt array (works whether it was
  // blanked to `[]` or re-attached in full from the pristine clone).
  let out = '<!doctype html>\n' + doc.documentElement.outerHTML;
  // Replacer function so `$` sequences in comment text (e.g. "$47") aren't
  // interpreted as capture-group references.
  out = out.replace(TIMED_ASSIGN_RE, () => literal);

  return { html: out, restored: entries.length };
}
