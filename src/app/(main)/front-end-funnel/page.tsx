'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import { fetchAffiliateSavedFunnels } from '@/lib/supabase-operations';
import { extractSectionContent } from '@/lib/project-sections';
import SwipeCinemaOverlay, {
  type SwipePageInfo, type SwipeLogEntry as OverlayLogEntry,
} from '@/components/SwipeCinemaOverlay';
import type { AffiliateSavedFunnel, SavedPrompt } from '@/types/database';
import {
  BUILT_IN_PAGE_TYPE_OPTIONS,
  PAGE_TYPE_CATEGORIES,
  STATUS_OPTIONS,
  SECTION_TYPE_COLORS,
  PageType,
  PageTypeOption,
  VisionJobSummary,
  VisionJobDetail,
} from '@/types';
import {
  Plus,
  Trash2,
  Loader2,
  ExternalLink,
  CheckCircle,
  XCircle,
  Search,
  FileText,
  Eye,
  Code,
  Settings,
  Wand2,
  X,
  Image as ImageIcon,
  Layers,
  Lightbulb,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  MessageSquare,
  FileStack,
  Target,
  Copy,
  Globe,
  Sparkles,
  Download,
  Paintbrush,
  BookOpen,
  Star,
  Smartphone,
  Monitor,
  Upload,
  FileSpreadsheet,
  Rocket,
  Link2,
  Send,
  ShieldCheck,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import VisualHtmlEditor from '@/components/VisualHtmlEditor';

// Helper: sanitize cloned HTML and rewrite ALL relative URLs to absolute using the original domain
// Strips scripts (unless keepScripts=true for quiz pages), rewrites src/href/url() so CSS, images, fonts load correctly in preview
const SAVED_SECTIONS_KEY = 'funnel-swiper-saved-sections';
const CLONED_URLS_KEY = 'funnel-swiper-cloned-urls';

interface SavedSectionEntry {
  id: string;
  name: string;
  html: string;
  sectionType: string;
  tags: string[];
  createdAt: string;
}

const SECTION_PATTERNS: { type: string; label: string; keywords: RegExp }[] = [
  { type: 'hero', label: 'Hero', keywords: /hero|banner|jumbotron|above.?fold|main.?heading/i },
  { type: 'cta', label: 'CTA / Offer', keywords: /buy.?now|order.?now|add.?to.?cart|get.?started|sign.?up|subscribe|acquista|compra|ordina|special.?offer|limited.?time|discount|sconto|offerta/i },
  { type: 'testimonial', label: 'Testimonial', keywords: /testimonial|review|customer.?say|what.?people|rating|stars?|verified|recension/i },
  { type: 'faq', label: 'FAQ', keywords: /faq|frequently|domand|question|q\s*&\s*a|accordion/i },
  { type: 'features', label: 'Features', keywords: /feature|benefit|vantagg|why.?choose|perch[eè]|how.?it.?works|come.?funziona/i },
  { type: 'pricing', label: 'Pricing', keywords: /pricing|price|prezzo|plan|bundle|package|\$\d|€\d|was\s*\$|original/i },
  { type: 'guarantee', label: 'Guarantee', keywords: /guarantee|garanzia|money.?back|risk.?free|refund|rimborso|soddisfatt/i },
  { type: 'social-proof', label: 'Social Proof', keywords: /as.?seen|featured.?in|trusted|media|press|logo|brand|partner/i },
  { type: 'video', label: 'Video', keywords: /video|watch|play|youtube|vimeo|wistia/i },
  { type: 'form', label: 'Form', keywords: /form|input|email|newsletter|contatt|submit|invia/i },
  { type: 'footer', label: 'Footer', keywords: /footer|copyright|©|privacy|terms|disclaimer|all.?rights/i },
  { type: 'header', label: 'Header / Nav', keywords: /header|nav|menu|logo/i },
  { type: 'comparison', label: 'Comparison', keywords: /comparison|vs\.?|versus|compar|before.?after|prima.?dopo/i },
  { type: 'ingredients', label: 'Ingredients', keywords: /ingredient|component|formula|composi|contien/i },
  { type: 'results', label: 'Results', keywords: /result|before.?&?.?after|trasform|success|clinical|study|studi/i },
];

function classifySection(el: Element): { type: string; label: string } {
  const text = (el.textContent || '').substring(0, 500).toLowerCase();
  const html = el.outerHTML.substring(0, 1000).toLowerCase();
  const combined = text + ' ' + html;

  for (const p of SECTION_PATTERNS) {
    if (p.keywords.test(combined)) return { type: p.type, label: p.label };
  }

  const hasImg = !!el.querySelector('img,picture,svg');
  const hasVideo = !!el.querySelector('video,iframe[src*="youtube"],iframe[src*="vimeo"]');
  const hasBtn = !!el.querySelector('a,button');
  const hasForm = !!el.querySelector('form,input');
  const hasList = !!el.querySelector('ul,ol');

  if (hasVideo) return { type: 'video', label: 'Video' };
  if (hasForm) return { type: 'form', label: 'Form' };
  if (hasImg && hasBtn) return { type: 'cta-image', label: 'Image + CTA' };
  if (hasImg) return { type: 'image-section', label: 'Image Section' };
  if (hasList) return { type: 'list', label: 'List / Steps' };
  if (hasBtn) return { type: 'cta', label: 'CTA' };

  return { type: 'content', label: 'Content' };
}

function fingerprint(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 200).toLowerCase();
}

function autoSaveSections(html: string, sourceUrl: string, pageName: string) {
  if (typeof window === 'undefined') return;
  const clonedUrls: string[] = JSON.parse(localStorage.getItem(CLONED_URLS_KEY) || '[]');
  const host = new URL(sourceUrl).hostname;
  if (clonedUrls.includes(host)) return;

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = bodyHtml;

  const skipTags = new Set(['style', 'script', 'link', 'meta', 'noscript', 'br', 'hr']);
  const existing: SavedSectionEntry[] = JSON.parse(localStorage.getItem(SAVED_SECTIONS_KEY) || '[]');
  const existingFingerprints = new Set(existing.map(s => fingerprint(s.html)));
  const newSections: SavedSectionEntry[] = [];
  let typeCounters: Record<string, number> = {};

  for (let i = 0; i < wrapper.children.length; i++) {
    const child = wrapper.children[i];
    const tag = child.tagName.toLowerCase();
    if (skipTags.has(tag)) continue;
    const text = (child.textContent || '').trim();
    if (text.length < 10 && !child.querySelector('img,video,picture,svg')) continue;

    const fp = fingerprint(child.outerHTML);
    if (existingFingerprints.has(fp)) continue;
    existingFingerprints.add(fp);

    const classified = classifySection(child);
    typeCounters[classified.type] = (typeCounters[classified.type] || 0) + 1;
    const count = typeCounters[classified.type];
    const shortHost = host.replace(/^www\./i, '').split('.')[0];
    const sectionName = `${classified.label}${count > 1 ? ' ' + count : ''} — ${shortHost}`;

    newSections.push({
      id: `auto-${Date.now()}-${i}`,
      name: sectionName,
      html: child.outerHTML,
      sectionType: classified.type,
      tags: [host, 'auto-saved', classified.type],
      createdAt: new Date().toISOString(),
    });
  }

  if (newSections.length === 0) return;

  const merged = [...newSections, ...existing];
  localStorage.setItem(SAVED_SECTIONS_KEY, JSON.stringify(merged));
  clonedUrls.push(host);
  localStorage.setItem(CLONED_URLS_KEY, JSON.stringify(clonedUrls));
}

/**
 * Auditor selection — same shape used by /clone-landing and /checkpoint.
 *   • 'claude'  → existing server-side path (Anthropic via Edge Functions /
 *                 funnel-swap-proxy / Fly.dev pipeline)
 *   • 'neo'     → enqueue with target_agent='openclaw:neo'   (worker su PC Neo)
 *   • 'morfeo'  → enqueue with target_agent='openclaw:morfeo' (worker su Mac Morfeo)
 *
 * The constants are duplicated (not imported) to keep this page hermetic and
 * avoid pulling in the whole clone-landing module just for 3 strings.
 */
type Auditor = 'claude' | 'neo' | 'morfeo';
const AUDITOR_LABEL: Record<Auditor, string> = {
  claude: 'Claude (server)',
  neo: 'Neo (OpenClaw locale)',
  morfeo: 'Morfeo (OpenClaw locale)',
};
const AUDITOR_TARGET_AGENT: Record<Auditor, string | null> = {
  claude: null,
  neo: 'openclaw:neo',
  morfeo: 'openclaw:morfeo',
};

/**
 * Client-side rewrite via OpenClaw using direct Supabase queue polling.
 * Bypasses Vercel's 60s serverless timeout by polling from the browser.
 *
 * `targetAgent` (optional) routes the job to a specific worker
 * (e.g. 'openclaw:morfeo') so the user-selected auditor at the top of
 * the page is honoured here too. When omitted, ANY worker can pick the
 * job (legacy behaviour kept for backward compat).
 */
// ────────────────────────────────────────────────────────────────────────
// Client-side text extractor — port of /api/quiz-rewrite/extract.
//
// Why inlined: that endpoint kept returning Netlify's "Internal Error.
// ID: 01KRH..." on big landing pages (HTML payload > Netlify's 6MB
// request body cap, and / or regex backtracking on malformed SPA dumps
// before our try/catch could even run). The entire function is pure
// regex over a string — no server reason. Running it in the user's
// browser sidesteps Netlify entirely.
// Kept verbatim with the server version so the rewrite shape stays
// identical (id-by-position).
// ────────────────────────────────────────────────────────────────────────
function extractTextsForRewriteClient(html: string): Array<{ original: string; tag: string; position: number }> {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');
  const bodyMatch = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : stripped;
  const texts: Array<{ original: string; tag: string; position: number }> = [];
  const seen = new Set<string>();
  const textTags = ['h1','h2','h3','h4','h5','h6','p','li','td','th','dt','dd','button','a','label','figcaption','blockquote','summary','legend'];
  const blockTags = new Set(['div','section','article','main','aside','header','footer','nav','h1','h2','h3','h4','h5','h6','p','ul','ol','li','dl','dt','dd','table','thead','tbody','tr','td','th','blockquote','figure','figcaption','form','fieldset','button','details','summary']);
  for (const tag of textTags) {
    const regex = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = regex.exec(bodyHtml)) !== null) {
      const innerHTML = match[2];
      const plain = innerHTML.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain.length < 2 || !/[a-zA-Z]/.test(plain)) continue;
      if (seen.has(plain)) continue;
      if (plain.includes('{') && plain.includes('}') && plain.includes('=>')) continue;
      const hasBlockChild = Array.from(innerHTML.matchAll(/<(div|section|article|p|h[1-6]|ul|ol|li|table|tr|td|th|blockquote|form|button)[^>]*>/gi))
        .some((m) => {
          const childTag = m[1].toLowerCase();
          if (!blockTags.has(childTag)) return false;
          const childContent = innerHTML.slice((m.index ?? 0) + m[0].length);
          const closeIdx = childContent.indexOf(`</${childTag}`);
          if (closeIdx === -1) return false;
          const childText = childContent.slice(0, closeIdx).replace(/<[^>]*>/g, '').trim();
          return childText.length >= 2;
        });
      if (hasBlockChild) continue;
      seen.add(plain);
      texts.push({ original: plain, tag, position: match.index || 0 });
    }
  }
  const inlineRegex = /<(span|div|strong|em|b|i)([^>]*)>([^<]{3,500})<\/\1>/gi;
  let inMatch;
  while ((inMatch = inlineRegex.exec(bodyHtml)) !== null) {
    const text = inMatch[3].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 3 || !/[a-zA-Z]/.test(text) || seen.has(text)) continue;
    seen.add(text);
    texts.push({ original: text, tag: inMatch[1], position: inMatch.index || 0 });
  }
  const attrRegex = /(alt|title|placeholder|aria-label)=["']([^"']{3,200})["']/gi;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(bodyHtml)) !== null) {
    const val = attrMatch[2].trim();
    if (val.length < 3 || !/[a-zA-Z]/.test(val) || seen.has(val) || val.startsWith('http')) continue;
    seen.add(val);
    texts.push({ original: val, tag: `attr:${attrMatch[1]}`, position: 0 });
  }
  return texts;
}
const REWRITE_SYSTEM_PROMPT = `You are a direct-response copywriter. You rewrite marketing texts for a specific product while keeping the EXACT SAME tone, style, length, and persuasion structure.

RULES:
1. Rewrite each text to sell THE PRODUCT, keeping the same emotional angle and copywriting technique.
2. Keep roughly the same length (±20%).
3. Keep the same language/tone (if original is casual, stay casual; if urgent, stay urgent).
4. Do NOT add markdown, HTML tags, or formatting — return plain text only for each item.
5. If a text is a button label, CTA, or short phrase, keep it short and punchy.
6. If a text is clearly structural (like "Step 1", "FAQ", numbers), keep it unchanged or adapt minimally.
7. Return a JSON array of objects: [{"id": 0, "rewritten": "new text"}, ...]
8. Return ONLY the JSON array, nothing else.`;

async function rewriteWithOpenClawFromBrowser(args: {
  html: string;
  productName: string;
  productDescription: string;
  customPrompt?: string;
  targetAgent?: string | null;
  onProgress?: (batchesDone: number, batchesTotal: number) => void;
}): Promise<{ html: string; replacements: number; totalTexts: number; originalLength: number; newLength: number; provider: string }> {
  const { html, productName, productDescription, customPrompt, targetAgent, onProgress } = args;
  const { supabase } = await import('@/lib/supabase');

  // 1. Extract texts CLIENT-SIDE (was hitting /api/quiz-rewrite/extract
  //    which kept returning Netlify "Internal Error. ID: ..." on big
  //    pages — see comment on extractTextsForRewriteClient above).
  const texts = extractTextsForRewriteClient(html);
  const systemPrompt = REWRITE_SYSTEM_PROMPT;

  if (texts.length === 0) throw new Error('No texts found to rewrite');

  // 2. Split into batches and enqueue each in Supabase (fast: <2s)
  const BATCH_SIZE = 100;
  const textsForAi = texts.map((t, i) => ({ id: i, text: t.original, tag: t.tag }));
  const batches: typeof textsForAi[] = [];
  for (let i = 0; i < textsForAi.length; i += BATCH_SIZE) {
    batches.push(textsForAi.slice(i, i + BATCH_SIZE));
  }

  const effectiveSystem = `${systemPrompt}\n\nPRODUCT: ${productName}\nDESCRIPTION: ${productDescription}${customPrompt ? `\nADDITIONAL: ${customPrompt}` : ''}`;

  const messageIds: string[] = [];
  for (const batch of batches) {
    const batchPrompt = `Rewrite these ${batch.length} texts for the product "${productName}":\n\n${JSON.stringify(batch, null, 2)}`;
    const insertRow: Record<string, unknown> = {
      user_message: batchPrompt,
      system_prompt: effectiveSystem,
      section: 'Quiz Rewrite',
      status: 'pending',
    };
    if (targetAgent) insertRow.target_agent = targetAgent;
    const { data, error } = await supabase
      .from('openclaw_messages')
      .insert(insertRow)
      .select('id')
      .single();
    if (error || !data) throw new Error(`Enqueue failed: ${error?.message || 'no data'}`);
    messageIds.push(data.id);
  }

  onProgress?.(0, batches.length);

  // 3. Poll Supabase directly from browser until all batches complete or timeout
  const POLL_INTERVAL = 3000;
  const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes
  const startTime = Date.now();
  const rewrites: Array<{ id: number; rewritten: string }> = [];
  const completedIds = new Set<string>();
  const errors: string[] = [];

  while (completedIds.size < messageIds.length) {
    if (Date.now() - startTime > MAX_WAIT_MS) {
      throw new Error(`OpenClaw timeout: only ${completedIds.size}/${messageIds.length} batches completed. Check that openclaw-worker.js is running on your PC.`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    const pendingIds = messageIds.filter(id => !completedIds.has(id));
    const { data: polled, error: pollError } = await supabase
      .from('openclaw_messages')
      .select('id, status, response, error_message')
      .in('id', pendingIds);

    if (pollError) {
      console.error('Poll error:', pollError.message);
      continue;
    }

    for (const row of polled || []) {
      if (row.status === 'completed' && row.response) {
        completedIds.add(row.id);
        try {
          let cleaned = String(row.response).trim();
          cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
          const startIdx = cleaned.indexOf('[');
          const endIdx = cleaned.lastIndexOf(']');
          if (startIdx >= 0 && endIdx > startIdx) cleaned = cleaned.substring(startIdx, endIdx + 1);
          const parsed = JSON.parse(cleaned) as Array<{ id: number; rewritten: string }>;
          rewrites.push(...parsed);
        } catch (err) {
          errors.push(`batch ${row.id}: JSON parse error`);
        }
      } else if (row.status === 'error') {
        completedIds.add(row.id);
        errors.push(`batch ${row.id}: ${row.error_message || 'unknown'}`);
      }
    }

    onProgress?.(completedIds.size, messageIds.length);
  }

  if (rewrites.length === 0) {
    throw new Error(`All batches failed. Errors: ${errors.slice(0, 3).join('; ')}`);
  }

  // 4. Apply replacements to the original HTML
  let resultHtml = html;
  let replacements = 0;
  for (const rw of rewrites) {
    const original = texts[rw.id];
    if (!original || !rw.rewritten || original.original === rw.rewritten) continue;
    const escaped = original.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    const before = resultHtml;
    resultHtml = resultHtml.replace(regex, rw.rewritten);
    if (resultHtml !== before) replacements++;
  }

  return {
    html: resultHtml,
    replacements,
    totalTexts: texts.length,
    originalLength: html.length,
    newLength: resultHtml.length,
    provider: 'openclaw',
  };
}

/**
 * Fetch wrapper that retries on transient gateway errors (502/503/504/408/429).
 * Long rewrite jobs (e.g. 100+ sequential batches against the Edge Function)
 * occasionally hit Netlify edge "Inactivity Timeout 504" or upstream 502
 * because Claude latency for that single batch went above ~26s. A single
 * retry recovers in the vast majority of cases.
 *
 * Reads the response as text exactly once (avoids the "body stream already
 * read" foot-gun) and gives the caller back both the Response and the raw
 * body string.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: { retries?: number; baseDelayMs?: number; label?: string },
): Promise<{ res: Response; raw: string }> {
  const retries = opts?.retries ?? 2;
  const baseDelay = opts?.baseDelayMs ?? 1500;
  const label = opts?.label || 'fetch';
  const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      const raw = await res.text();
      if (res.ok || !RETRYABLE.has(res.status) || attempt === retries) {
        return { res, raw };
      }
      console.warn(
        `[${label}] HTTP ${res.status} on attempt ${attempt + 1}/${retries + 1}; retrying after ${baseDelay * (attempt + 1)}ms`,
      );
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw err;
      console.warn(
        `[${label}] network error on attempt ${attempt + 1}/${retries + 1}; retrying after ${baseDelay * (attempt + 1)}ms`,
        err,
      );
    }
    await new Promise((r) => setTimeout(r, baseDelay * (attempt + 1)));
  }
  // Defensive: shouldn't reach here given the loop guard above.
  throw lastErr instanceof Error ? lastErr : new Error(`${label}: retry loop exhausted`);
}

function sanitizeClonedHtml(html: string, originalUrl: string, options?: { keepScripts?: boolean }): string {
  try {
    const base = new URL(originalUrl);
    const origin = base.origin; // https://example.com
    const pathDir = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1) || '/';
    const baseDir = `${origin}${pathDir}`; // https://example.com/path/

    // Resolve a relative URL to absolute
    const abs = (relative: string): string => {
      try {
        if (!relative || relative.startsWith('data:') || relative.startsWith('blob:') || relative.startsWith('#') || relative.startsWith('mailto:') || relative.startsWith('tel:')) return relative;
        if (relative.startsWith('http://') || relative.startsWith('https://')) return relative;
        if (relative.startsWith('//')) return `${base.protocol}${relative}`;
        if (relative.startsWith('/')) return `${origin}${relative}`;
        return `${baseDir}${relative}`;
      } catch { return relative; }
    };

    let clean = html;

    // 0. BEFORE removing scripts: extract video embed IDs from script tags & markup
    const videoEmbeds: { provider: string; id: string }[] = [];

    // Wistia: <script src="fast.wistia.com/embed/medias/VIDEOID.jsonp">
    const wistiaScripts = clean.matchAll(/fast\.wistia\.com\/embed\/medias\/([a-z0-9]+)/gi);
    for (const m of wistiaScripts) videoEmbeds.push({ provider: 'wistia', id: m[1] });
    // Wistia class pattern: class="wistia_async_VIDEOID" or class="wistia_embed wistia_async_VIDEOID"
    const wistiaClasses = clean.matchAll(/wistia_async_([a-z0-9]+)/gi);
    for (const m of wistiaClasses) {
      if (!videoEmbeds.some(v => v.provider === 'wistia' && v.id === m[1])) {
        videoEmbeds.push({ provider: 'wistia', id: m[1] });
      }
    }
    // Vimeo: player.vimeo.com/video/VIDEOID
    const vimeoMatches = clean.matchAll(/player\.vimeo\.com\/video\/(\d+)/gi);
    for (const m of vimeoMatches) videoEmbeds.push({ provider: 'vimeo', id: m[1] });
    // YouTube: youtube.com/embed/VIDEOID or youtu.be/VIDEOID
    const ytMatches = clean.matchAll(/(?:youtube\.com\/embed\/|youtu\.be\/)([\w-]+)/gi);
    for (const m of ytMatches) videoEmbeds.push({ provider: 'youtube', id: m[1] });
    // Loom: loom.com/embed/VIDEOID or loom.com/share/VIDEOID
    const loomMatches = clean.matchAll(/loom\.com\/(?:embed|share)\/([\w]+)/gi);
    for (const m of loomMatches) videoEmbeds.push({ provider: 'loom', id: m[1] });

    // 1. Remove scripts & dangerous content (unless keepScripts for quiz pages)
    clean = clean.replace(/<base[^>]*>/gi, '');
    if (!options?.keepScripts) {
      clean = clean.replace(/<script[\s\S]*?<\/script>/gi, '');
      clean = clean.replace(/<script[^>]*\/>/gi, '');
      // Non-quiz: remove noscript tags but keep inner content as fallback text
      clean = clean.replace(/<\/?noscript[^>]*>/gi, '');
      // Strip inline event handlers for security
      clean = clean.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
      clean = clean.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
    } else {
      // keepScripts=true: preserviamo i runtime (Swiper, FAQ accordion, sticky bar,
      // image gallery, ecc.) ma rimuoviamo comunque i pezzi pericolosi/rumorosi:
      //  - <noscript> blocks (mostrano messaggi "Activate JavaScript")
      //  - inline event handlers (onclick=, onerror=, ...) che possono nascondere
      //    redirect verso il dominio originale o leak di referer.
      clean = clean.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
      clean = clean.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
      clean = clean.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
    }
    clean = clean.replace(/(href|src)\s*=\s*"javascript:[^"]*"/gi, '$1=""');
    clean = clean.replace(/(href|src)\s*=\s*'javascript:[^']*'/gi, "$1=''");

    // 2. Rewrite ALL relative URLs in HTML attributes to absolute
    // Handles: src, href, action, poster, data-src, data-lazy-src, data-bg, srcset, content (meta)
    const urlAttrs = ['src', 'href', 'action', 'poster', 'data-src', 'data-lazy-src', 'data-original', 'data-bg', 'data-image', 'content'];
    for (const attr of urlAttrs) {
      // Double-quoted attributes
      const dblRegex = new RegExp(`(${attr}\\s*=\\s*")([^"]*)(")`, 'gi');
      clean = clean.replace(dblRegex, (_m, pre, url, post) => {
        if (attr === 'content' && !url.match(/\.(css|js|png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|eot)/i)) return `${pre}${url}${post}`;
        return `${pre}${abs(url)}${post}`;
      });
      // Single-quoted attributes
      const sglRegex = new RegExp(`(${attr}\\s*=\\s*')([^']*)(')`, 'gi');
      clean = clean.replace(sglRegex, (_m, pre, url, post) => {
        if (attr === 'content' && !url.match(/\.(css|js|png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|eot)/i)) return `${pre}${url}${post}`;
        return `${pre}${abs(url)}${post}`;
      });
    }

    // 3. Rewrite srcset (contains multiple URLs with sizes)
    clean = clean.replace(/(srcset\s*=\s*")([^"]*?)(")/gi, (_m, pre, srcset, post) => {
      const fixed = srcset.split(',').map((entry: string) => {
        const parts = entry.trim().split(/\s+/);
        if (parts[0]) parts[0] = abs(parts[0]);
        return parts.join(' ');
      }).join(', ');
      return `${pre}${fixed}${post}`;
    });

    // 4. Rewrite url() in inline styles and <style> blocks
    clean = clean.replace(/url\(\s*["']?(?!data:|https?:|blob:)(\/\/[^"')]+|[^"')]+)["']?\s*\)/gi, (_m, url) => {
      return `url("${abs(url.trim())}")`;
    });

    // 5. Rewrite @import url() in <style> blocks
    clean = clean.replace(/@import\s+["'](?!https?:|\/\/)([^"']+)["']/gi, (_m, url) => {
      return `@import "${abs(url)}"`;
    });
    clean = clean.replace(/@import\s+url\(\s*["']?(?!https?:|\/\/)([^"')]+)["']?\s*\)/gi, (_m, url) => {
      return `@import url("${abs(url)}")`;
    });

    // 6. Fix lazy-loaded media & images: promote data-src/data-lazy-src to src
    const lazyTags = 'iframe|video|source|img';
    const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-wf-src', 'data-image', 'data-lazy'];
    for (const lazyAttr of lazyAttrs) {
      const dblLazy = new RegExp(`<(${lazyTags})([^>]*?)\\s${lazyAttr}\\s*=\\s*"([^"]*)"([^>]*?)>`, 'gi');
      clean = clean.replace(dblLazy, (_m, tag, before, val, after) => {
        const srcMatch = (before + after).match(/\ssrc\s*=\s*"([^"]*)"/i);
        if (srcMatch) {
          const existingSrc = srcMatch[1];
          const isPlaceholder = !existingSrc || existingSrc.startsWith('data:image') ||
            /placeholder|blank|pixel|spacer|grey|gray|1x1|transparent/i.test(existingSrc) ||
            existingSrc === '#';
          if (isPlaceholder && val) {
            const fixed = (before + after).replace(/\ssrc\s*=\s*"[^"]*"/i, ` src="${val}"`);
            return `<${tag}${fixed}>`;
          }
          return _m;
        }
        return `<${tag}${before} src="${val}"${after}>`;
      });
      const sglLazy = new RegExp(`<(${lazyTags})([^>]*?)\\s${lazyAttr}\\s*=\\s*'([^']*)'([^>]*?)>`, 'gi');
      clean = clean.replace(sglLazy, (_m, tag, before, val, after) => {
        const srcMatch = (before + after).match(/\ssrc\s*=\s*'([^']*)'/i);
        if (srcMatch) {
          const existingSrc = srcMatch[1];
          const isPlaceholder = !existingSrc || existingSrc.startsWith('data:image') ||
            /placeholder|blank|pixel|spacer|grey|gray|1x1|transparent/i.test(existingSrc) ||
            existingSrc === '#';
          if (isPlaceholder && val) {
            const fixed = (before + after).replace(/\ssrc\s*=\s*'[^']*'/i, ` src='${val}'`);
            return `<${tag}${fixed}>`;
          }
          return _m;
        }
        return `<${tag}${before} src="${val}"${after}>`;
      });
    }

    // 6b. Force eager loading on all images (lazy loading doesn't trigger in iframe previews)
    clean = clean.replace(/(<img\b[^>]*)\sloading\s*=\s*["']lazy["']/gi, '$1 loading="eager"');

    // 6c. Promote data-bg to inline background-image so CSS-background images render
    clean = clean.replace(/<([a-z][a-z0-9]*)\b([^>]*?)\sdata-bg\s*=\s*"([^"]*)"([^>]*?)>/gi, (_m, tag, before, bgUrl, after) => {
      const existingStyle = (before + after).match(/style\s*=\s*"([^"]*)"/i);
      if (existingStyle && existingStyle[1].includes('background-image')) return _m;
      const styleAdd = `background-image:url('${bgUrl}')`;
      if (existingStyle) {
        const updated = (before + after).replace(/style\s*=\s*"([^"]*)"/i, `style="$1;${styleAdd}"`);
        return `<${tag}${updated}>`;
      }
      return `<${tag}${before} style="${styleAdd}"${after}>`;
    });

    // 7. Inject fallback iframes for JS-based video embeds detected in step 0
    const iframeStyle = 'width:100%;height:100%;position:absolute;top:0;left:0;border:0';
    const iframeAllow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';

    for (const embed of videoEmbeds) {
      let embedUrl = '';
      if (embed.provider === 'wistia') embedUrl = `https://fast.wistia.net/embed/iframe/${embed.id}?autoPlay=false`;
      if (embed.provider === 'vimeo') embedUrl = `https://player.vimeo.com/video/${embed.id}`;
      if (embed.provider === 'youtube') embedUrl = `https://www.youtube.com/embed/${embed.id}`;
      if (embed.provider === 'loom') embedUrl = `https://www.loom.com/embed/${embed.id}`;
      if (!embedUrl) continue;

      const embedIframe = `<iframe src="${embedUrl}" allow="${iframeAllow}" allowfullscreen style="${iframeStyle}" frameborder="0"></iframe>`;

      // Wistia: replace empty wistia_embed/wistia_async divs with the iframe
      if (embed.provider === 'wistia') {
        const wistiaPattern = new RegExp(
          `(<div[^>]*class="[^"]*(?:wistia_embed|wistia_async_${embed.id})[^"]*"[^>]*>)([\\s\\S]*?)(</div>)`,
          'i'
        );
        if (wistiaPattern.test(clean)) {
          clean = clean.replace(wistiaPattern, (_m, open, inner, close) => {
            if (/<iframe/i.test(inner)) return _m;
            const wrapper = open.replace(/style="([^"]*)"/i, `style="$1;position:relative;aspect-ratio:16/9"`);
            return `${wrapper}${embedIframe}${close}`;
          });
        } else {
          // Wistia div might not exist in raw HTML — find a likely video container and inject
          const containerPattern = /(<div[^>]*class="[^"]*(?:video|player|wistia|vsl|hero-video|embed)[^"]*"[^>]*>)\s*(<\/div>)/i;
          if (containerPattern.test(clean)) {
            clean = clean.replace(containerPattern, (_m, open, close) => {
              const wrapper = open.replace(/style="([^"]*)"/i, `style="$1;position:relative;aspect-ratio:16/9"`);
              return `${wrapper}${embedIframe}${close}`;
            });
          }
        }
      }

      // For other providers: check if their iframe already exists (from step 6 data-src fix),
      // if not, try to inject into an appropriate container
      if (embed.provider !== 'wistia') {
        const srcCheck = new RegExp(embed.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (!srcCheck.test(clean)) {
          const containerPattern = /(<div[^>]*class="[^"]*(?:video|player|vsl|hero-video|embed)[^"]*"[^>]*>)\s*(<\/div>)/i;
          if (containerPattern.test(clean)) {
            clean = clean.replace(containerPattern, (_m, open, close) => {
              const wrapper = open.replace(/style="([^"]*)"/i, `style="$1;position:relative;aspect-ratio:16/9"`);
              return `${wrapper}${embedIframe}${close}`;
            });
          }
        }
      }
    }

    // 8. Vidyard fallback
    clean = clean.replace(/<img[^>]*class="[^"]*vidyard-player-embed[^"]*"[^>]*data-uuid="([^"]+)"[^>]*\/?>/gi, (_m, uuid) => {
      return `<iframe src="https://play.vidyard.com/${uuid}" allow="${iframeAllow}" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0" frameborder="0"></iframe>`;
    });

    // 9. Ensure all iframes have allow attributes for playback
    clean = clean.replace(/<iframe([^>]*?)>/gi, (_m, attrs) => {
      if (/\sallow\s*=/i.test(attrs)) return _m;
      return `<iframe${attrs} allow="${iframeAllow}">`;
    });

    // 10. Remove ALL existing CSP meta tags (they block resources when served from a different origin)
    clean = clean.replace(/<meta[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '');
    clean = clean.replace(/<meta[^>]*content\s*=\s*["'][^"']*(?:default-src|script-src|img-src|font-src|style-src)[^"']*["'][^>]*http-equiv[^>]*>/gi, '');

    // Remove existing referrer policies (we'll inject our own)
    clean = clean.replace(/<meta[^>]*name\s*=\s*["']referrer["'][^>]*>/gi, '');

    // Inject no-referrer so CDNs with hotlink protection serve images
    const metaTags = `<meta name="referrer" content="no-referrer">`;
    if (clean.includes('<head>')) {
      clean = clean.replace('<head>', `<head>\n${metaTags}`);
    } else if (clean.includes('<head ')) {
      clean = clean.replace(/<head\s[^>]*>/, `$&\n${metaTags}`);
    } else {
      clean = `${metaTags}\n${clean}`;
    }

    // 11. Strip <li> vuoti che rendono come "punti orfani" nelle bullet list
    //     (es. <li>&nbsp;</li>, <li><br></li>, <li>  </li>). Spesso lasciati
    //     dal builder originale come spaziature, oppure introdotti dalla
    //     pipeline di clone/rewrite quando l'<li> conteneva solo whitespace
    //     o tag inline svuotati (icone <i>, <span> rimossi, ecc.).
    //     Esegui in loop perche dopo aver tolto un <li> vuoto, l'<li>
    //     successivo potrebbe diventare "vuoto" se conteneva solo l'altro.
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

    return clean;
  } catch {
    return html;
  }
}

// Type for steps inside affiliate_saved_funnels.steps (JSONB)
interface AffiliateFunnelStep {
  step_index: number;
  url: string;
  title: string;
  step_type?: string;
  input_type?: string;
  options?: string[];
  description?: string;
  cta_text?: string;
}

// API endpoints - can switch between local proxy, direct fly.dev, or local dev server
const API_ENDPOINTS = {
  local: {
    name: 'Local Proxy',
    icon: '🖥️',
    start: '/api/pipeline/start',
    status: (jobId: string) => `/api/pipeline/status/${jobId}`,
    result: (jobId: string) => `/api/pipeline/result/${jobId}`,
    resultJson: (jobId: string) => `/api/pipeline/result/${jobId}?format=json`,
    jobs: '/api/pipeline/jobs',
  },
  server: {
    name: 'Fly.dev',
    icon: '☁️',
    start: 'https://claude-code-agents.fly.dev/api/pipeline/jobs/start',
    status: (jobId: string) => `https://claude-code-agents.fly.dev/api/pipeline/jobs/${jobId}/status`,
    result: (jobId: string) => `https://claude-code-agents.fly.dev/api/pipeline/jobs/${jobId}/result`,
    resultJson: (jobId: string) => `https://claude-code-agents.fly.dev/api/pipeline/jobs/${jobId}/result/json`,
    jobs: 'https://claude-code-agents.fly.dev/api/pipeline/jobs',
  },
  localDev: {
    name: 'Dev Server',
    icon: '🔧',
    start: 'http://localhost:8081/api/pipeline/jobs/start',
    status: (jobId: string) => `http://localhost:8081/api/pipeline/jobs/${jobId}/status`,
    result: (jobId: string) => `http://localhost:8081/api/pipeline/jobs/${jobId}/result`,
    resultJson: (jobId: string) => `http://localhost:8081/api/pipeline/jobs/${jobId}/result/json`,
    jobs: 'http://localhost:8081/api/pipeline/jobs',
  },
};

type ApiMode = 'local' | 'server' | 'localDev';

interface SwipeJobConfig {
  url: string;
  product_name: string;
  product_description: string;
  cta_text: string;
  cta_url: string;
  language: string;
  benefits: string[];
  brand_name: string;
  prompt?: string;
}

interface JobStatus {
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  current_layer?: string;
  error?: string;
  result_url?: string;
  started_at?: string;
  completed_at?: string;
  vision_job_id?: string;
}

interface ActiveJob {
  pageId: string;
  jobId: string;
  status: JobStatus['status'];
  progress: number;
  currentLayer?: string;
  startedAt?: Date;
  lastUpdate?: Date;
  visionJobId?: string;
}

const STEP_TYPE_TO_PAGE_TYPE: Record<string, PageType> = {
  quiz_question: 'quiz_funnel',
  info_screen: 'quiz_funnel',
  checkout: 'checkout',
  landing: 'landing',
  lead_capture: 'opt_in',
  upsell: 'upsell',
  downsell: 'downsell',
  thank_you: 'thank_you',
  sales_page: 'sales_letter',
  order_form: 'checkout',
};

function DebouncedInput({
  value: externalValue,
  onChange,
  ...props
}: {
  value: string;
  onChange: (value: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  const [localValue, setLocalValue] = useState(externalValue);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setLocalValue(externalValue);
  }, [externalValue]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setLocalValue(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onChange(v), 600);
  };

  const handleBlur = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (localValue !== externalValue) onChange(localValue);
  };

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  return <input {...props} value={localValue} onChange={handleChange} onBlur={handleBlur} />;
}

export default function FrontEndFunnel() {
  const searchParams = useSearchParams();
  const {
    projects,
    templates,
    funnelPages,
    addFunnelPage,
    updateFunnelPage,
    deleteFunnelPage,
    customPageTypes,
    addCustomPageType,
    saveCurrentFunnelAsArchive,
  } = useStore();

  const allPageTypeOptions: PageTypeOption[] = [
    ...BUILT_IN_PAGE_TYPE_OPTIONS,
    ...(customPageTypes || []).map((ct) => ({
      value: ct.value,
      label: ct.label,
      category: 'custom' as const,
    })),
  ];

  // Group page types by category for select dropdown
  const groupedPageTypes: Record<string, PageTypeOption[]> = {};
  PAGE_TYPE_CATEGORIES.forEach(cat => {
    groupedPageTypes[cat.value] = allPageTypeOptions.filter(opt => opt.category === cat.value);
  });

  // Get label for a page type value
  const getPageTypeLabel = (value: PageType): string => {
    const option = allPageTypeOptions.find(opt => opt.value === value);
    return option?.label || value;
  };

  const [loadingIds, setLoadingIds] = useState<string[]>([]);
  const [analyzingIds, setAnalyzingIds] = useState<string[]>([]);
  const [analysisModal, setAnalysisModal] = useState<{
    isOpen: boolean;
    pageId: string;
    result: string | null;
    extractedData: { headline: string; subheadline: string; cta: string[]; price: string | null; benefits: string[] } | null;
  }>({ isOpen: false, pageId: '', result: null, extractedData: null });

  const [htmlPreviewModal, setHtmlPreviewModal] = useState<{
    isOpen: boolean;
    title: string;
    html: string;
    mobileHtml: string;
    iframeSrc: string;
    metadata: { method: string; length: number; duration: number } | null;
    pageId?: string;
    sourceType?: 'cloned' | 'swiped';
  }>({ isOpen: false, title: '', html: '', mobileHtml: '', iframeSrc: '', metadata: null });

  const [showVisualEditor, setShowVisualEditor] = useState(false);

  // Custom page type creation inline
  const [newTypeForPageId, setNewTypeForPageId] = useState<string | null>(null);
  const [newTypeName, setNewTypeName] = useState('');

  // Swipe Configuration Modal
  const [swipeConfigModal, setSwipeConfigModal] = useState<{
    isOpen: boolean;
    pageId: string;
    pageName: string;
    url: string;
  }>({ isOpen: false, pageId: '', pageName: '', url: '' });

  const [swipeConfig, setSwipeConfig] = useState<SwipeJobConfig>({
    url: '',
    product_name: '',
    product_description: '',
    cta_text: 'BUY NOW',
    cta_url: '',
    language: 'en',
    benefits: [],
    brand_name: '',
    prompt: '',
  });
  const [benefitInput, setBenefitInput] = useState('');

  // Active Jobs tracking
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  // Guard: evita tick di polling sovrapposti se una passata supera l'intervallo.
  // Senza questo, su rete lenta o tanti job, setInterval lancia tick paralleli
  // → cascata di fetch + setState che congela il browser.
  const pollingInFlightRef = useRef(false);
  // Snapshot di activeJobs/funnelPages aggiornati a ogni render. Usati dentro
  // il poll loop per non dover ricreare l'interval ogni volta che lo store
  // cambia (ogni updateFunnelPage cambiava funnelPages → pollJobStatus
  // ricreata → effect re-run → clearInterval+setInterval ad ogni 5s).
  const activeJobsRef = useRef<ActiveJob[]>([]);
  activeJobsRef.current = activeJobs;

  // Save Funnel Modal
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveFunnelName, setSaveFunnelName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  /* ────────── Swipe All ──────────
   * Orchestratore che riscrive in sequenza TUTTE le pagine eligibili del
   * funnel, accumulando un "funnel narrative" tra una pagina e l'altra
   * (estratto via Claude da ciascuna pagina riscritta) per garantire
   * coerenza di voce, angle, big promise, pain point e CTA logic
   * lungo tutto il funnel. */
  type SwipeAllStep = 'idle' | 'cloning' | 'rewriting' | 'narrative';
  interface SwipeAllErr { pageId: string; pageName: string; message: string }
  const [swipeAllJob, setSwipeAllJob] = useState<{
    isRunning: boolean;
    cancelRequested: boolean;
    currentIndex: number;
    totalCount: number;
    currentStep: SwipeAllStep;
    currentPageName: string;
    batchInfo: string;
    completed: number;
    errors: SwipeAllErr[];
    startedAt: number;
  } | null>(null);
  const swipeAllCancelRef = useRef(false);

  // API Mode
  const [apiMode, setApiMode] = useState<ApiMode>('localDev');
  const api = API_ENDPOINTS[apiMode];

  // ── Global auditor selector ───────────────────────────────────────
  // Drives where ALL clone/swipe/rewrite/checkpoint actions go:
  //   • 'claude' → existing server-side path (Anthropic / Edge Function /
  //                Fly.dev pipeline) — unchanged
  //   • 'neo' / 'morfeo' → enqueue jobs in openclaw_messages with the
  //                matching target_agent so ONLY that worker picks them
  // Sticky in localStorage so the user doesn't have to reselect every
  // page reload.
  const [auditor, setAuditorState] = useState<Auditor>('claude');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const v = window.localStorage.getItem('frontend_funnel_auditor');
    if (v === 'claude' || v === 'neo' || v === 'morfeo') setAuditorState(v);
  }, []);
  const setAuditor = useCallback((next: Auditor) => {
    setAuditorState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('frontend_funnel_auditor', next);
    }
  }, []);
  const auditorRef = useRef<Auditor>('claude');
  useEffect(() => { auditorRef.current = auditor; }, [auditor]);

  // Jobs Monitor Panel
  const [showJobsPanel, setShowJobsPanel] = useState(false);

  // Saved Funnels (from affiliate_saved_funnels)
  const [affiliateFunnels, setAffiliateFunnels] = useState<AffiliateSavedFunnel[]>([]);
  const [affiliateFunnelsLoading, setAffiliateFunnelsLoading] = useState(false);
  const [affiliateFunnelsError, setAffiliateFunnelsError] = useState<string | null>(null);
  const [selectedAffiliateFunnelId, setSelectedAffiliateFunnelId] = useState<string | null>(null);

  // Saved Prompts
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [savedPromptsLoaded, setSavedPromptsLoaded] = useState(false);

  // Clone Modal (smooth-responder Edge Function)
  const [cloneModal, setCloneModal] = useState<{
    isOpen: boolean;
    pageId: string;
    pageName: string;
    url: string;
  }>({ isOpen: false, pageId: '', pageName: '', url: '' });
  const [cloneMode, setCloneMode] = useState<'identical' | 'rewrite' | 'translate'>('identical');
  const [cloneMobile, setCloneMobile] = useState(true);
  const [previewViewport, setPreviewViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [previewTab, setPreviewTab] = useState<'preview' | 'html'>('preview');
  // Spinner overlay durante remount dell'iframe preview. doc.write(safeHtml)
  // su HTML grandi blocca il main thread (~500-2000ms). Mostriamo "Caricamento
  // anteprima…" mentre la doc.write avviene in setTimeout(0) cosi' il
  // browser puo' almeno disegnare lo spinner prima del freeze.
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editableHtml, setEditableHtml] = useState('');
  const [cloneConfig, setCloneConfig] = useState({
    productName: '',
    productDescription: '',
    framework: '',
    target: '',
    customPrompt: '',
    language: 'it',
    targetLanguage: 'Italiano',
    useOpenClaw: false,
    // Optional: pulled from the linked Project (My Projects → Brief tab and
    // Market Research tab). Sent to the rewrite proxy so Claude can use the
    // project brief as primary source of truth for tone/positioning and the
    // research as ground truth for pains/desires/language.
    brief: '',
    marketResearch: '',
  });
  const [cloningIds, setCloningIds] = useState<string[]>([]);
  const [cloneProgress, setCloneProgress] = useState<{
    phase: string;
    totalTexts: number;
    processedTexts: number;
    message: string;
  } | null>(null);

  // Live activity log for the cinematic overlay. Each rewrite step
  // (cloning, extracting, per-batch progress, narrative, completion)
  // pushes a structured event here so the overlay can render a real
  // timeline. Capped at 200 entries (FIFO) to keep memory bounded.
  type SwipeLogKind = 'info' | 'progress' | 'success' | 'warn' | 'error' | 'rewrite';
  interface SwipeLogEntry {
    id: number;
    at: number;
    kind: SwipeLogKind;
    pageName?: string;
    message: string;
  }
  const [swipeLog, setSwipeLog] = useState<SwipeLogEntry[]>([]);
  const swipeLogIdRef = useRef(0);
  const pushSwipeLog = useCallback((kind: SwipeLogKind, message: string, pageName?: string) => {
    swipeLogIdRef.current += 1;
    setSwipeLog((prev) => {
      const next = [...prev, { id: swipeLogIdRef.current, at: Date.now(), kind, pageName, message }];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }, []);

  // Live "before → after" rewrite stream for the cinematic overlay's
  // central panel. The Edge Function returns a `rewrites` array with each
  // process-batch response (since v2026-05-10) containing the actual
  // (original, rewritten) pairs Claude produced for the batch. We push
  // them here in the order they arrive so the overlay can scroll through
  // them like a film reel. Capped at 250 (FIFO) to bound memory on long
  // Swipe-All runs across dozens of pages.
  interface RewriteStreamEntry {
    id: number;
    at: number;
    pageName: string;
    original: string;
    rewritten: string;
  }
  const [rewriteStream, setRewriteStream] = useState<RewriteStreamEntry[]>([]);
  const rewriteStreamIdRef = useRef(0);
  const pushRewrites = useCallback(
    (rewrites: Array<{ original?: string; rewritten?: string }> | undefined, pageName: string) => {
      if (!rewrites || rewrites.length === 0) return;
      const now = Date.now();
      const additions: RewriteStreamEntry[] = [];
      for (const r of rewrites) {
        const original = (r?.original ?? '').trim();
        const rewritten = (r?.rewritten ?? '').trim();
        if (!original || !rewritten || original === rewritten) continue;
        rewriteStreamIdRef.current += 1;
        additions.push({
          id: rewriteStreamIdRef.current,
          at: now,
          pageName,
          original,
          rewritten,
        });
      }
      if (additions.length === 0) return;
      setRewriteStream((prev) => {
        const next = prev.concat(additions);
        return next.length > 250 ? next.slice(next.length - 250) : next;
      });
    },
    [],
  );
  const resetSwipeLog = useCallback(() => {
    setSwipeLog([]);
    swipeLogIdRef.current = 0;
    setRewriteStream([]);
    rewriteStreamIdRef.current = 0;
  }, []);

  // Wallclock tick — forces re-render once per second so the overlay can
  // show a live elapsed timer + ETA without each progress callback having
  // to bump state. Only ticks while something is actually running.
  const isAnyRewriteActive = !!cloneProgress || !!(cloneProgress === null && false); // recomputed below; placeholder for hook deps
  const [overlayClock, setOverlayClock] = useState(0);
  useEffect(() => {
    // We can't reference swipeAllJob/cloneProgress inside the effect body
    // for `isActive` because they're declared after this point in the
    // function — but since this effect re-runs on every render that
    // changes either state, the interval is kept fresh.
    const id = setInterval(() => setOverlayClock((c) => c + 1), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  void overlayClock; void isAnyRewriteActive; // silence unused warnings; consumed by overlay render

  // Vision Analysis Modal
  const [visionModal, setVisionModal] = useState<{
    isOpen: boolean;
    pageId: string;
    pageName: string;
    sourceUrl: string;
  }>({ isOpen: false, pageId: '', pageName: '', sourceUrl: '' });
  const [visionJobs, setVisionJobs] = useState<VisionJobSummary[]>([]);
  const [selectedVisionJob, setSelectedVisionJob] = useState<VisionJobDetail | null>(null);
  const [visionLoading, setVisionLoading] = useState(false);
  const [visionError, setVisionError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<number[]>([]);

  // Domain & Publish
  const [funnelDomain, setFunnelDomain] = useState('');
  const [stepSlugs, setStepSlugs] = useState<Record<string, string>>({});
  const [publishingIds, setPublishingIds] = useState<Record<string, 'repli' | 'checkoutchamp'>>({});

  // Checkpoint import — tracks which row is currently being added to
  // the audit library so we can show a spinner per-button.
  const router = useRouter();
  const [checkpointingIds, setCheckpointingIds] = useState<string[]>([]);
  const [bulkCheckpointing, setBulkCheckpointing] = useState(false);

  const generateSlug = useCallback((name: string, index: number) => {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 40);
    return base || `step-${index + 1}`;
  }, []);

  const autoGenerateSlugs = useCallback(() => {
    if (!funnelPages || funnelPages.length === 0) return;
    const newSlugs: Record<string, string> = {};
    funnelPages.forEach((page, i) => {
      newSlugs[page.id] = stepSlugs[page.id] || generateSlug(page.name, i);
    });
    setStepSlugs(newSlugs);
  }, [funnelPages, stepSlugs, generateSlug]);

  const getStepUrl = useCallback((pageId: string) => {
    if (!funnelDomain) return '';
    const slug = stepSlugs[pageId] || '';
    const domain = funnelDomain.replace(/\/+$/, '');
    const protocol = domain.startsWith('http') ? '' : 'https://';
    return `${protocol}${domain}/${slug}`;
  }, [funnelDomain, stepSlugs]);

  const getNextStepUrl = useCallback((pageId: string) => {
    const idx = funnelPages.findIndex(p => p.id === pageId);
    if (idx < 0 || idx >= funnelPages.length - 1) return '';
    return getStepUrl(funnelPages[idx + 1].id);
  }, [funnelPages, getStepUrl]);

  const injectCtaLinks = useCallback((html: string, nextUrl: string): string => {
    if (!nextUrl || !html) return html;
    let result = html;

    const ctaClassPattern = /btn|button|cta|buy|order|get-started|add-to-cart|checkout|shop-now|sign-up|subscribe|learn-more|try-now|start|join|claim|grab|reserve|enroll|action|primary|hero-link|main-link/i;
    const ctaTextPattern = /buy|order|get|shop|add to cart|checkout|subscribe|sign up|claim|grab|start|try|reserve|enroll|acquist|compra|ordina|scopri|ottieni|inizia|iscriviti|prenota/i;

    // Match every <a ...>TEXT</a> block to check both attributes and inner text
    result = result.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (fullMatch, attrs: string, innerContent: string) => {
      const isMailto = /href=["']mailto:/i.test(attrs);
      const isTel = /href=["']tel:/i.test(attrs);
      if (isMailto || isTel) return fullMatch;

      const hrefMatch = attrs.match(/href=["']([^"']*)["']/i);
      const currentHref = hrefMatch ? hrefMatch[1] : '';

      const isEmpty = !currentHref || currentHref === '#' || currentHref === '#!' || currentHref.startsWith('javascript:');
      const hasCtaClass = ctaClassPattern.test(attrs);
      const plainText = innerContent.replace(/<[^>]*>/g, '').trim();
      const hasCtaText = ctaTextPattern.test(plainText);
      const hasCtaStyle = /background|bg-|btn|button|padding.*:.*\d+px/i.test(attrs);

      if (isEmpty || hasCtaClass || hasCtaText || hasCtaStyle) {
        let newAttrs: string;
        if (hrefMatch) {
          newAttrs = attrs.replace(/href=["'][^"']*["']/i, `href="${nextUrl}"`);
        } else {
          newAttrs = `${attrs} href="${nextUrl}"`;
        }
        return `<a ${newAttrs}>${innerContent}</a>`;
      }

      return fullMatch;
    });

    // onclick patterns
    result = result.replace(
      /(onclick=["'][^"']*(?:location\.href|window\.location)\s*=\s*['"])([^"']*)(['"][^"']*["'])/gi,
      `$1${nextUrl}$3`,
    );

    return result;
  }, []);

  const [linkingInProgress, setLinkingInProgress] = useState(false);

  const applyLinksToAllSteps = useCallback(async () => {
    if (!funnelDomain || Object.keys(stepSlugs).length === 0) {
      alert('Set domain and generate step names first.');
      return;
    }
    setLinkingInProgress(true);
    let updated = 0;
    try {
      for (let i = 0; i < funnelPages.length; i++) {
        const page = funnelPages[i];
        const nextUrl = getNextStepUrl(page.id);
        if (!nextUrl) continue;

        const html = page.swipedData?.html || page.clonedData?.html;
        if (!html) continue;

        const linkedHtml = injectCtaLinks(html, nextUrl);
        if (linkedHtml === html) continue;

        if (page.swipedData?.html) {
          await updateFunnelPage(page.id, {
            swipedData: { ...page.swipedData, html: linkedHtml },
          });
        } else if (page.clonedData?.html) {
          await updateFunnelPage(page.id, {
            clonedData: { ...page.clonedData, html: linkedHtml },
          });
        }
        updated++;
      }
      alert(`CTA links updated in ${updated} step(s). Last step has no next link.`);
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Failed'}`);
    } finally {
      setLinkingInProgress(false);
    }
  }, [funnelDomain, stepSlugs, funnelPages, getNextStepUrl, injectCtaLinks, updateFunnelPage]);

  const handlePublish = useCallback(async (pageId: string, platform: 'repli' | 'checkoutchamp') => {
    const page = funnelPages.find(p => p.id === pageId);
    if (!page) return;
    const html = page.swipedData?.html || page.clonedData?.html;
    if (!html) {
      alert('No HTML available. Clone or swipe the page first.');
      return;
    }
    const nextUrl = getNextStepUrl(pageId);
    const finalHtml = injectCtaLinks(html, nextUrl);
    const slug = stepSlugs[pageId] || generateSlug(page.name, funnelPages.indexOf(page));

    setPublishingIds(prev => ({ ...prev, [pageId]: platform }));
    try {
      if (platform === 'repli') {
        const domain = (funnelDomain || 'default').replace(/\/+$/, '').replace(/^https?:\/\//, '');
        const res = await fetch('/api/deploy/funnelish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            html: finalHtml,
            slug,
            domain,
            pageName: page.name,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Deploy failed');
        updateFunnelPage(pageId, { swipeResult: `Published → ${getStepUrl(pageId)}` });
      } else {
        const res = await fetch('/api/deploy/checkout-champ', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            html: finalHtml,
            funnelName: `${funnelDomain || 'funnel'}-funnel`,
            pageName: slug,
            pageType: page.pageType,
            email: '',
            password: '',
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Deploy failed');
        updateFunnelPage(pageId, { swipeResult: `CheckoutChamp → ${data.url || 'Deployed'}` });
      }
    } catch (err) {
      alert(`Publish error: ${err instanceof Error ? err.message : 'Failed'}`);
    } finally {
      setPublishingIds(prev => {
        const next = { ...prev };
        delete next[pageId];
        return next;
      });
    }
  }, [funnelPages, funnelDomain, stepSlugs, getNextStepUrl, injectCtaLinks, getStepUrl, generateSlug, updateFunnelPage]);

  /**
   * Sends a single funnel step into the Checkpoint audit library and
   * jumps straight to its detail page so the user can run the audit.
   * Reuses the same /api/checkpoint/funnels/import endpoint that the
   * Projects page modal uses, so dedup-per-project comes for free.
   */
  const handleCheckpointSingle = useCallback(
    async (pageId: string) => {
      const page = funnelPages.find((p) => p.id === pageId);
      if (!page) return;
      const url = (page.urlToSwipe || '').trim();
      if (!url) {
        alert('Questa riga non ha un URL: aggiungilo prima di mandarlo al Checkpoint.');
        return;
      }
      setCheckpointingIds((prev) => [...prev, pageId]);
      try {
        const res = await fetch('/api/checkpoint/funnels/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: page.productId || undefined,
            items: [{ name: page.name || undefined, url }],
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        const created = (body.created ?? []) as { id: string }[];
        const skipped = (body.skipped ?? []) as { reason: string }[];
        if (created[0]) {
          router.push(`/checkpoint/${created[0].id}`);
          return;
        }
        // Already-imported case: surface the existing entry in the list.
        if (skipped[0]?.reason?.includes('già presente')) {
          router.push('/checkpoint');
          return;
        }
        throw new Error(skipped[0]?.reason ?? 'Import non riuscito.');
      } catch (err) {
        alert(`Errore Checkpoint: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setCheckpointingIds((prev) => prev.filter((id) => id !== pageId));
      }
    },
    [funnelPages, router],
  );

  /**
   * Bulk variant: imports every step that has a URL into the audit
   * library, grouping by project so the dedup logic can scope its
   * per-project URL set. Lands on /checkpoint with the import banner.
   */
  const handleCheckpointAll = useCallback(async () => {
    const pages = (funnelPages || []).filter((p) => (p.urlToSwipe || '').trim());
    if (pages.length === 0) {
      alert('Nessuno step con URL valido da importare.');
      return;
    }
    if (
      !confirm(
        `Importare ${pages.length} pagina${pages.length === 1 ? '' : 'e'} nel Checkpoint?`,
      )
    ) {
      return;
    }

    setBulkCheckpointing(true);
    try {
      // Group by projectId so each batch hits the dedup correctly.
      const groups = new Map<string, typeof pages>();
      for (const p of pages) {
        const key = p.productId || '__no_project__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(p);
      }

      const allCreated: string[] = [];
      let allSkipped = 0;
      for (const [key, group] of groups) {
        const res = await fetch('/api/checkpoint/funnels/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: key === '__no_project__' ? undefined : key,
            items: group.map((p) => ({
              name: p.name || undefined,
              url: (p.urlToSwipe || '').trim(),
            })),
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        for (const c of (body.created ?? []) as { id: string }[]) {
          allCreated.push(c.id);
        }
        allSkipped += (body.skipped ?? []).length;
      }

      const params = new URLSearchParams();
      if (allCreated.length > 0) params.set('imported', allCreated.join(','));
      if (allSkipped > 0) params.set('skipped', String(allSkipped));
      router.push(`/checkpoint?${params.toString()}`);
    } catch (err) {
      alert(`Errore Checkpoint bulk: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBulkCheckpointing(false);
    }
  }, [funnelPages, router]);

  // Quiz Generation
  const [quizGenerating, setQuizGenerating] = useState(false);
  const [quizGenerationPhase, setQuizGenerationPhase] = useState('');
  const [quizPreviewHtml, setQuizPreviewHtml] = useState<string | null>(null);
  const [quizPreviewStats, setQuizPreviewStats] = useState<{
    totalSteps: number;
    quizQuestions: number;
    htmlSize: number;
    funnelName: string;
    brandName: string | null;
  } | null>(null);
  const [quizPreviewOpen, setQuizPreviewOpen] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);

  const selectedAffiliateFunnel = useMemo(
    () => (selectedAffiliateFunnelId ? affiliateFunnels.find((f) => f.id === selectedAffiliateFunnelId) : null),
    [selectedAffiliateFunnelId, affiliateFunnels]
  );

  const affiliateFunnelSteps = useMemo<AffiliateFunnelStep[]>(() => {
    if (!selectedAffiliateFunnel) return [];
    const raw = selectedAffiliateFunnel.steps;
    if (Array.isArray(raw)) return raw as unknown as AffiliateFunnelStep[];
    return [];
  }, [selectedAffiliateFunnel]);

  const fetchAffiliateData = useCallback(async () => {
    setAffiliateFunnelsLoading(true);
    setAffiliateFunnelsError(null);
    try {
      const data = await fetchAffiliateSavedFunnels();
      setAffiliateFunnels(data);
    } catch (err) {
      setAffiliateFunnelsError(err instanceof Error ? err.message : 'Error loading quiz funnel');
    } finally {
      setAffiliateFunnelsLoading(false);
    }
  }, []);

  // Load saved funnels on page load
  useEffect(() => {
    fetchAffiliateData();
  }, [fetchAffiliateData]);

  // Load saved prompts
  const loadSavedPrompts = useCallback(async () => {
    try {
      const res = await fetch('/api/prompts');
      const data = await res.json();
      if (data.prompts) setSavedPrompts(data.prompts);
    } catch (err) {
      console.error('Error loading saved prompts:', err);
    } finally {
      setSavedPromptsLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadSavedPrompts();
  }, [loadSavedPrompts]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[id$="-prompt-dropdown"]') && !target.closest('[id^="row-prompt-"]')) {
        document.querySelectorAll('[id$="-prompt-dropdown"], [id^="row-prompt-"]').forEach(el => {
          el.classList.add('hidden');
        });
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  // Ref all'iframe del preview così possiamo postare comandi (es. rerun fallback)
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);
  // Iframe gia' inizializzato (doc.write fatto). Senza questo guard il ref
  // callback inline si richiama ad ogni render del parent (es. quando arriva
  // __funnelPreviewDiag → setPreviewDiag → re-render → React invoca di nuovo
  // ref(elem) sullo stesso DOM node → doc.write riparte → script reinietta
  // → diag → loop infinito = freeze browser + 100 violation document.write).
  const previewInitedRef = useRef<HTMLIFrameElement | null>(null);

  // Diagnostica live ricevuta dal preview iframe (vedi fallbackInit script).
  // Tracciata in stato così possiamo mostrarla all'utente nel header del modal,
  // utile per debuggare in produzione senza chiedere di aprire DevTools.
  const [previewDiag, setPreviewDiag] = useState<{
    label: string;
    scripts: number;
    faqHeaders: number;
    swipers: number;
    slides: number;
    thumbs: number;
    version: string;
    ts: number;
  } | null>(null);

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data;
      if (d && typeof d === 'object' && d.__funnelPreviewDiag) {
        // eslint-disable-next-line no-console
        console.log(
          `[funnel-preview-diag] ${d.label}: scripts=${d.scripts}, faqHeaders=${d.faqHeaders}, swipers=${d.swipers}, slides=${d.slides ?? '?'}, thumbs=${d.thumbs ?? '?'}`
        );
        setPreviewDiag({
          label: String(d.label || ''),
          scripts: Number(d.scripts || 0),
          faqHeaders: Number(d.faqHeaders || 0),
          swipers: Number(d.swipers || 0),
          slides: Number(d.slides || 0),
          thumbs: Number(d.thumbs || 0),
          version: String(d.version || 'old'),
          ts: Date.now(),
        });
      }
      if (d && typeof d === 'object' && d.__funnelPreviewClick) {
        // eslint-disable-next-line no-console
        console.log(
          `[funnel-preview-click] ${d.target}: ${d.target === 'faq' ? `"${d.headerText}" contents=${d.contents} open=${d.newOpen}` : `idx=${d.idx}/${d.siblings}`}`
        );
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Reset diag quando il modal si chiude
  useEffect(() => {
    if (!htmlPreviewModal.isOpen) setPreviewDiag(null);
  }, [htmlPreviewModal.isOpen]);

  const handleSelectSavedPrompt = useCallback((prompt: SavedPrompt, target: 'swipe' | 'clone') => {
    if (target === 'swipe') {
      setSwipeConfig(prev => ({ ...prev, prompt: prompt.content }));
    } else {
      setCloneConfig(prev => ({ ...prev, customPrompt: prompt.content }));
    }
    fetch('/api/prompts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: prompt.id, action: 'increment_use' }),
    }).catch(() => {});
  }, []);

  // Auto-import funnel from My Funnels page via ?import_funnel_id=...
  const importDoneRef = useRef(false);
  useEffect(() => {
    const importId = searchParams.get('import_funnel_id');
    if (!importId || importDoneRef.current || affiliateFunnelsLoading || affiliateFunnels.length === 0) return;

    const funnel = affiliateFunnels.find((f) => f.id === importId);
    if (!funnel) return;

    importDoneRef.current = true;

    const steps = Array.isArray(funnel.steps)
      ? (funnel.steps as unknown as AffiliateFunnelStep[])
      : [];

    if (steps.length === 0) return;

    const funnelName = funnel.funnel_name;
    for (const step of steps) {
      const stepType = step.step_type || 'landing';
      const pageType: PageType = STEP_TYPE_TO_PAGE_TYPE[stepType] || 'landing';

      addFunnelPage({
        name: step.title
          ? `${funnelName} - Step ${step.step_index}: ${step.title}`.slice(0, 80)
          : `${funnelName} - Step ${step.step_index}`,
        pageType,
        productId: '',
        urlToSwipe: step.url || '',
        prompt: step.description || '',
        swipeStatus: 'pending',
        feedback: '',
      });
    }

    setSelectedAffiliateFunnelId(importId);

    // Clean URL without reload
    const url = new URL(window.location.href);
    url.searchParams.delete('import_funnel_id');
    window.history.replaceState({}, '', url.toString());
  }, [searchParams, affiliateFunnels, affiliateFunnelsLoading, addFunnelPage]);

  // Bulk Project selection for all rows. Field name kept for backward
  // compatibility with `funnelPages.productId` (it now stores a project id).
  const handleBulkProductChange = useCallback((productId: string) => {
    if (!productId) return;
    for (const page of funnelPages) {
      updateFunnelPage(page.id, { productId });
    }
  }, [funnelPages, updateFunnelPage]);

  // Build a labelled context block from a Project so the rewriter (Claude)
  // can treat the brief as the source of truth, separate from description /
  // domain / etc.
  type ProjectLike = {
    name?: string;
    description?: string;
    brief?: string;
    domain?: string;
  };
  const buildProjectContext = (project: ProjectLike | undefined): string => {
    if (!project) return '';
    const parts: string[] = [];
    if (project.name) parts.push(`PROJECT: ${project.name}`);
    if (project.domain) parts.push(`DOMAIN: ${project.domain}`);
    if (project.description?.trim()) {
      parts.push(`DESCRIPTION:\n${project.description.trim()}`);
    }
    if (project.brief?.trim()) {
      parts.push(`BRIEF (use this as the primary source of truth for tone, positioning and value props):\n${project.brief.trim()}`);
    }
    return parts.join('\n\n');
  };

  const handleUseAffiliateStepForSwipe = (step: AffiliateFunnelStep, funnelName: string) => {
    const stepType = step.step_type || 'landing';
    const pageType: PageType = STEP_TYPE_TO_PAGE_TYPE[stepType] || 'landing';

    addFunnelPage({
      name: step.title
        ? `${funnelName} - Step ${step.step_index}: ${step.title}`.slice(0, 80)
        : `${funnelName} - Step ${step.step_index}`,
      pageType,
      productId: projects[0]?.id || '',
      urlToSwipe: step.url || '',
      prompt: step.description || '',
      swipeStatus: 'pending',
      feedback: '',
    });
  };

  const handleImportAllAffiliateSteps = () => {
    if (!selectedAffiliateFunnel || affiliateFunnelSteps.length === 0) return;
    const funnelName = selectedAffiliateFunnel.funnel_name;
    for (const step of affiliateFunnelSteps) {
      handleUseAffiliateStepForSwipe(step, funnelName);
    }
  };

  const handleGenerateQuiz = async () => {
    if (!selectedAffiliateFunnel) return;
    setQuizGenerating(true);
    setQuizError(null);
    setQuizGenerationPhase('Capturing branding from original site...');

    try {
      const response = await fetch('/api/generate-quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funnelId: selectedAffiliateFunnel.id }),
      });

      setQuizGenerationPhase('Generating quiz with Claude AI...');

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Error generating quiz');
      }

      setQuizPreviewHtml(data.html);
      setQuizPreviewStats(data.stats);
      setQuizPreviewOpen(true);
      setQuizGenerationPhase('');
    } catch (err) {
      setQuizError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setQuizGenerating(false);
    }
  };

  const handleDownloadQuizHtml = () => {
    if (!quizPreviewHtml || !quizPreviewStats) return;
    const blob = new Blob([quizPreviewHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${quizPreviewStats.funnelName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-quiz.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // funnelPages letti via ref dentro pollJobStatus, così la callback non si
  // ricrea ad ogni cambio dello store (vedi sopra per il razionale).
  const funnelPagesRef = useRef(funnelPages);
  funnelPagesRef.current = funnelPages;

  // Poll job status
  const pollJobStatus = useCallback(async (jobId: string, pageId: string) => {
    try {
      const response = await fetch(api.status(jobId));
      const status: JobStatus = await response.json();

      setActiveJobs(prev => prev.map(job => 
        job.jobId === jobId 
          ? { 
              ...job, 
              status: status.status, 
              progress: status.progress || 0,
              currentLayer: status.current_layer,
              lastUpdate: new Date(),
              visionJobId: status.vision_job_id || job.visionJobId,
            }
          : job
      ));

      const layerInfo = status.current_layer ? ` [${status.current_layer}]` : '';
      updateFunnelPage(pageId, {
        swipeResult: `${status.progress || 0}%${layerInfo}`,
      });

      if (status.status === 'completed') {
        updateFunnelPage(pageId, {
          swipeStatus: 'completed',
          swipeResult: `✓ Completed!`,
        });
        
        setLoadingIds(prev => prev.filter(i => i !== pageId));
        
        setTimeout(() => {
          setActiveJobs(prev => prev.filter(job => job.jobId !== jobId));
        }, 5000);

        const page = (funnelPagesRef.current || []).find(p => p.id === pageId);
        setHtmlPreviewModal({
          isOpen: true,
          title: page?.name || 'Swipe Result',
          html: '',
          mobileHtml: '',
          iframeSrc: api.result(jobId),
          metadata: null,
        });

        return true;
      } else if (status.status === 'failed') {
        updateFunnelPage(pageId, {
          swipeStatus: 'failed',
          swipeResult: status.error || 'Job failed',
        });
        setLoadingIds(prev => prev.filter(i => i !== pageId));
        setActiveJobs(prev => prev.filter(job => job.jobId !== jobId));
        return true;
      }

      return false;
    } catch (error) {
      console.error('Error polling job status:', error);
      setActiveJobs(prev => prev.map(job => 
        job.jobId === jobId 
          ? { ...job, lastUpdate: new Date() }
          : job
      ));
      return false;
    }
  }, [api, updateFunnelPage]);

  // Polling effect — registrato UNA volta. Si ferma solo quando non ci sono
  // più job attivi. Non si ricrea per ogni cambio di funnelPages/activeJobs:
  // legge la lista via ref, così niente clear+set dell'interval ad ogni
  // updateFunnelPage. Inoltre `pollingInFlightRef` skippa i tick se la
  // passata precedente non è ancora finita (rete lenta + tanti job).
  useEffect(() => {
    const hasActive = activeJobs.length > 0;

    if (!hasActive) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    if (pollingRef.current) return; // già attivo, non re-installare

    pollingRef.current = setInterval(async () => {
      if (pollingInFlightRef.current) return; // tick precedente ancora in corso
      pollingInFlightRef.current = true;
      try {
        const jobs = activeJobsRef.current;
        for (const job of jobs) {
          if (job.status === 'pending' || job.status === 'running') {
            await pollJobStatus(job.jobId, job.pageId);
          }
        }
      } finally {
        pollingInFlightRef.current = false;
      }
    }, 5000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
    // pollJobStatus ora è stabile (non dipende più da funnelPages),
    // quindi questo effect si esegue solo quando si passa da 0 → >0 job.
  }, [activeJobs.length === 0, pollJobStatus]);

  const handleAddPage = () => {
    const stepNum = (funnelPages || []).length + 1;
    addFunnelPage({
      name: `Step ${stepNum}`,
      pageType: 'landing',
      productId: projects[0]?.id || '',
      urlToSwipe: '',
      prompt: '',
      swipeStatus: 'pending',
      feedback: '',
    });
  };

  const handleDownloadTemplate = async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();

    const typeLabels = allPageTypeOptions.map(o => o.label);
    const templateNames = (templates || []).map(t => t.name);
    // Now sourced from My Projects rather than the legacy Products catalog.
    const productNames = (projects || []).map(p => p.name);

    // Main sheet
    const ws = wb.addWorksheet('Funnel Steps');
    const headerRow = ws.addRow(['Page', 'Type', 'Template', 'URL', 'Prompt', 'Product', 'Feedback']);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      cell.alignment = { horizontal: 'center' };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FF1E40AF' } },
      };
    });

    ws.columns = [
      { key: 'page', width: 30 },
      { key: 'type', width: 22 },
      { key: 'template', width: 22 },
      { key: 'url', width: 42 },
      { key: 'prompt', width: 40 },
      { key: 'product', width: 24 },
      { key: 'feedback', width: 30 },
    ];

    const exRow = ws.addRow([
      'Step 1 - Landing Page',
      typeLabels[0] || 'Landing Page',
      templateNames[0] || '',
      'https://example.com/landing',
      'Swipe this page keeping the same layout',
      productNames[0] || 'My Product',
      '',
    ]);
    exRow.eachCell(cell => {
      cell.font = { color: { argb: 'FF9CA3AF' }, italic: true };
    });

    // Add 50 empty rows with dropdowns
    const maxRows = 52;
    for (let r = 3; r <= maxRows; r++) {
      ws.addRow([]);
    }

    // Type dropdown (col B) 
    if (typeLabels.length > 0) {
      const typeList = `"${typeLabels.join(',')}"`;
      for (let r = 2; r <= maxRows; r++) {
        ws.getCell(`B${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [typeList],
          showErrorMessage: true,
          errorTitle: 'Invalid Type',
          error: 'Please select a valid page type from the dropdown.',
        };
      }
    }

    // Template dropdown (col C)
    if (templateNames.length > 0) {
      const tmplList = `"${templateNames.map(n => n.replace(/"/g, '""')).join(',')}"`;
      for (let r = 2; r <= maxRows; r++) {
        ws.getCell(`C${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [tmplList],
          showErrorMessage: true,
          errorTitle: 'Invalid Template',
          error: 'Please select a valid template from the dropdown.',
        };
      }
    }

    // Product dropdown (col F)
    if (productNames.length > 0) {
      const prodList = `"${productNames.map(n => n.replace(/"/g, '""')).join(',')}"`;
      for (let r = 2; r <= maxRows; r++) {
        ws.getCell(`F${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [prodList],
          showErrorMessage: true,
          errorTitle: 'Invalid Product',
          error: 'Please select a valid product from the dropdown.',
        };
      }
    }

    // Reference sheet with all valid values
    const ref = wb.addWorksheet('Valid Values');
    ref.addRow(['Page Types', 'Templates', 'Products']);
    ref.getRow(1).eachCell(cell => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    });
    const maxRef = Math.max(typeLabels.length, templateNames.length, productNames.length);
    for (let i = 0; i < maxRef; i++) {
      ref.addRow([typeLabels[i] || '', templateNames[i] || '', productNames[i] || '']);
    }
    ref.columns = [{ width: 28 }, { width: 28 }, { width: 28 }];

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'funnel_steps_template.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportSpreadsheet = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) { alert('Empty spreadsheet'); return; }

      const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (rows.length === 0) { alert('No rows found'); return; }

      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
      const colMap: Record<string, string> = {};
      const firstRowKeys = Object.keys(rows[0]);
      for (const key of firstRowKeys) {
        const n = normalize(key);
        if (n.includes('page') || n.includes('name') || n.includes('step')) colMap[key] = 'page';
        else if (n.includes('type')) colMap[key] = 'type';
        else if (n.includes('url') || n.includes('link')) colMap[key] = 'url';
        else if (n.includes('prompt') || n.includes('instruction')) colMap[key] = 'prompt';
        else if (n.includes('product')) colMap[key] = 'product';
        else if (n.includes('feedback') || n.includes('note')) colMap[key] = 'feedback';
        else if (n.includes('template')) colMap[key] = 'template';
      }

      const getVal = (row: Record<string, string>, field: string) => {
        const key = Object.keys(colMap).find(k => colMap[k] === field);
        return key ? (row[key] || '').toString().trim() : '';
      };

      const validTypeValues = allPageTypeOptions.map(o => o.value);
      const resolvePageType = (raw: string): PageType => {
        if (!raw) return 'landing';
        const lower = raw.toLowerCase().trim();
        if (validTypeValues.includes(lower as PageType)) return lower as PageType;
        const match = allPageTypeOptions.find(o => o.label.toLowerCase() === lower);
        if (match) return match.value;
        const partial = allPageTypeOptions.find(o => o.label.toLowerCase().includes(lower) || lower.includes(o.value));
        if (partial) return partial.value;
        return 'landing';
      };

      // Resolve a Project by name. The CSV column is still labelled "product"
      // for backward compatibility, but it now refers to a project from
      // "My Projects" (whose `brief` is what the rewrite agent receives).
      const resolveProduct = (raw: string): string => {
        if (!raw) return projects[0]?.id || '';
        const lower = raw.toLowerCase().trim();
        const exact = projects.find(p => p.name.toLowerCase() === lower);
        if (exact) return exact.id;
        const partial = projects.find(p => p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase()));
        if (partial) return partial.id;
        return projects[0]?.id || '';
      };

      const resolveTemplate = (raw: string): string | undefined => {
        if (!raw) return undefined;
        const lower = raw.toLowerCase().trim();
        const t = templates.find(t => t.name.toLowerCase() === lower || t.name.toLowerCase().includes(lower));
        return t?.id;
      };

      let imported = 0;
      const baseStep = (funnelPages || []).length;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const pageName = getVal(row, 'page') || `Step ${baseStep + i + 1}`;
        const pageType = resolvePageType(getVal(row, 'type'));
        const url = getVal(row, 'url');
        const prompt = getVal(row, 'prompt');
        const productId = resolveProduct(getVal(row, 'product'));
        const feedback = getVal(row, 'feedback');
        const templateId = resolveTemplate(getVal(row, 'template'));

        await addFunnelPage({
          name: pageName,
          pageType,
          productId,
          urlToSwipe: url,
          prompt: prompt || undefined,
          swipeStatus: 'pending',
          feedback: feedback || undefined,
          templateId,
        });
        imported++;
      }

      alert(`Imported ${imported} steps successfully!`);
    } catch (err) {
      console.error('Import error:', err);
      alert('Error importing file. Make sure it is a valid .xlsx or .csv file.');
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Open swipe config modal. Source of truth is now My Projects: name +
  // brief + description are pulled from the selected Project. The brief is
  // labelled explicitly so Claude treats it as authoritative.
  const openSwipeConfig = (page: typeof funnelPages[0]) => {
    const project = (projects || []).find(p => p.id === page.productId);
    setSwipeConfig({
      url: page.urlToSwipe,
      product_name: project?.name || '',
      product_description: buildProjectContext(project),
      cta_text: 'BUY NOW',
      cta_url: project?.domain || '',
      language: 'en',
      benefits: [],
      brand_name: project?.name || '',
      prompt: page.prompt || '',
    });

    setSwipeConfigModal({
      isOpen: true,
      pageId: page.id,
      pageName: page.name,
      url: page.urlToSwipe,
    });
  };

  // Vision Analysis Functions
  const fetchVisionJobs = async (sourceUrl: string) => {
    setVisionLoading(true);
    setVisionError(null);
    setVisionJobs([]);
    setSelectedVisionJob(null);

    try {
      const projectId = encodeURIComponent(sourceUrl);
      const response = await fetch(`/api/vision/jobs?project_id=${projectId}&limit=20`);
      const data = await response.json();

      if (!data.success) {
        setVisionError(data.error || 'Error fetching analyses');
        return;
      }

      setVisionJobs(data.jobs || []);
      
      const completedJobs = (data.jobs || []).filter((j: VisionJobSummary) => j.status === 'completed');
      if (completedJobs.length > 0) {
        fetchVisionJobDetail(completedJobs[0].id);
      }
    } catch (error) {
      console.error('Error fetching vision jobs:', error);
      setVisionError(error instanceof Error ? error.message : 'Network error');
    } finally {
      setVisionLoading(false);
    }
  };

  const fetchVisionJobDetail = async (jobId: string) => {
    setVisionLoading(true);
    setVisionError(null);

    try {
      const response = await fetch(`/api/vision/jobs/${jobId}`);
      const data = await response.json();

      if (!data.success) {
        setVisionError(data.error || 'Error fetching details');
        return;
      }

      setSelectedVisionJob(data.job);
      setExpandedSections([]);
    } catch (error) {
      console.error('Error fetching vision job detail:', error);
      setVisionError(error instanceof Error ? error.message : 'Network error');
    } finally {
      setVisionLoading(false);
    }
  };

  const openVisionModal = (page: typeof funnelPages[0]) => {
    setVisionModal({
      isOpen: true,
      pageId: page.id,
      pageName: page.name,
      sourceUrl: page.urlToSwipe,
    });
    
    if (page.urlToSwipe) {
      fetchVisionJobs(page.urlToSwipe);
    }
  };

  const QUIZ_URL_PATTERNS = [
    'heyflow', 'typeform', 'involve.me', 'outgrow', 'interact',
    'quizzes', 'quiz', 'tryinteract', 'leadquizzes', 'bucket.io',
  ];

  const isQuizUrl = (rawUrl: string | undefined | null): boolean => {
    if (!rawUrl) return false;
    const urlLower = rawUrl.toLowerCase();
    return QUIZ_URL_PATTERNS.some(p => urlLower.includes(p));
  };

  const isQuizPage = (page: { pageType: string; urlToSwipe?: string; url?: string }) => {
    if (page.pageType === 'quiz_funnel') return true;
    return isQuizUrl(page.urlToSwipe) || isQuizUrl(page.url);
  };

  // Clone via smooth-responder Edge Function. Project (from My Projects)
  // provides name + description + brief + domain; we wrap them into a single
  // labelled context block so Claude sees the brief as the source of truth.
  // brief and marketResearch are also forwarded as separate fields to the
  // rewrite proxy so the Edge Function can frame them explicitly.
  const openCloneModal = (page: typeof funnelPages[0]) => {
    const project = (projects || []).find(p => p.id === page.productId);

    // marketResearch is a multi-file blob now: { files, notes, content }.
    // We hand Claude the pre-built `content` string so the prompt is
    // human-readable and we don't ship raw file metadata into the LLM.
    const researchText = extractSectionContent(project?.marketResearch);

    setCloneConfig({
      productName: project?.name || '',
      productDescription: buildProjectContext(project),
      framework: '',
      target: '',
      customPrompt: page.prompt || '',
      language: 'it',
      targetLanguage: 'Italiano',
      useOpenClaw: false,
      brief: project?.brief?.trim() || '',
      marketResearch: researchText.trim(),
    });
    setCloneMode('identical');
    setCloneProgress(null);
    setCloneModal({
      isOpen: true,
      pageId: page.id,
      pageName: page.name,
      url: page.urlToSwipe,
    });
  };

  /* ───────────── Swipe All — OpenClaw worker path ─────────────
   * Quando l'utente sceglie Neo / Morfeo nel selettore globale,
   * salta l'orchestratore Edge Function (Anthropic) e per ogni pagina
   * eligibile enqueue un job `swipe_landing_local` sul worker scelto.
   *
   * Vantaggi:
   *   • niente Netlify timeout (il worker fa fetch + LLM in locale)
   *   • niente quota Anthropic
   *   • aggiorna gli stessi swipeAllJob/swipeLog/funnelPage state della
   *     versione Claude, quindi il pannello attivita` esistente funziona
   *     uguale.
   *
   * Nota: la "narrative coherence" tra pagine (passare il summary delle
   * gia` scritte alle successive) NON e` portata su questo path — il
   * worker rewrite ogni pagina in isolamento. Le scritture Anthropic con
   * narrative restano disponibili scegliendo "Claude". */
  const runSwipeAllViaOpenclaw = useCallback(async (chosen: Auditor) => {
    const targetAgent = AUDITOR_TARGET_AGENT[chosen];
    if (!targetAgent) return;
    const allPages = funnelPages || [];
    const eligible = allPages.filter((p) => p.urlToSwipe && p.productId);
    if (!eligible.length) {
      alert('Nessuna pagina eligibile (servono URL competitor + Project su ogni riga).');
      return;
    }
    const ok = window.confirm(
      `Avvio Swipe All via ${AUDITOR_LABEL[chosen]} su ${eligible.length} pagine.\n\n` +
        'Il worker locale fara fetch + rewrite per ogni pagina (no Netlify ' +
        'timeout, no quota Anthropic). La coerenza narrativa tra pagine ' +
        'NON e mantenuta su questo path (per quella, usa Claude).\n\nProcedere?'
    );
    if (!ok) return;

    swipeAllCancelRef.current = false;
    resetSwipeLog();
    setSwipeAllJob({
      isRunning: true,
      cancelRequested: false,
      currentIndex: 0,
      totalCount: eligible.length,
      currentStep: 'idle',
      currentPageName: '',
      batchInfo: '',
      completed: 0,
      errors: [],
      startedAt: Date.now(),
    });
    pushSwipeLog('info', `Swipe All start \u2014 ${eligible.length} pages via ${AUDITOR_LABEL[chosen]}`);

    // Cap per pagina: 10min (worker LLM rewrite + 2 pass gap-fill su
    // funnel grossi puo` richiedere ~5min, +headroom).
    // No-pickup watchdog: se entro 30s nessun worker prende la PRIMA
    // pagina, fallisci tutto subito invece di aspettare 10min × N
    // pagine per niente.
    // 30 min per pagina: Trinity locale processa ~25K char di system prompt
    // (KB built-in + knowledge tool) per ogni batch — su landing grosse
    // (100+ testi) puo' richiedere 15-25 min. Meglio aspettare che dare
    // timeout finto e perdere il risultato che e' gia' in Supabase.
    const PAGE_TIMEOUT_MS = 30 * 60 * 1000;
    const NO_PICKUP_TIMEOUT_MS = 30 * 1000;
    const POLL_INTERVAL_MS = 2500;

    // ── Carica una sola volta la knowledge globale (libreria saved_prompts).
    // Per ogni pagina invece carichiamo il brief specifico del progetto.
    let globalPrompts: unknown[] = [];
    try {
      const kRes = await fetch('/api/swipe/load-knowledge');
      if (kRes.ok) {
        const kj = await kRes.json();
        if (Array.isArray(kj.prompts)) globalPrompts = kj.prompts;
      }
      pushSwipeLog('info', `Knowledge: ${globalPrompts.length} tecniche caricate dalla libreria`);
    } catch {
      pushSwipeLog('info', 'Knowledge libreria non disponibile, vado avanti');
    }

    for (let i = 0; i < eligible.length; i++) {
      if (swipeAllCancelRef.current) break;
      const page = eligible[i];
      const project = (projects || []).find((p) => p.id === page.productId);
      const url = page.urlToSwipe || '';
      const pageName = page.name || `Step ${i + 1}`;

      setSwipeAllJob((s) =>
        s ? { ...s, currentIndex: i + 1, currentPageName: pageName, currentStep: 'cloning', batchInfo: `coda ${AUDITOR_LABEL[chosen]}…` } : s
      );
      pushSwipeLog('info', `\u25b6 Page ${i + 1}/${eligible.length} \u2014 enqueue worker job`, pageName);
      updateFunnelPage(page.id, {
        swipeStatus: 'in_progress',
        swipeResult: `Swipe All ${i + 1}/${eligible.length} — Coda OpenClaw…`,
      });

      if (!project) {
        const msg = `Project non trovato per la pagina (productId=${page.productId})`;
        updateFunnelPage(page.id, { swipeStatus: 'failed', swipeResult: msg });
        setSwipeAllJob((s) =>
          s ? { ...s, errors: [...s.errors, { pageId: page.id, pageName, message: msg }] } : s
        );
        pushSwipeLog('error', `\u2717 ${msg}`, pageName);
        continue;
      }

      try {
        // Build a product info shape that matches what
        // /api/landing/swipe/openclaw-build-prompts expects (only
        // `name` is required; everything else is best-effort context).
        const productPayload = {
          name: project.name,
          description: project.description || '',
          brand_name: undefined,
          target_audience: undefined,
          marketing_brief: (project.brief || '').trim() || undefined,
          market_research: extractSectionContent(project.marketResearch) || undefined,
          project_brief: (project.brief || '').trim() || undefined,
        };

        // Knowledge per QUESTA pagina: libreria globale + brief del
        // project specifico. Cosi' Neo/Morfeo ricevono sia le tecniche
        // dell'utente sia il context-specific del prodotto.
        const pageKnowledge = {
          prompts: globalPrompts,
          project: {
            name: project.name,
            brief: (project.brief || '').trim() || null,
            market_research: extractSectionContent(project.marketResearch) || null,
            notes: null,
          },
        };

        const enqueueRes = await fetch('/api/openclaw/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            section: 'swipe_job',
            message: JSON.stringify({
              action: 'swipe_landing_local',
              sourceUrl: url,
              product: productPayload,
              tone: 'professional',
              language: 'it',
              knowledge: pageKnowledge,
            }),
            targetAgent,
          }),
        });
        const enqueued = (await enqueueRes.json()) as { id?: string; error?: string };
        if (!enqueueRes.ok || !enqueued.id) {
          throw new Error(enqueued.error || `Enqueue HTTP ${enqueueRes.status}`);
        }
        pushSwipeLog('success', `\u2713 Job #${enqueued.id.slice(0, 8)} enqueued`, pageName);

        const t0 = Date.now();
        let lastStatus: string | null = null;
        let final: { html?: string; replacements?: number; totalTexts?: number; new_title?: string; success?: boolean; error?: string } | null = null;
        while (true) {
          if (swipeAllCancelRef.current) break;
          if (Date.now() - t0 > PAGE_TIMEOUT_MS) {
            throw new Error(`Timeout: il worker ${AUDITOR_LABEL[chosen]} non ha completato in ${PAGE_TIMEOUT_MS / 1000}s`);
          }
          // No-pickup early bail-out (vedi commento su NO_PICKUP_TIMEOUT_MS).
          if (
            Date.now() - t0 > NO_PICKUP_TIMEOUT_MS &&
            (lastStatus === 'pending' || lastStatus === null)
          ) {
            throw new Error(
              `${AUDITOR_LABEL[chosen]} non ha preso il job in ${NO_PICKUP_TIMEOUT_MS / 1000}s. ` +
                `Controlla che il worker giri sul PC di ${chosen === 'neo' ? 'Neo' : 'Morfeo'} (\`node openclaw-worker.js\`) e ` +
                `che sia aggiornato all'ultimo commit. Workaround: cambia auditor.`,
            );
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          const pollRes = await fetch(`/api/openclaw/queue?id=${encodeURIComponent(enqueued.id)}`);
          const polled = (await pollRes.json()) as { status?: string; content?: string; error?: string };
          if (polled.status && polled.status !== lastStatus) {
            lastStatus = polled.status;
            if (polled.status === 'processing') {
              setSwipeAllJob((s) => (s ? { ...s, currentStep: 'rewriting', batchInfo: 'fetch + rewrite locale…' } : s));
              pushSwipeLog('info', `\u2192 Worker ha preso il job (fetch + LLM in locale)`, pageName);
              updateFunnelPage(page.id, {
                swipeStatus: 'in_progress',
                swipeResult: `Swipe All ${i + 1}/${eligible.length} — worker locale…`,
              });
            }
          }
          if (polled.status === 'completed' && polled.content) {
            try {
              final = JSON.parse(polled.content);
            } catch {
              throw new Error('Worker response non e JSON valido');
            }
            break;
          }
          if (polled.status === 'error' || polled.status === 'failed') {
            const raw = polled.error || 'Worker ha fallito';
            let hint = '';
            if (/Unknown swipe_job action.*swipe_landing_local/i.test(raw)) {
              hint = ` — Worker ${AUDITOR_LABEL[chosen]} su commit vecchio: \`git pull\` + restart su quel PC.`;
            } else if (/(ECONNREFUSED|HTTP 404|fetch failed).*(18789|chat\/completions)/i.test(raw)) {
              hint = ` — OpenClaw locale di ${AUDITOR_LABEL[chosen]} non risponde su 127.0.0.1:18789.`;
            } else if (/Local fetch failed|Playwright|net::ERR/i.test(raw)) {
              hint = ` — Playwright sul PC di ${AUDITOR_LABEL[chosen]} non scarica la pagina (\`npx playwright install chromium\`).`;
            }
            throw new Error(`${raw}${hint}`);
          }
        }

        if (swipeAllCancelRef.current) break;
        if (!final || final.success === false || !final.html) {
          throw new Error(final?.error || 'Worker ha completato senza HTML');
        }

        const replacements = final.replacements ?? 0;
        const totalTexts = final.totalTexts ?? 0;
        updateFunnelPage(page.id, {
          swipeStatus: 'completed',
          swipeResult: `Rewrite OK (${replacements}/${totalTexts} sostituzioni via ${AUDITOR_LABEL[chosen]})`,
          clonedData: {
            html: final.html,
            mobileHtml: page.clonedData?.mobileHtml,
            title: final.new_title || page.clonedData?.title || pageName,
            method_used: `openclaw-${chosen}`,
            content_length: final.html.length,
            duration_seconds: Math.round((Date.now() - t0) / 1000),
            cloned_at: new Date(),
          },
        });
        setSwipeAllJob((s) => (s ? { ...s, completed: s.completed + 1 } : s));
        pushSwipeLog('success', `\u2713\u2713 Done: ${replacements}/${totalTexts} sostituzioni`, pageName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Errore sconosciuto';
        updateFunnelPage(page.id, { swipeStatus: 'failed', swipeResult: `Swipe All (${chosen}): ${msg}` });
        setSwipeAllJob((s) =>
          s ? { ...s, errors: [...s.errors, { pageId: page.id, pageName, message: msg }] } : s
        );
        pushSwipeLog('error', `\u2717 ${msg}`, pageName);
      }
    }

    setSwipeAllJob((s) => (s ? { ...s, isRunning: false, currentStep: 'idle', batchInfo: '' } : s));
    pushSwipeLog('info', `\u25fc Swipe All finished (${AUDITOR_LABEL[chosen]})`);
  }, [funnelPages, projects, updateFunnelPage, pushSwipeLog, resetSwipeLog]);

  /* ───────────── Swipe All orchestrator ─────────────
   * Per ogni pagina eligibile del funnel:
   *   1. clona identical (se non già clonata)
   *   2. rewrite via Edge function passando funnel_context accumulato
   *   3. estrae narrative summary dalla pagina riscritta (Claude)
   *   4. lo concatena al funnel_context per le pagine successive
   *
   * Pagine eligibili = hanno urlToSwipe + productId valido. */
  const runSwipeAll = useCallback(async () => {
    // Branch globale: se l'utente ha scelto Neo/Morfeo, delega
    // all'orchestratore worker-driven (no Netlify timeout, no quota
    // Anthropic). Altrimenti procede con la versione Claude esistente.
    if (auditorRef.current !== 'claude') {
      await runSwipeAllViaOpenclaw(auditorRef.current);
      return;
    }
    const allPages = funnelPages || [];
    const eligible = allPages.filter(
      (p) => p.urlToSwipe && p.productId
    );
    if (!eligible.length) {
      alert('Nessuna pagina eligibile (servono URL competitor + Project su ogni riga).');
      return;
    }
    const ok = window.confirm(
      `Avvio Swipe All su ${eligible.length} pagine.\n\n` +
        `Verranno riscritte in sequenza, mantenendo coerenza narrativa ` +
        `tra una pagina e l'altra (Claude vede il riassunto delle pagine ` +
        `già fatte). Tempo stimato: ${Math.max(1, Math.round(eligible.length * 1.2))}-` +
        `${Math.max(2, Math.round(eligible.length * 2.5))} minuti.\n\nProcedere?`
    );
    if (!ok) return;

    swipeAllCancelRef.current = false;
    resetSwipeLog();
    setSwipeAllJob({
      isRunning: true,
      cancelRequested: false,
      currentIndex: 0,
      totalCount: eligible.length,
      currentStep: 'idle',
      currentPageName: '',
      batchInfo: '',
      completed: 0,
      errors: [],
      startedAt: Date.now(),
    });
    pushSwipeLog('info', `Swipe All start \u2014 ${eligible.length} pages in queue`);

    const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';
    const SB_MAX_BATCHES = 400;
    const funnelNarrativeBlocks: string[] = [];

    for (let i = 0; i < eligible.length; i++) {
      if (swipeAllCancelRef.current) break;
      const page = eligible[i];
      const project = (projects || []).find((p) => p.id === page.productId);
      const url = page.urlToSwipe || '';
      const pageName = page.name || `Step ${i + 1}`;

      setSwipeAllJob((s) =>
        s
          ? { ...s, currentIndex: i + 1, currentPageName: pageName, currentStep: 'cloning', batchInfo: '' }
          : s
      );
      pushSwipeLog('info', `\u25b6 Page ${i + 1}/${eligible.length} \u2014 starting clone`, pageName);
      updateFunnelPage(page.id, {
        swipeStatus: 'in_progress',
        swipeResult: `Swipe All ${i + 1}/${eligible.length} — Cloning...`,
      });

      if (!project) {
        const msg = `Project non trovato per la pagina (productId=${page.productId})`;
        updateFunnelPage(page.id, { swipeStatus: 'failed', swipeResult: msg });
        setSwipeAllJob((s) =>
          s ? { ...s, errors: [...s.errors, { pageId: page.id, pageName, message: msg }] } : s
        );
        continue;
      }

      try {
        // === Step 1: clone identical (or reuse existing) ============
        let html = page.clonedData?.html || page.swipedData?.html || '';
        if (!html) {
          const cloneRes = await fetch('/api/clone-funnel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url,
              cloneMode: 'identical',
              viewport: 'desktop',
              keepScripts: true,
            }),
          });
          const cloneData = await cloneRes.json();
          if (!cloneRes.ok || cloneData.error) {
            throw new Error(cloneData.error || 'Clone fallito');
          }
          html = sanitizeClonedHtml(cloneData.content, url, { keepScripts: true });
        }
        if (swipeAllCancelRef.current) break;
        pushSwipeLog('success', `\u2713 Cloned: ${(html.length / 1024).toFixed(1)} KB of HTML`, pageName);

        // === Step 2: rewrite via Edge function ======================
        setSwipeAllJob((s) => (s ? { ...s, currentStep: 'rewriting', batchInfo: 'estrazione testi…' } : s));
        pushSwipeLog('info', '\u2192 Extracting texts to rewrite\u2026', pageName);
        updateFunnelPage(page.id, {
          swipeStatus: 'in_progress',
          swipeResult: `Swipe All ${i + 1}/${eligible.length} — Estrazione testi...`,
        });

        const funnelContextStr = funnelNarrativeBlocks.length
          ? [
              `Funnel position of CURRENT page: step ${i + 1}/${eligible.length} — ${pageName}${
                page.pageType ? ` (${page.pageType})` : ''
              }.`,
              '',
              'Pages already rewritten in this same funnel (keep voice, angle, big promise, pain point and CTA logic CONSISTENT with these — do not contradict, do not restart the argument from scratch):',
              '',
              ...funnelNarrativeBlocks,
            ].join('\n')
          : '';

        const briefStr = (project.brief || '').trim();
        // marketResearch is now a multi-file blob: { files, notes, content }.
        // We feed Claude the pre-built `content` (concatenated file text +
        // notes) so the prompt stays human-readable and we don't ship raw
        // JSON/files metadata into the LLM context.
        const researchStr = extractSectionContent(project.marketResearch);

        // Smart routing payload. The proxy uses these (when present) to:
        //   1. Pick the right copywriting KB Tier 2 for this pageType
        //   2. Select only the brief/research files that match this pageType
        //      (always-include foundational docs + page-type-specific docs)
        // If either is missing, the proxy falls back to brief/market_research.
        const routingPayload = {
          pageType: page.pageType || 'other',
          brief_files: project.briefData?.files ?? [],
          brief_notes: project.briefData?.notes ?? '',
          research_files: project.marketResearchData?.files ?? [],
          research_notes: project.marketResearchData?.notes ?? '',
        };

        const SUPABASE_FN_URL = '/api/funnel-swap-proxy';

        const extractRes = await fetch(SUPABASE_FN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phase: 'extract',
            url,
            cloneMode: 'rewrite',
            productName: project.name,
            productDescription: project.description || '',
            framework: '',
            target: '',
            customPrompt: '',
            targetLanguage: 'it',
            userId: DEFAULT_USER_ID,
            renderedHtml: html,
            brief: briefStr || undefined,
            market_research: researchStr || undefined,
            funnel_context: funnelContextStr || undefined,
            ...routingPayload,
          }),
        });
        const extractData = await extractRes.json();
        if (!extractRes.ok || extractData.error) {
          throw new Error(extractData.error || extractData.details || 'Extract fallito');
        }
        if (!extractData.jobId) throw new Error('Extract: nessun jobId');

        const sbJobId = extractData.jobId as string;
        const sbTotal = (extractData.totalTexts as number) || 0;
        pushSwipeLog('success', `\u2713 ${sbTotal} texts extracted \u2014 sending to Claude`, pageName);
        let sbBatch = 0;
        let sbProcessed = 0;
        let sbFinalHtml = '';
        let sbReplacements = 0;

        while (sbBatch < SB_MAX_BATCHES) {
          if (swipeAllCancelRef.current) break;
          const { res: procRes, raw } = await fetchWithRetry(
            SUPABASE_FN_URL,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                phase: 'process',
                jobId: sbJobId,
                cloneMode: 'rewrite',
                batchNumber: sbBatch,
                userId: DEFAULT_USER_ID,
                brief: briefStr || undefined,
                market_research: researchStr || undefined,
                funnel_context: funnelContextStr || undefined,
                ...routingPayload,
              }),
            },
            { retries: 2, baseDelayMs: 2000, label: `swipeall-proc-${i}-${sbBatch}` },
          );
          let procData: {
            success?: boolean;
            phase?: string;
            jobId?: string;
            content?: string;
            batchProcessed?: number;
            remainingTexts?: number;
            continue?: boolean;
            replacements?: number;
            error?: string;
            rewrites?: Array<{ original?: string; rewritten?: string }>;
          };
          try {
            procData = raw ? JSON.parse(raw) : {};
          } catch {
            throw new Error(`Process batch ${sbBatch} non-JSON (${procRes.status}): ${raw.substring(0, 300)}`);
          }
          if (!procRes.ok || procData.error) {
            throw new Error(procData.error || `Process batch ${sbBatch} HTTP ${procRes.status}`);
          }

          // Push the per-batch (original → rewritten) preview pairs into
          // the live rewrite stream so the cinematic overlay can show the
          // actual copy changes as they happen. Works for both 'process'
          // (intermediate) and 'completed' (final batch) responses.
          pushRewrites(procData.rewrites, pageName);

          if (procData.phase === 'completed' && procData.content) {
            sbFinalHtml = procData.content;
            sbReplacements = procData.replacements || 0;
            break;
          }

          const justRewritten = procData.batchProcessed || 0;
          sbProcessed += justRewritten;
          const batchInfo = `batch ${sbBatch + 1} (${sbProcessed}/${sbTotal})`;
          setSwipeAllJob((s) => (s ? { ...s, batchInfo } : s));
          updateFunnelPage(page.id, {
            swipeStatus: 'in_progress',
            swipeResult: `Swipe All ${i + 1}/${eligible.length} — ${batchInfo}`,
          });
          if (justRewritten > 0) {
            pushSwipeLog(
              'rewrite',
              `\u270d Batch ${sbBatch + 1}: rewrote ${justRewritten} texts (${sbProcessed}/${sbTotal})`,
              pageName,
            );
          }
          if (!procData.continue && !procData.remainingTexts) break;
          sbBatch++;
        }

        if (swipeAllCancelRef.current) break;
        if (!sbFinalHtml) throw new Error('Edge function non ha restituito HTML completato');

        updateFunnelPage(page.id, {
          swipeStatus: 'completed',
          swipeResult: `Rewrite OK (${sbReplacements} sostituzioni)`,
          clonedData: {
            html: sbFinalHtml,
            mobileHtml: page.clonedData?.mobileHtml,
            title: page.clonedData?.title || pageName,
            method_used: 'rewrite',
            content_length: sbFinalHtml.length,
            duration_seconds: 0,
            cloned_at: new Date(),
          },
        });
        pushSwipeLog('success', `\u2713 Rewrite complete: ${sbReplacements} replacements applied`, pageName);

        // === Step 3: extract narrative for next pages ===============
        setSwipeAllJob((s) =>
          s ? { ...s, currentStep: 'narrative', batchInfo: 'analisi narrative…' } : s
        );
        pushSwipeLog('info', '\u2192 Extracting narrative for funnel coherence\u2026', pageName);
        try {
          const narrativeRes = await fetch('/api/swipe-all/extract-narrative', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              html: sbFinalHtml,
              pageName,
              pageType: page.pageType || '',
              stepIndex: i + 1,
              totalSteps: eligible.length,
            }),
          });
          const narrativeData = await narrativeRes.json();
          if (narrativeData.ok && typeof narrativeData.blockText === 'string') {
            funnelNarrativeBlocks.push(narrativeData.blockText);
          }
        } catch {
          /* narrative extraction is best-effort: a failure here does not
             block the rest of the swipe-all run, the next pages just won't
             get this page's summary in their context. */
        }

        setSwipeAllJob((s) => (s ? { ...s, completed: s.completed + 1 } : s));
        pushSwipeLog('success', `\u2713\u2713 Page done`, pageName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Errore sconosciuto';
        updateFunnelPage(page.id, { swipeStatus: 'failed', swipeResult: `Swipe All: ${msg}` });
        setSwipeAllJob((s) =>
          s ? { ...s, errors: [...s.errors, { pageId: page.id, pageName, message: msg }] } : s
        );
        pushSwipeLog('error', `\u2717 ${msg}`, pageName);
      }
    }

    setSwipeAllJob((s) =>
      s ? { ...s, isRunning: false, currentStep: 'idle', batchInfo: '' } : s
    );
    pushSwipeLog('info', '\u25fc Swipe All finished');
  }, [funnelPages, projects, updateFunnelPage, pushSwipeLog, pushRewrites, resetSwipeLog, runSwipeAllViaOpenclaw]);

  const cancelSwipeAll = useCallback(() => {
    swipeAllCancelRef.current = true;
    setSwipeAllJob((s) => (s ? { ...s, cancelRequested: true } : s));
  }, []);

  const handleClone = async () => {
    const pageId = cloneModal.pageId;
    const url = cloneModal.url;
    const pageName = cloneModal.pageName;
    const mode = cloneMode;

    setCloneModal({ isOpen: false, pageId: '', pageName: '', url: '' });
    setCloningIds(prev => [...prev, pageId]);
    // Reset the live activity log + rewrite stream so the cinematic
    // overlay starts from a clean slate for this clone (otherwise it
    // would still show entries from the previous Swipe All / Rewrite).
    resetSwipeLog();

    const currentPage = (funnelPages || []).find(p => p.id === pageId);
    // Riconoscimento quiz: privilegia l'URL del modal (che è quello effettivo
    // in fase di clone). currentPage.urlToSwipe potrebbe non essere popolato
    // per pagine importate da altre fonti, e senza il flag quiz `keepScripts`
    // resta false → sanitize strippa __NEXT_DATA__/altri script SPA → l'Edge
    // Function riceve solo lo scheletro HTML e estrae 0 testi.
    const pageIsQuiz = isQuizUrl(url) || !!(currentPage && isQuizPage(currentPage));
    // Per le landing page non-quiz dobbiamo COMUNQUE preservare gli <script>
    // di runtime (Swiper init, accordion FAQ, sticky bar, image gallery, ...).
    // Senza di essi gli accordion non si aprono e le gallerie non sono cliccabili.
    // Gli script appartengono al competitor, sono già pubblici, non c'è XSS reale.
    const preserveScripts = true;

    updateFunnelPage(pageId, {
      swipeStatus: 'in_progress',
      swipeResult: mode === 'identical' ? 'Cloning...' : mode === 'translate' ? 'Translating...' : 'Rewriting...',
    });

    try {
      if (mode === 'identical') {
        // Identical clone - fetched directly by Next.js API with CSS inlining
        const response = await fetch('/api/clone-funnel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, cloneMode: 'identical', viewport: cloneMobile ? 'both' : 'desktop', keepScripts: preserveScripts }),
        });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || 'Clone failed');

        if (data.warning) {
          console.warn('⚠️ Clone warning:', data.warning);
        }

        const clonedHtml = sanitizeClonedHtml(data.content, url, { keepScripts: preserveScripts });
        const clonedMobileHtml = data.mobileContent ? sanitizeClonedHtml(data.mobileContent, url, { keepScripts: preserveScripts }) : '';
        const mobileInfo = clonedMobileHtml ? ` + mobile ${(data.mobileFinalSize || 0).toLocaleString()}` : '';
        const statusMsg = data.jsRendered
          ? `⚠️ JS-rendered page (${(data.finalSize || 0).toLocaleString()} chars) - content might be incomplete`
          : `Clone OK (${(data.finalSize || data.content?.length || 0).toLocaleString()} chars${data.cssInlined ? ', CSS inlined' : ''}${mobileInfo})`;

        updateFunnelPage(pageId, {
          swipeStatus: 'completed',
          swipeResult: statusMsg,
          clonedData: {
            html: clonedHtml,
            mobileHtml: clonedMobileHtml || undefined,
            title: pageName,
            method_used: 'identical',
            content_length: data.finalSize || data.content?.length || 0,
            duration_seconds: 0,
            cloned_at: new Date(),
          },
        });

        try { autoSaveSections(clonedHtml, url, pageName); } catch {}

        setPreviewViewport('desktop');
        setHtmlPreviewModal({
          isOpen: true,
          title: data.jsRendered ? `⚠️ Clone (JS-rendered): ${pageName}` : `Clone: ${pageName}`,
          html: clonedHtml,
          mobileHtml: clonedMobileHtml,
          iframeSrc: '',
          metadata: { method: 'identical', length: data.finalSize || data.content?.length || 0, duration: 0 },
          pageId,
          sourceType: 'cloned',
        });

      } else if (mode === 'rewrite') {
        // All rewrites go through /api/quiz-rewrite (Anthropic Claude)
        let htmlToRewrite = currentPage?.clonedData?.html || currentPage?.swipedData?.html || '';
        const chosenAuditorEarly = auditorRef.current;

        // No size threshold — if there's no cached HTML at all we clone first;
        // anything else (even small SPA shells) is forwarded to Claude.
        // Skip the Netlify clone-funnel pre-step when auditor != claude:
        // the worker's swipe_landing_local already does the fetch locally
        // via Playwright (no Netlify limits), so making Netlify do it
        // first just buys us "Internal Error. ID: ..." on big SPAs.
        if (!htmlToRewrite && chosenAuditorEarly === 'claude') {
          console.log('[rewrite] No HTML cached — cloning page first...');
          setCloneProgress({
            phase: 'extract',
            totalTexts: 0,
            processedTexts: 0,
            message: 'Clono prima la pagina...',
          });
          const cloneRes = await fetch('/api/clone-funnel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, cloneMode: 'identical', viewport: 'desktop', keepScripts: preserveScripts }),
          });
          const cloneData = await cloneRes.json();
          if (!cloneRes.ok || cloneData.error) {
            throw new Error(cloneData.error || 'Clone failed — cannot rewrite without HTML');
          }
          htmlToRewrite = sanitizeClonedHtml(cloneData.content, url, { keepScripts: preserveScripts });

          updateFunnelPage(pageId, {
            clonedData: {
              html: htmlToRewrite,
              title: cloneData.title || pageName,
              clonedAt: new Date(),
              method: 'identical',
            },
          });
        }

        const chosenAuditor = auditorRef.current;
        const targetAgentForRewrite = AUDITOR_TARGET_AGENT[chosenAuditor] || undefined;

        setCloneProgress({
          phase: 'processing',
          totalTexts: 0,
          processedTexts: 0,
          message:
            chosenAuditor !== 'claude'
              ? `Rewriting via ${AUDITOR_LABEL[chosenAuditor]} (worker locale)...`
              : cloneConfig.useOpenClaw
                ? 'Rewriting texts with OpenClaw (local)...'
                : 'Trinity sta riscrivendo...',
        });

        let rewriteData: { html: string; replacements: number; totalTexts: number; originalLength?: number; newLength?: number; provider?: string; error?: string };

        // Global auditor selector wins.
        //
        // PATH A — Neo / Morfeo (selettore globale != claude):
        //   Andiamo via swipe_landing_local sul worker scelto: stesso
        //   path dello "Swipe All", quindi STESSO universal-text
        //   extractor (extractAllTextsUniversal in
        //   /api/landing/swipe/openclaw-build-prompts) che pesca anche
        //   testi annidati / mixed-content / attributes che invece
        //   `extractTextsForRewriteClient` (regex piatto) si perdeva.
        //   E` la causa principale del "non swipa tutti i testi".
        //
        // PATH B — `cloneConfig.useOpenClaw` con auditor=claude:
        //   Path legacy via `rewriteWithOpenClawFromBrowser` (qualsiasi
        //   worker prende il job, no target). Tenuto per backward compat.
        //
        // PATH C — Claude vero e proprio:
        //   Edge Function Anthropic invariata.
        if (chosenAuditor !== 'claude') {
          if (!targetAgentForRewrite) throw new Error('Internal: missing target_agent for non-claude auditor');
          // Build product context shape expected by /openclaw-build-prompts.
          // marketingResearch / brief sono passati come marketing_brief
          // così finiscono nel system prompt del rewrite.
          const productPayloadForRow = {
            name: cloneConfig.productName,
            description: cloneConfig.productDescription || '',
            marketing_brief: (cloneConfig.brief || cloneConfig.customPrompt || '').trim() || undefined,
            market_research: (cloneConfig.marketResearch || '').trim() || undefined,
          };
          // Spedisci `html` SOLO se l'abbiamo gia' in cache (evita di
          // mandare megabyte attraverso Netlify per niente — il worker
          // sa fetchare la pagina lui in locale via Playwright). Se
          // sourceUrl e' presente ma html no, swipe_landing_local fa
          // il fetch dal worker. Se entrambi presenti, usa l'html.
          //
          // Knowledge: carico libreria saved_prompts (tecniche utente)
          // + brief specifico di questo project. Cosi' Neo/Morfeo
          // ricevono contestualmente sia le tecniche personali sia il
          // contesto del prodotto.
          let rowKnowledge: { prompts: unknown[]; project: unknown } = { prompts: [], project: null };
          try {
            const kRes = await fetch('/api/swipe/load-knowledge');
            if (kRes.ok) {
              const kj = await kRes.json();
              rowKnowledge = {
                prompts: Array.isArray(kj.prompts) ? kj.prompts : [],
                project: {
                  name: cloneConfig.productName,
                  brief: (cloneConfig.brief || cloneConfig.customPrompt || '').trim() || null,
                  market_research: (cloneConfig.marketResearch || '').trim() || null,
                  notes: null,
                },
              };
            }
          } catch {
            // non fatale
          }

          const swipePayload: Record<string, unknown> = {
            action: 'swipe_landing_local',
            sourceUrl: url,
            product: productPayloadForRow,
            tone: 'professional',
            language: cloneConfig.language || 'it',
            knowledge: rowKnowledge,
          };
          if (htmlToRewrite) swipePayload.html = htmlToRewrite;

          const enqueueRes = await fetch('/api/openclaw/queue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              section: 'swipe_job',
              message: JSON.stringify(swipePayload),
              targetAgent: targetAgentForRewrite,
            }),
          });
          const enqueued = (await enqueueRes.json()) as { id?: string; error?: string };
          if (!enqueueRes.ok || !enqueued.id) {
            throw new Error(enqueued.error || `Enqueue HTTP ${enqueueRes.status}`);
          }
          setCloneProgress({
            phase: 'processing',
            totalTexts: 0,
            processedTexts: 0,
            message: `In coda → ${AUDITOR_LABEL[chosenAuditor]} (job ${enqueued.id.slice(0, 8)})…`,
          });

          const PAGE_TIMEOUT_MS = 30 * 60 * 1000;
          const POLL_INTERVAL_MS = 2500;
          // No-pickup watchdog: se entro 30s nessun worker ha
          // marcato il job come 'processing', il problema NON e'
          // tempo di rewrite — il worker scelto non sta girando o
          // non vede questa coda. Fallisci subito con messaggio
          // azionabile invece di aspettare 10 minuti per niente.
          const NO_PICKUP_TIMEOUT_MS = 30 * 1000;
          const t0 = Date.now();
          let lastStatus: string | null = null;
          let final: {
            success?: boolean;
            html?: string;
            replacements?: number;
            totalTexts?: number;
            new_title?: string;
            error?: string;
          } | null = null;
          while (true) {
            if (Date.now() - t0 > PAGE_TIMEOUT_MS) {
              throw new Error(`Timeout: il worker ${AUDITOR_LABEL[chosenAuditor]} non ha completato in ${PAGE_TIMEOUT_MS / 1000}s`);
            }
            // No-pickup early bail-out.
            if (
              Date.now() - t0 > NO_PICKUP_TIMEOUT_MS &&
              (lastStatus === 'pending' || lastStatus === null)
            ) {
              throw new Error(
                `${AUDITOR_LABEL[chosenAuditor]} non ha preso il job in ${NO_PICKUP_TIMEOUT_MS / 1000}s. ` +
                  `Verifica che il worker sia avviato sul PC di ${chosenAuditor === 'neo' ? 'Neo' : 'Morfeo'} ` +
                  `(node openclaw-worker.js), che il repo sia aggiornato all'ultimo commit ` +
                  `(\`git pull\` poi riavvio worker), e che il suo OpenClaw locale risponda su 127.0.0.1:18789. ` +
                  `Workaround: riprova selezionando un altro auditor.`,
              );
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            const pollRes = await fetch(`/api/openclaw/queue?id=${encodeURIComponent(enqueued.id)}`);
            const polled = (await pollRes.json()) as { status?: string; content?: string; error?: string };
            if (polled.status && polled.status !== lastStatus) {
              lastStatus = polled.status;
              if (polled.status === 'processing') {
                setCloneProgress({
                  phase: 'processing',
                  totalTexts: 0,
                  processedTexts: 0,
                  message: `${AUDITOR_LABEL[chosenAuditor]} sta lavorando: estrazione + rewrite locale → finalize…`,
                });
              }
            }
            if (polled.status === 'completed' && polled.content) {
              try { final = JSON.parse(polled.content); }
              catch { throw new Error('Worker response non e JSON valido'); }
              break;
            }
            if (polled.status === 'error' || polled.status === 'failed') {
              const raw = polled.error || 'Worker ha fallito';
              // Heuristics su errori comuni del worker per dare
              // un'azione concreta all'utente invece del solo testo
              // grezzo dal worker.
              let hint = '';
              if (/Unknown swipe_job action.*swipe_landing_local/i.test(raw)) {
                hint = ` — Il worker ${AUDITOR_LABEL[chosenAuditor]} non conosce 'swipe_landing_local' = sta girando su un commit vecchio. Su quel PC: \`git pull\` + riavvio worker.`;
              } else if (/(ECONNREFUSED|HTTP 404|fetch failed).*(18789|chat\/completions)/i.test(raw)) {
                hint = ` — Il worker risponde ma il suo OpenClaw locale non risponde su 127.0.0.1:18789. Verifica \`openclaw gateway status\` su quel PC.`;
              } else if (/Local fetch failed|Playwright|net::ERR/i.test(raw)) {
                hint = ` — Il worker non riesce a scaricare la pagina. Probabilmente Playwright non e' installato (\`npx playwright install chromium\`) o il sito blocca l'IP del worker.`;
              }
              throw new Error(`${raw}${hint}`);
            }
          }
          if (!final || final.success === false || !final.html) {
            throw new Error(final?.error || 'Worker ha completato senza HTML');
          }
          rewriteData = {
            html: final.html,
            replacements: final.replacements ?? 0,
            totalTexts: final.totalTexts ?? 0,
            provider: `openclaw-${chosenAuditor}`,
          };
        } else if (cloneConfig.useOpenClaw) {
          rewriteData = await rewriteWithOpenClawFromBrowser({
            html: htmlToRewrite,
            productName: cloneConfig.productName,
            productDescription: cloneConfig.productDescription,
            customPrompt: cloneConfig.customPrompt || undefined,
            targetAgent: targetAgentForRewrite,
            onProgress: (done, total) => setCloneProgress({ phase: 'processing', totalTexts: total, processedTexts: done, message: `Rewriting via OpenClaw (${done}/${total} batches)...` }),
          });
        } else {
          // Browser-orchestrated chunked rewrite via Anthropic.
          // Why: Netlify caps sync functions at ~26s. We split work in 3 routes
          // (init / anthropic-batch / finalize) and the browser drives the loop
          // so each function call stays well under that limit.
          setCloneProgress({ phase: 'processing', totalTexts: 0, processedTexts: 0, message: 'Trinity sta riscrivendo...' });

          // === Rewrite via Next.js proxy (/api/funnel-swap-proxy) ===
          // Il proxy server-side inietta la knowledge base copywriting (COS,
          // Tony Flores, Evaldo, Anghelache, Savage, 108 split tests) come
          // blocco system con cache_control: ephemeral. Costo della KB pagato
          // 1 volta sola per job (cache hit sui batch successivi del job).
          // Logica del rewrite (estrazione testi, batching da 12, anti-mix
          // lingue, anti-brand competitor) resta nell'Edge Function Supabase.
          const SUPABASE_FN_URL = '/api/funnel-swap-proxy';
          const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';
          const sourceUrlForSwap = url || '';
          if (!sourceUrlForSwap) throw new Error('Manca URL competitor per il rewrite via Supabase Edge Function');

          // Brief inviato alla function = productDescription + (customPrompt come knowledge swipe).
          // La function legge anche framework / target / customPrompt separatamente.
          const briefParts: string[] = [];
          if (cloneConfig.productDescription?.trim()) briefParts.push(cloneConfig.productDescription.trim());
          if (cloneConfig.customPrompt?.trim()) {
            briefParts.push(`KNOWLEDGE COPYWRITING / ISTRUZIONI SWIPE:\n${cloneConfig.customPrompt.trim()}`);
          }

          setCloneProgress({
            phase: 'processing',
            totalTexts: 0,
            processedTexts: 0,
            message: 'Estrazione testi dal competitor...',
          });

          // Smart routing payload (see runSwipeAll for explanation).
          // We re-derive pageType + structured files from the linked
          // project at request time so we always send the freshest data.
          const cloneProject = (projects || []).find((pr) => pr.id === currentPage?.productId);
          const cloneRoutingPayload = {
            pageType: currentPage?.pageType || 'other',
            brief_files: cloneProject?.briefData?.files ?? [],
            brief_notes: cloneProject?.briefData?.notes ?? '',
            research_files: cloneProject?.marketResearchData?.files ?? [],
            research_notes: cloneProject?.marketResearchData?.notes ?? '',
          };

          const extractRes = await fetch(SUPABASE_FN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              phase: 'extract',
              url: sourceUrlForSwap,
              cloneMode: 'rewrite',
              productName: cloneConfig.productName,
              productDescription: briefParts.join('\n\n---\n\n'),
              framework: cloneConfig.framework || '',
              target: cloneConfig.target || '',
              customPrompt: cloneConfig.customPrompt || '',
              targetLanguage: cloneConfig.language || 'it',
              userId: DEFAULT_USER_ID,
              renderedHtml: htmlToRewrite,
              brief: cloneConfig.brief || undefined,
              market_research: cloneConfig.marketResearch || undefined,
              ...cloneRoutingPayload,
            }),
          });

          let extractData: {
            jobId?: string;
            success?: boolean;
            totalTexts?: number;
            error?: string;
            details?: string;
          };
          {
            const raw = await extractRes.text();
            try {
              extractData = raw ? JSON.parse(raw) : {};
            } catch {
              throw new Error(`Extract returned non-JSON (${extractRes.status}): ${raw.substring(0, 300)}`);
            }
          }
          if (!extractRes.ok || extractData.error) {
            throw new Error(extractData.error || extractData.details || `Extract HTTP ${extractRes.status}`);
          }
          if (!extractData.jobId) throw new Error('Extract: nessun jobId restituito');

          const sbJobId = extractData.jobId;
          const sbTotal = extractData.totalTexts || 0;
          let sbBatch = 0;
          let sbProcessed = 0;
          let sbFinalHtml = '';
          let sbReplacements = 0;
          const SB_MAX_BATCHES = 400;

          while (sbBatch < SB_MAX_BATCHES) {
            const { res: procRes, raw } = await fetchWithRetry(
              SUPABASE_FN_URL,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  phase: 'process',
                  jobId: sbJobId,
                  cloneMode: 'rewrite',
                  batchNumber: sbBatch,
                  userId: DEFAULT_USER_ID,
                  // brief / market_research are read by the Edge Function from
                  // the request body of every process call (they're not stored
                  // in the cloning_jobs row). Forwarding them on every batch is
                  // cheap (~10KB) and keeps the rewrite consistent across
                  // batches of the same job.
                  brief: cloneConfig.brief || undefined,
                  market_research: cloneConfig.marketResearch || undefined,
                  ...cloneRoutingPayload,
                }),
              },
              { retries: 2, baseDelayMs: 2000, label: `proc-batch-${sbBatch}` },
            );
            let procData: {
              success?: boolean;
              phase?: string;
              jobId?: string;
              content?: string;
              batchProcessed?: number;
              remainingTexts?: number;
              continue?: boolean;
              replacements?: number;
              error?: string;
              rewrites?: Array<{ original?: string; rewritten?: string }>;
            };
            try {
              procData = raw ? JSON.parse(raw) : {};
            } catch {
              throw new Error(`Process batch ${sbBatch} non-JSON (${procRes.status}): ${raw.substring(0, 300)}`);
            }
            if (!procRes.ok || procData.error) {
              throw new Error(procData.error || `Process batch ${sbBatch} HTTP ${procRes.status}`);
            }

            // Feed the live (before → after) preview pairs into the rewrite
            // stream powering the cinematic overlay's central panel.
            pushRewrites(procData.rewrites, pageName);

            if (procData.phase === 'completed' && procData.content) {
              sbFinalHtml = procData.content;
              sbReplacements = procData.replacements || 0;
              setCloneProgress({
                phase: 'processing',
                totalTexts: sbTotal,
                processedTexts: sbTotal,
                message: `Trinity completato (${sbReplacements} sostituzioni)`,
              });
              break;
            }

            sbProcessed += procData.batchProcessed || 0;
            const remaining = procData.remainingTexts ?? Math.max(0, sbTotal - sbProcessed);
            setCloneProgress({
              phase: 'processing',
              totalTexts: sbTotal,
              processedTexts: sbProcessed,
              message: `Trinity batch ${sbBatch + 1} (${sbProcessed}/${sbTotal}, ${remaining} rimasti)`,
            });

            if (!procData.continue && !remaining) break;
            sbBatch++;
          }

          if (!sbFinalHtml) {
            throw new Error(`Edge Function non ha restituito HTML completato dopo ${sbBatch + 1} batch`);
          }

          rewriteData = {
            html: sbFinalHtml,
            replacements: sbReplacements || sbTotal,
            totalTexts: sbTotal,
            originalLength: htmlToRewrite.length,
            newLength: sbFinalHtml.length,
            provider: 'supabase-edge',
          };
        }

        // === Legacy quiz-rewrite chunked path (disattivato) ===
        // Mantenuto per fallback rapido ma non eseguito.
        if (false) {
          const initRes = await fetch('/api/quiz-rewrite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              html: htmlToRewrite,
              productName: cloneConfig.productName,
              productDescription: cloneConfig.productDescription,
              customPrompt: cloneConfig.customPrompt || undefined,
              targetLanguage: cloneConfig.language || 'it',
            }),
          });
          let initData: {
            jobId?: string;
            totalTexts?: number;
            totalBatches?: number;
            batchSize?: number;
            batches?: Array<Array<{ id: number; text: string; tag: string }>>;
            systemPrompt?: string;
            error?: string;
          };
          {
            const raw = await initRes.text();
            try {
              initData = raw ? JSON.parse(raw) : {};
            } catch {
              throw new Error(`Init returned non-JSON (${initRes.status}): ${raw.substring(0, 200)}`);
            }
          }
          if (!initRes.ok || initData.error) throw new Error(initData.error || 'Failed to start rewrite job');
          if (!initData.jobId || !initData.batches || !initData.systemPrompt) {
            throw new Error('Init response missing jobId/batches/systemPrompt');
          }

          const { jobId, batches, systemPrompt, totalTexts: jobTotalTexts = 0, totalBatches = batches.length } = initData;

          setCloneProgress({
            phase: 'processing',
            totalTexts: jobTotalTexts,
            processedTexts: 0,
            message: `Trinity batch 0/${totalBatches} (job: ${jobId.substring(0, 8)})`,
          });

          const idToOriginal = new Map<number, string>();
          for (const b of batches) for (const item of b) idToOriginal.set(item.id, item.text);
          const idToRewrite = new Map<number, string>();
          const allIds = Array.from(idToOriginal.keys());

          const callBatch = async (
            batch: Array<{ id: number; text: string; tag: string }>,
            label: string,
            strict: boolean,
          ): Promise<Array<{ id: number; rewritten: string }>> => {
            const res = await fetch('/api/quiz-rewrite/anthropic-batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ batch, systemPrompt, label, strict }),
            });
            let data: { rewrites?: Array<{ id: number; rewritten: string }>; error?: string };
            {
              const raw = await res.text();
              try {
                data = raw ? JSON.parse(raw) : {};
              } catch {
                throw new Error(`Batch returned non-JSON (${res.status}): ${raw.substring(0, 200)}`);
              }
            }
            if (!res.ok || data.error) throw new Error(data.error || `Batch HTTP ${res.status}`);
            return data.rewrites || [];
          };

          // Pass 1: every batch sequentially (could be parallelized later).
          for (let i = 0; i < batches.length; i++) {
            const slice = batches[i];
            try {
              const rewrites = await callBatch(slice, `Batch ${i + 1}/${batches.length}`, false);
              for (const rw of rewrites) {
                if (typeof rw.id !== 'number' || typeof rw.rewritten !== 'string') continue;
                const trimmed = rw.rewritten.trim();
                if (!trimmed) continue;
                const orig = idToOriginal.get(rw.id);
                if (orig && trimmed === orig && orig.length > 20) continue; // anti-echo: lascia missing per gap-fill
                idToRewrite.set(rw.id, trimmed);
              }
            } catch (err) {
              console.error(`[rewrite] batch ${i + 1} failed:`, err);
            }
            setCloneProgress({
              phase: 'processing',
              totalTexts: jobTotalTexts,
              processedTexts: idToRewrite.size,
              message: `Trinity batch ${i + 1}/${totalBatches} (${idToRewrite.size}/${jobTotalTexts} testi)`,
            });
          }

          // Gap-fill passes for missed/echoed ids.
          const GAP_PASSES = 2;
          const GAP_BATCH = Math.max(8, Math.floor((initData.batchSize || 24) / 2));
          for (let pass = 1; pass <= GAP_PASSES; pass++) {
            const missing = allIds.filter((id) => !idToRewrite.has(id));
            if (missing.length === 0) break;
            setCloneProgress({
              phase: 'processing',
              totalTexts: jobTotalTexts,
              processedTexts: idToRewrite.size,
              message: `Gap-fill p${pass}: ${missing.length} testi rimasti`,
            });
            for (let j = 0; j < missing.length; j += GAP_BATCH) {
              const ids = missing.slice(j, j + GAP_BATCH);
              const slice = ids.map((id) => ({
                id,
                text: idToOriginal.get(id) || '',
                tag: 'unknown',
              }));
              try {
                const rewrites = await callBatch(slice, `Gap-fill p${pass}`, true);
                for (const rw of rewrites) {
                  if (typeof rw.id !== 'number' || typeof rw.rewritten !== 'string') continue;
                  const trimmed = rw.rewritten.trim();
                  if (!trimmed) continue;
                  idToRewrite.set(rw.id, trimmed); // ultimo pass accetta anche output identico
                }
              } catch (err) {
                console.error(`[rewrite] gap-fill p${pass} failed:`, err);
              }
              setCloneProgress({
                phase: 'processing',
                totalTexts: jobTotalTexts,
                processedTexts: idToRewrite.size,
                message: `Gap-fill p${pass}: ${idToRewrite.size}/${jobTotalTexts} riscritti`,
              });
            }
          }

          // Language gate: rileva i rewrite "troppo inglesi" e li ri-traduce.
          // Funziona perche' anche dopo gap-fill, Claude a volte mantiene
          // strutture inglesi nei testi che il client vede arrivare in lingua
          // sbagliata. Si filtrano solo le frasi >=4 parole con >=40% di stop-
          // words inglesi: cosi' non si traducono microcopy/numeri/CTA brevi.
          const targetLang = (cloneConfig.language || 'it').toLowerCase().substring(0, 2);
          if (targetLang === 'it') {
            const enStopwords = new Set([
              'the', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'on', 'at', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
              'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can',
              'this', 'that', 'these', 'those', 'your', 'you', 'our', 'we', 'they', 'them', 'his', 'her', 'their', 'its',
              'try', 'get', 'now', 'here', 'there', 'how', 'why', 'when', 'where', 'what', 'which', 'who',
              'free', 'order', 'today', 'just', 'only', 'more', 'most', 'less', 'best', 'new', 'all', 'any', 'each',
              'click', 'shop', 'buy', 'discover', 'reveals', 'lock', 'about', 'because', 'before', 'after',
              'than', 'so', 'if', 'then', 'also', 'still', 'even', 'too', 'very',
              'doctor', 'physical', 'therapist', 'therapy', 'expert', 'reveal',
              'breakthrough', 'alert', 'warning', 'update', 'breaking', 'selling', 'sold', 'out',
              'massage', 'massager', 'electric', 'foot', 'feet', 'pain', 'relief', 'instant',
              'min', 'mins', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'week', 'weeks',
            ]);
            const isLikelyEnglish = (s: string): boolean => {
              const tokens = s.toLowerCase().match(/[a-zA-Zàèéìòù']+/g) || [];
              if (tokens.length < 4) return false; // microcopy: tollerate
              let hits = 0;
              for (const t of tokens) if (enStopwords.has(t)) hits++;
              return hits / tokens.length >= 0.35;
            };

            const langSuspectIds: number[] = [];
            for (const [id, rewritten] of idToRewrite) {
              if (isLikelyEnglish(rewritten)) langSuspectIds.push(id);
            }

            if (langSuspectIds.length > 0) {
              console.log(`[rewrite] language-fix: ${langSuspectIds.length} testi con sospetto inglese`);
              setCloneProgress({
                phase: 'processing',
                totalTexts: jobTotalTexts,
                processedTexts: idToRewrite.size,
                message: `Lingua: traduco ${langSuspectIds.length} testi rimasti in inglese...`,
              });

              const TRANSLATE_BATCH = 12;
              const langSystem = `Sei un traduttore. Ricevi testi che dovevano essere in italiano ma sono ancora in inglese (o un mix). Per OGNI id, restituisci il testo in italiano puro, senza una sola parola inglese (eccetto termini ormai italiani come 'smartphone', 'online', 'web'). Mantieni il placeholder \`[PRODOTTO_TARGET]\` se presente. Mantieni numeri italianizzati ($->€ se opportuno). Stessa lunghezza ±20%. NIENTE markdown.

Restituisci SOLO un JSON array: [{"id": N, "rewritten": "..."}, ...].`;

              for (let k = 0; k < langSuspectIds.length; k += TRANSLATE_BATCH) {
                const ids = langSuspectIds.slice(k, k + TRANSLATE_BATCH);
                const slice = ids.map((id) => ({
                  id,
                  text: idToRewrite.get(id) || '',
                  tag: 'lang-fix',
                }));
                try {
                  const fixed = await callBatch(slice, `Lang-fix ${k / TRANSLATE_BATCH + 1}`, true);
                  for (const rw of fixed) {
                    if (typeof rw.id !== 'number' || typeof rw.rewritten !== 'string') continue;
                    const trimmed = rw.rewritten.trim();
                    if (!trimmed) continue;
                    if (!isLikelyEnglish(trimmed)) {
                      idToRewrite.set(rw.id, trimmed);
                    }
                  }
                } catch (err) {
                  console.error('[rewrite] lang-fix batch failed:', err);
                }
              }
            }
          }

          const rewritesArray = Array.from(idToRewrite, ([id, rewritten]) => ({ id, rewritten }));
          const unresolvedIds = allIds.filter((id) => !idToRewrite.has(id));

          setCloneProgress({
            phase: 'processing',
            totalTexts: jobTotalTexts,
            processedTexts: idToRewrite.size,
            message: 'Applying rewrites to HTML...',
          });

          const finalizeRes = await fetch('/api/quiz-rewrite/finalize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, rewrites: rewritesArray, unresolvedIds }),
          });
          let finalizeData: {
            status?: string;
            result?: { html: string; replacements: number; totalTexts: number; originalLength: number; newLength: number; provider: string };
            error?: string;
          };
          {
            const raw = await finalizeRes.text();
            try {
              finalizeData = raw ? JSON.parse(raw) : {};
            } catch {
              throw new Error(`Finalize returned non-JSON (${finalizeRes.status}): ${raw.substring(0, 200)}`);
            }
          }
          if (!finalizeRes.ok || finalizeData.error || !finalizeData.result) {
            throw new Error(finalizeData.error || 'Finalize failed');
          }

          rewriteData = finalizeData.result;
        }

        setCloneProgress(null);
        const rewrittenHtml = rewriteData.html;

        updateFunnelPage(pageId, {
          swipeStatus: 'completed',
          swipeResult: `Rewrite OK (${rewriteData.replacements}/${rewriteData.totalTexts} texts) [${rewriteData.provider || 'claude'}]`,
          swipedData: {
            html: rewrittenHtml,
            originalTitle: pageName,
            newTitle: `Rewrite: ${pageName}`,
            originalLength: rewriteData.originalLength || htmlToRewrite.length,
            newLength: rewriteData.newLength || rewrittenHtml.length,
            processingTime: 0,
            methodUsed: 'claude-rewrite',
            changesMade: [`${rewriteData.replacements} texts rewritten out of ${rewriteData.totalTexts}`],
            swipedAt: new Date(),
          },
        });

        setPreviewTab('preview');
        setHtmlPreviewModal({
          isOpen: true,
          title: `Rewrite: ${pageName}`,
          html: rewrittenHtml,
          mobileHtml: '',
          iframeSrc: '',
          metadata: { method: 'claude-rewrite', length: rewrittenHtml.length, duration: 0 },
          pageId,
          sourceType: 'swiped',
        });

      } else if (mode === 'translate') {
        // Translate mode: need clonedData HTML first
        const page = (funnelPages || []).find(p => p.id === pageId);
        const htmlToTranslate = page?.clonedData?.html || page?.swipedData?.html;

        if (!htmlToTranslate) {
          throw new Error('Clone the page before translating it (cloned or rewritten HTML is required)');
        }

        setCloneProgress({ phase: 'translating', totalTexts: 0, processedTexts: 0, message: `Translating to ${cloneConfig.targetLanguage}...` });
        const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

        const response = await fetch('/api/clone-funnel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cloneMode: 'translate',
            htmlContent: htmlToTranslate,
            targetLanguage: cloneConfig.targetLanguage,
            userId: DEFAULT_USER_ID,
          }),
        });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || 'Translate failed');

        setCloneProgress(null);
        const translatedHtml = sanitizeClonedHtml(data.content, url, { keepScripts: preserveScripts });
        updateFunnelPage(pageId, {
          swipeStatus: 'completed',
          swipeResult: `Translated (${data.textsTranslated || 0} texts → ${data.targetLanguage})`,
          swipedData: {
            html: translatedHtml,
            originalTitle: pageName,
            newTitle: `${data.targetLanguage}: ${pageName}`,
            originalLength: data.originalHtmlSize || 0,
            newLength: data.finalHtmlSize || 0,
            processingTime: 0,
            methodUsed: 'smooth-responder-translate',
            changesMade: [`${data.textsTranslated} texts translated to ${data.targetLanguage}`],
            swipedAt: new Date(),
          },
        });

        setHtmlPreviewModal({
          isOpen: true,
          title: `${data.targetLanguage}: ${pageName}`,
          html: translatedHtml,
          mobileHtml: '',
          iframeSrc: '',
          metadata: { method: 'translate', length: data.finalHtmlSize || 0, duration: 0 },
          pageId,
          sourceType: 'swiped',
        });
      }
    } catch (error) {
      setCloneProgress(null);
      updateFunnelPage(pageId, {
        swipeStatus: 'failed',
        swipeResult: error instanceof Error ? error.message : 'Clone error',
      });
    } finally {
      setCloningIds(prev => prev.filter(i => i !== pageId));
    }
  };

  const toggleSectionExpanded = (index: number) => {
    setExpandedSections(prev =>
      prev.includes(index)
        ? prev.filter(i => i !== index)
        : [...prev, index]
    );
  };

  const getSectionTypeColor = (type: string): string => {
    const normalizedType = type.toLowerCase().replace(/[^a-z]/g, '_');
    return SECTION_TYPE_COLORS[normalizedType] || SECTION_TYPE_COLORS.unknown;
  };

  // Launch swipe with job API
  const handleLaunchSwipeJob = async () => {
    const pageId = swipeConfigModal.pageId;
    
    // Save prompt to the page
    updateFunnelPage(pageId, { prompt: swipeConfig.prompt });
    
    setSwipeConfigModal({ isOpen: false, pageId: '', pageName: '', url: '' });
    setLoadingIds(prev => [...prev, pageId]);
    setShowJobsPanel(true);
    updateFunnelPage(pageId, { swipeStatus: 'in_progress', swipeResult: `Starting...` });

    try {
      let response: Response;

      const projectId = swipeConfig.url ? new URL(swipeConfig.url).hostname : 'default';
      const userId = 'funnel-swiper-user';

      if (apiMode === 'local') {
        response = await fetch(api.start, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: swipeConfig.url,
            product_name: swipeConfig.product_name,
            product_description: swipeConfig.product_description,
            cta_text: swipeConfig.cta_text,
            cta_url: swipeConfig.cta_url,
            language: swipeConfig.language,
            brand_name: swipeConfig.brand_name,
            benefits: swipeConfig.benefits.filter(b => b.trim()),
            project_id: projectId,
            user_id: userId,
            prompt: swipeConfig.prompt,
          }),
        });
      } else {
        const params = new URLSearchParams({
          url: swipeConfig.url,
          product_name: swipeConfig.product_name,
          product_description: swipeConfig.product_description,
          cta_text: swipeConfig.cta_text,
          cta_url: swipeConfig.cta_url,
          language: swipeConfig.language,
          project_id: projectId,
          user_id: userId,
        });
        
        if (swipeConfig.prompt) params.append('prompt', swipeConfig.prompt);
        swipeConfig.benefits.forEach(benefit => {
          if (benefit.trim()) params.append('benefits', benefit.trim());
        });
        if (swipeConfig.brand_name) params.append('brand_name', swipeConfig.brand_name);

        response = await fetch(`${api.start}?${params.toString()}`, {
          method: 'POST',
        });
      }

      const data = await response.json();

      if (!response.ok || !data.job_id) {
        throw new Error(data.error || data.detail || 'Error starting job');
      }

      setActiveJobs(prev => [...prev, {
        pageId,
        jobId: data.job_id,
        status: 'pending',
        progress: 0,
        startedAt: new Date(),
        lastUpdate: new Date(),
      }]);

      updateFunnelPage(pageId, { 
        swipeStatus: 'in_progress', 
        swipeResult: `0%` 
      });

    } catch (error) {
      updateFunnelPage(pageId, {
        swipeStatus: 'failed',
        swipeResult: error instanceof Error ? error.message : 'Network error',
      });
      setLoadingIds(prev => prev.filter(i => i !== pageId));
    }
  };

  const addBenefit = () => {
    if (benefitInput.trim() && !swipeConfig.benefits.includes(benefitInput.trim())) {
      setSwipeConfig({
        ...swipeConfig,
        benefits: [...swipeConfig.benefits, benefitInput.trim()],
      });
      setBenefitInput('');
    }
  };

  const removeBenefit = (index: number) => {
    setSwipeConfig({
      ...swipeConfig,
      benefits: swipeConfig.benefits.filter((_, i) => i !== index),
    });
  };

  const getActiveJob = (pageId: string) => activeJobs.find(j => j.pageId === pageId);

  const handleAnalyze = async (page: typeof funnelPages[0]) => {
    if (!page.urlToSwipe) return;
    
    setAnalyzingIds((prev) => [...prev, page.id]);
    updateFunnelPage(page.id, { analysisStatus: 'in_progress' });

    try {
      const response = await fetch('/api/funnel/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: page.urlToSwipe,
          pageType: page.pageType,
          template: page.templateId || page.pageType || 'standard',
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        updateFunnelPage(page.id, { 
          analysisStatus: 'failed',
          analysisResult: data.error || 'Error during analysis'
        });
      } else {
        const resultText = data.analysis?.result || 
                          data.analysis?.error || 
                          JSON.stringify(data.analysis, null, 2);
        
        updateFunnelPage(page.id, { 
          analysisStatus: 'completed',
          analysisResult: resultText,
          extractedData: data.extractedData
        });

        setAnalysisModal({
          isOpen: true,
          pageId: page.id,
          result: resultText,
          extractedData: data.extractedData
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Network error';
      updateFunnelPage(page.id, { 
        analysisStatus: 'failed',
        analysisResult: msg === 'Failed to fetch' ? 'Network error. Check /api/health and that claude-code-agents.fly.dev is reachable.' : msg
      });
    } finally {
      setAnalyzingIds((prev) => prev.filter((i) => i !== page.id));
    }
  };

  const getStatusBadge = (status: string) => {
    const statusOption = STATUS_OPTIONS.find((s) => s.value === status);
    return (
      <span
        className={`px-2 py-1 rounded-full text-xs font-medium ${
          statusOption?.color || 'bg-gray-200'
        }`}
      >
        {statusOption?.label || status}
      </span>
    );
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Front End Funnel"
        subtitle="Manage funnel pages with Excel-style view"
      />

      <div className="p-6">
        {/* Toolbar */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4 flex-wrap">
              <button
                onClick={handleAddPage}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add Step
              </button>
              <span className="text-gray-500">
                {(funnelPages || []).length} pages
              </span>

              {/* Import from Spreadsheet */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleImportSpreadsheet}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 transition-colors"
                title="Import steps from Excel or CSV file"
              >
                <Upload className="w-4 h-4" />
                Import
              </button>
              <button
                onClick={handleDownloadTemplate}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200 transition-colors"
                title="Download Excel template with correct columns"
              >
                <FileSpreadsheet className="w-4 h-4" />
                Template
              </button>
              {/* Bulk Checkpoint — imports every step into the audit
                  library in one click. */}
              {(funnelPages || []).filter((p) => (p.urlToSwipe || '').trim()).length > 0 && (
                <button
                  onClick={handleCheckpointAll}
                  disabled={bulkCheckpointing}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 transition-colors disabled:opacity-60"
                  title="Importa tutti gli step nel Checkpoint"
                >
                  {bulkCheckpointing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="w-4 h-4" />
                  )}
                  {bulkCheckpointing ? 'Importo...' : 'Checkpoint All'}
                </button>
              )}
              {/* Bulk Project Selector */}
              {(funnelPages || []).length > 0 && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <Target className="w-4 h-4 text-amber-600" />
                  <span className="text-sm font-medium text-amber-800 whitespace-nowrap">Project for all:</span>
                  <select
                    value=""
                    onChange={(e) => handleBulkProductChange(e.target.value)}
                    className="min-w-[160px] px-2 py-1 border border-amber-300 rounded-md text-sm bg-white focus:ring-2 focus:ring-amber-400 focus:border-amber-400"
                  >
                    <option value="">— Select —</option>
                    {(projects || []).map((proj) => (
                      <option key={proj.id} value={proj.id}>
                        {proj.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {/* Saved Funnels Dropdown (from affiliate_saved_funnels) */}
              <div className="flex items-center gap-2">
                <label htmlFor="saved-funnel-select" className="text-sm font-medium text-gray-700 flex items-center gap-1">
                  <FileStack className="w-4 h-4 text-amber-500" />
                  Saved Funnel
                </label>
                <select
                  id="saved-funnel-select"
                  value={selectedAffiliateFunnelId ?? ''}
                  onChange={(e) => setSelectedAffiliateFunnelId(e.target.value || null)}
                  className="min-w-[260px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500 text-sm bg-white"
                >
                  <option value="">— Select a funnel —</option>
                  {affiliateFunnelsLoading ? (
                    <option disabled>Loading...</option>
                  ) : (
                    affiliateFunnels.map((af) => (
                      <option key={af.id} value={af.id}>
                        {af.funnel_name}{af.brand_name ? ` (${af.brand_name})` : ''} — {af.funnel_type.replace(/_/g, ' ')} — {af.total_steps} step
                      </option>
                    ))
                  )}
                </select>
                {affiliateFunnels.length > 0 && (
                  <button
                    onClick={() => fetchAffiliateData()}
                    disabled={affiliateFunnelsLoading}
                    className="p-2 text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                    title="Refresh funnels"
                  >
                    <RefreshCw className={`w-4 h-4 ${affiliateFunnelsLoading ? 'animate-spin' : ''}`} />
                  </button>
                )}
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              {/* Jobs Monitor Toggle */}
              <button
                onClick={() => setShowJobsPanel(!showJobsPanel)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  showJobsPanel 
                    ? 'bg-purple-100 text-purple-700' 
                    : activeJobs.length > 0 
                      ? 'bg-yellow-100 text-yellow-700 animate-pulse' 
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                <Loader2 className={`w-4 h-4 ${activeJobs.length > 0 ? 'animate-spin' : ''}`} />
                Jobs {activeJobs.length > 0 && `(${activeJobs.length})`}
              </button>

              {/* API Mode Toggle */}
              <div className="flex items-center bg-gray-100 rounded-lg p-1">
                {(['localDev', 'local', 'server'] as ApiMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setApiMode(mode)}
                    className={`px-3 py-1.5 rounded text-sm font-medium transition-colors whitespace-nowrap ${
                      apiMode === mode
                        ? mode === 'localDev' 
                          ? 'bg-white text-orange-600 shadow-sm'
                          : mode === 'local'
                            ? 'bg-white text-blue-600 shadow-sm'
                            : 'bg-white text-green-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                    title={mode === 'localDev' ? 'localhost:8081' : mode === 'local' ? 'Next.js Proxy' : 'fly.dev'}
                  >
                    {API_ENDPOINTS[mode].icon} {API_ENDPOINTS[mode].name}
                  </button>
                ))}
              </div>

              {/* Global Auditor selector — vale per Swipe All, Clone &
                 Rewrite per riga, e gli enqueue OpenClaw da questo page.
                 La voce attiva e` sticky in localStorage.
                 Highlight prominente quando NON e` Claude, cosi` l'utente
                 vede immediatamente chi sta lavorando. */}
              <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border transition-colors ${
                  auditor === 'claude'
                    ? 'bg-gray-50 border-gray-200'
                    : auditor === 'neo'
                      ? 'bg-emerald-50 border-emerald-300 ring-2 ring-emerald-100'
                      : 'bg-blue-50 border-blue-300 ring-2 ring-blue-100'
                }`}
                title="Sceglie chi esegue clone + swipe + rewrite. Claude = Netlify (Anthropic). Neo / Morfeo = job in coda OpenClaw, worker locale fa fetch + LLM in locale."
              >
                <span className="text-xs font-medium text-gray-600 pr-1">Auditor:</span>
                {(['claude', 'neo', 'morfeo'] as const).map((opt) => {
                  const active = auditor === opt;
                  const colour = opt === 'claude'
                    ? (active ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-purple-700 border-gray-300 hover:border-purple-400')
                    : opt === 'neo'
                      ? (active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-emerald-700 border-gray-300 hover:border-emerald-400')
                      : (active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-blue-700 border-gray-300 hover:border-blue-400');
                  return (
                    <button
                      key={opt}
                      type="button"
                      disabled={swipeAllJob?.isRunning}
                      onClick={() => setAuditor(opt)}
                      className={`text-xs px-2 py-1 rounded border transition-colors disabled:opacity-50 ${colour}`}
                      title={
                        opt === 'claude'
                          ? 'Server-side via Anthropic + Edge Function (puo fallire su funnel grossi / quota Anthropic finita)'
                          : `Job in coda OpenClaw, worker ${opt} fa fetch + rewrite LLM in locale (no 504, no quota Anthropic)`
                      }
                    >
                      {opt === 'claude' ? 'Claude' : opt === 'neo' ? 'Neo' : 'Morfeo'}
                    </button>
                  );
                })}
              </div>

              {/* Swipe All — riscrive in sequenza tutte le pagine eligibili
                 mantenendo coerenza narrativa tra una pagina e l'altra
                 (Claude vede il riassunto delle pagine già fatte). */}
              <button
                onClick={() => {
                  if (swipeAllJob?.isRunning) {
                    if (window.confirm('Annullare lo Swipe All in corso? La pagina attuale finirà comunque.')) {
                      cancelSwipeAll();
                    }
                    return;
                  }
                  void runSwipeAll();
                }}
                disabled={!funnelPages || funnelPages.length === 0}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  swipeAllJob?.isRunning
                    ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 border border-amber-300'
                    : 'bg-gradient-to-r from-violet-600 via-fuchsia-600 to-pink-600 hover:from-violet-700 hover:via-fuchsia-700 hover:to-pink-700 text-white shadow-sm'
                }`}
                title={
                  swipeAllJob?.isRunning
                    ? 'Click per annullare lo Swipe All in corso'
                    : 'Swipe sequenziale di tutte le pagine, mantenendo coerenza narrativa tra una pagina e l\'altra (Claude vede il riassunto delle pagine già riscritte)'
                }
              >
                {swipeAllJob?.isRunning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Swiping {swipeAllJob.currentIndex}/{swipeAllJob.totalCount}…
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Swipe All
                  </>
                )}
              </button>

              {/* Save Funnel */}
              <button
                onClick={() => {
                  if (!funnelPages || funnelPages.length === 0) {
                    alert('No steps to save');
                    return;
                  }
                  setSaveFunnelName('');
                  setShowSaveModal(true);
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-green-50 text-green-700 hover:bg-green-100 transition-colors"
                title="Save all steps as funnel in archive"
              >
                <Download className="w-4 h-4" />
                Save
              </button>

              {/* Clean All Steps */}
              <button
                onClick={async () => {
                  if (!funnelPages || funnelPages.length === 0) return;
                  if (!confirm(`Delete all ${funnelPages.length} steps?`)) return;
                  for (const page of funnelPages) {
                    await deleteFunnelPage(page.id);
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                title="Delete all steps from the table"
              >
                <Trash2 className="w-4 h-4" />
                Clean
              </button>
            </div>
          </div>

          {/* Swipe All Progress Panel — visibile finché il job è in corso o
             ha appena finito con errori da rivedere. */}
          {swipeAllJob && (swipeAllJob.isRunning || swipeAllJob.errors.length > 0 || swipeAllJob.completed > 0) && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  {swipeAllJob.isRunning ? (
                    <Loader2 className="w-4 h-4 animate-spin text-fuchsia-600" />
                  ) : (
                    <Sparkles className="w-4 h-4 text-fuchsia-600" />
                  )}
                  Swipe All
                  {swipeAllJob.cancelRequested && (
                    <span className="text-[10px] uppercase tracking-wider text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded">Cancel requested</span>
                  )}
                </h3>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-600">
                    {swipeAllJob.completed}/{swipeAllJob.totalCount} done
                    {swipeAllJob.errors.length > 0 && (
                      <span className="text-red-600 ml-1">· {swipeAllJob.errors.length} error{swipeAllJob.errors.length > 1 ? 's' : ''}</span>
                    )}
                  </span>
                  {!swipeAllJob.isRunning && (
                    <button
                      onClick={() => setSwipeAllJob(null)}
                      className="text-xs text-gray-500 hover:text-gray-700"
                      title="Chiudi pannello"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>

              {/* Progress bar */}
              <div className="h-2 rounded-full bg-gray-100 overflow-hidden mb-2">
                <div
                  className="h-full bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500 transition-all duration-300"
                  style={{
                    width: `${
                      swipeAllJob.totalCount > 0
                        ? Math.round((swipeAllJob.completed / swipeAllJob.totalCount) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>

              {swipeAllJob.isRunning && (
                <p className="text-xs text-gray-600">
                  <span className="font-medium text-gray-800">
                    {swipeAllJob.currentIndex}/{swipeAllJob.totalCount} — {swipeAllJob.currentPageName || '…'}
                  </span>
                  {swipeAllJob.currentStep === 'cloning' && ' · cloning…'}
                  {swipeAllJob.currentStep === 'rewriting' && ` · rewriting${swipeAllJob.batchInfo ? ` (${swipeAllJob.batchInfo})` : ''}`}
                  {swipeAllJob.currentStep === 'narrative' && ' · estrazione narrative per coerenza con le prossime pagine…'}
                </p>
              )}

              {!swipeAllJob.isRunning && swipeAllJob.errors.length === 0 && swipeAllJob.completed > 0 && (
                <p className="text-xs text-emerald-700">
                  ✓ Tutte e {swipeAllJob.completed} le pagine sono state riscritte con coerenza narrativa.
                </p>
              )}

              {swipeAllJob.errors.length > 0 && (
                <div className="mt-2 space-y-1">
                  {swipeAllJob.errors.map((e, idx) => (
                    <p key={idx} className="text-[11px] text-red-700">
                      <span className="font-semibold">{e.pageName}:</span> {e.message}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Active Jobs Panel */}
          {showJobsPanel && activeJobs.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                  Active Jobs
                </h3>
                <span className="text-xs text-gray-500">
                  Polling every 5s • API: {API_ENDPOINTS[apiMode].name}
                </span>
              </div>
              <div className="space-y-3">
                {activeJobs.map((job) => {
                  const page = (funnelPages || []).find(p => p.id === job.pageId);
                  const elapsed = job.startedAt 
                    ? Math.floor((Date.now() - job.startedAt.getTime()) / 1000)
                    : 0;
                  
                  return (
                    <div 
                      key={job.jobId} 
                      className={`rounded-lg p-3 ${
                        job.status === 'completed' 
                          ? 'bg-green-50 border border-green-200' 
                          : job.status === 'failed'
                            ? 'bg-red-50 border border-red-200'
                            : 'bg-purple-50 border border-purple-200'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          {job.status === 'completed' ? (
                            <CheckCircle className="w-4 h-4 text-green-600" />
                          ) : job.status === 'failed' ? (
                            <XCircle className="w-4 h-4 text-red-600" />
                          ) : (
                            <Loader2 className="w-4 h-4 text-purple-600 animate-spin" />
                          )}
                          <span className="font-medium text-gray-900">
                            {page?.name || 'Job'}
                          </span>
                          <code className="text-xs bg-gray-200 px-1.5 py-0.5 rounded text-gray-600">
                            {job.jobId.slice(0, 8)}...
                          </code>
                        </div>
                        <div className="flex items-center gap-3 text-sm">
                          <span className="text-gray-500">
                            {Math.floor(elapsed / 60)}:{(elapsed % 60).toString().padStart(2, '0')}
                          </span>
                          <span className={`font-bold ${
                            job.status === 'completed' ? 'text-green-600' : 'text-purple-600'
                          }`}>
                            {job.progress}%
                          </span>
                        </div>
                      </div>
                      
                      {/* Progress Bar */}
                      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div 
                          className={`h-full transition-all duration-500 ${
                            job.status === 'completed' 
                              ? 'bg-green-500' 
                              : job.status === 'failed'
                                ? 'bg-red-500'
                                : 'bg-purple-500'
                          }`}
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                      
                      {job.currentLayer && job.status === 'running' && (
                        <div className="mt-2 text-xs text-purple-700 flex items-center gap-1">
                          <span className="animate-pulse">●</span>
                          Layer: <span className="font-medium">{job.currentLayer}</span>
                        </div>
                      )}
                      
                      {job.visionJobId && (
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-xs text-indigo-600 flex items-center gap-1">
                            <ImageIcon className="w-3 h-3" />
                            Vision: <code className="bg-indigo-100 px-1 rounded">{job.visionJobId.slice(0, 8)}...</code>
                          </span>
                          <button
                            onClick={() => {
                              if (page) {
                                setVisionModal({
                                  isOpen: true,
                                  pageId: page.id,
                                  pageName: page.name,
                                  sourceUrl: page.urlToSwipe,
                                });
                                fetchVisionJobDetail(job.visionJobId!);
                              }
                            }}
                            className="text-xs text-indigo-600 hover:text-indigo-800 underline"
                          >
                            View Analysis
                          </button>
                        </div>
                      )}

                      {job.status === 'completed' && (
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => {
                              setHtmlPreviewModal({
                                isOpen: true,
                                title: page?.name || 'Result',
                                html: '',
                                mobileHtml: '',
                                iframeSrc: api.result(job.jobId),
                                metadata: null,
                              });
                            }}
                            className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700"
                          >
                            <Eye className="w-3 h-3 inline mr-1" />
                            View Result
                          </button>
                          <a
                            href={api.result(job.jobId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs px-2 py-1 bg-gray-600 text-white rounded hover:bg-gray-700"
                          >
                            <ExternalLink className="w-3 h-3 inline mr-1" />
                            Open
                          </a>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Empty Jobs Panel */}
          {showJobsPanel && activeJobs.length === 0 && (
            <div className="mt-4 pt-4 border-t border-gray-200 text-center py-6 text-gray-500">
              <Loader2 className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No active jobs</p>
              <p className="text-xs mt-1">Jobs will appear here when you launch a swipe</p>
            </div>
          )}

          {/* Selected funnel pages */}
          {selectedAffiliateFunnelId && selectedAffiliateFunnel && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                  <Target className="w-4 h-4 text-amber-600" />
                  Steps of &quot;{selectedAffiliateFunnel.funnel_name}&quot;
                  {selectedAffiliateFunnel.brand_name && (
                    <span className="text-xs font-normal text-gray-500">({selectedAffiliateFunnel.brand_name})</span>
                  )}
                </h3>
                <div className="flex items-center gap-2">
                  {selectedAffiliateFunnel.funnel_type && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                      {selectedAffiliateFunnel.funnel_type.replace(/_/g, ' ')}
                    </span>
                  )}
                  {selectedAffiliateFunnel.category && selectedAffiliateFunnel.category !== 'other' && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                      {selectedAffiliateFunnel.category.replace(/_/g, ' ')}
                    </span>
                  )}
                  <button
                    onClick={handleImportAllAffiliateSteps}
                    disabled={affiliateFunnelSteps.length === 0}
                    className="px-3 py-1.5 text-xs font-medium bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors flex items-center gap-1 disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-3 h-3" />
                    Import all ({affiliateFunnelSteps.length})
                  </button>
                  <button
                    onClick={handleGenerateQuiz}
                    disabled={quizGenerating || affiliateFunnelSteps.length === 0}
                    className="px-3 py-1.5 text-xs font-medium bg-gradient-to-r from-violet-500 to-purple-600 text-white rounded-lg hover:from-violet-600 hover:to-purple-700 transition-all flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                  >
                    {quizGenerating ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Sparkles className="w-3 h-3" />
                    )}
                    {quizGenerating ? 'Generating...' : 'Generate Quiz Funnel'}
                  </button>
                </div>
              </div>

              {/* Analysis summary */}
              {selectedAffiliateFunnel.analysis_summary && (
                <p className="text-xs text-gray-600 mb-3 bg-amber-50 rounded-lg p-2 border border-amber-100">
                  {selectedAffiliateFunnel.analysis_summary}
                </p>
              )}

              {/* Tags & Techniques */}
              {(selectedAffiliateFunnel.tags.length > 0 || selectedAffiliateFunnel.persuasion_techniques.length > 0) && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {selectedAffiliateFunnel.tags.map((tag, i) => (
                    <span key={`tag-${i}`} className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">
                      {tag}
                    </span>
                  ))}
                  {selectedAffiliateFunnel.persuasion_techniques.map((tech, i) => (
                    <span key={`tech-${i}`} className="px-2 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-700">
                      {tech}
                    </span>
                  ))}
                </div>
              )}

              {/* Quiz generation progress / error */}
              {quizGenerating && quizGenerationPhase && (
                <div className="mb-3 flex items-center gap-2 text-sm text-purple-700 bg-purple-50 rounded-lg p-2.5 border border-purple-100">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  {quizGenerationPhase}
                </div>
              )}
              {quizError && (
                <div className="mb-3 flex items-center gap-2 text-sm text-red-700 bg-red-50 rounded-lg p-2.5 border border-red-100">
                  <XCircle className="w-4 h-4 shrink-0" />
                  {quizError}
                </div>
              )}

              <div className="rounded-lg border border-amber-200 bg-amber-50/30 overflow-hidden">
                <div className="p-3 space-y-2 max-h-80 overflow-y-auto">
                  {affiliateFunnelSteps.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-4">
                      No structured steps available for this funnel.
                    </p>
                  ) : (
                    affiliateFunnelSteps.map((step, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-3 p-2.5 rounded-lg bg-white border border-gray-100 hover:border-amber-200 transition-colors"
                      >
                        <span className="w-7 h-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs font-bold shrink-0">
                          {step.step_index}
                        </span>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <p className="text-sm font-medium text-gray-900 truncate">
                              {step.title || `Step ${step.step_index}`}
                            </p>
                            {step.step_type && (
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
                                step.step_type === 'quiz_question'
                                  ? 'bg-indigo-100 text-indigo-700'
                                  : step.step_type === 'lead_capture'
                                    ? 'bg-green-100 text-green-700'
                                    : step.step_type === 'checkout'
                                      ? 'bg-orange-100 text-orange-700'
                                      : step.step_type === 'upsell'
                                        ? 'bg-red-100 text-red-700'
                                        : 'bg-gray-100 text-gray-600'
                              }`}>
                                {step.step_type.replace(/_/g, ' ')}
                              </span>
                            )}
                            {step.input_type && step.input_type !== 'none' && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-cyan-100 text-cyan-700 shrink-0">
                                {step.input_type.replace(/_/g, ' ')}
                              </span>
                            )}
                          </div>
                          {step.description && (
                            <p className="text-xs text-gray-500 truncate">{step.description}</p>
                          )}
                          {step.url && (
                            <a
                              href={step.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-amber-600 hover:underline truncate block"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {step.url}
                            </a>
                          )}
                          {step.cta_text && (
                            <span className="inline-block mt-1 px-2 py-0.5 text-[10px] bg-green-50 text-green-700 rounded border border-green-200">
                              CTA: {step.cta_text}
                            </span>
                          )}
                        </div>

                        <button
                          onClick={() => handleUseAffiliateStepForSwipe(step, selectedAffiliateFunnel.funnel_name)}
                          disabled={!step.url}
                          className="shrink-0 px-3 py-1.5 text-xs font-medium bg-amber-500 text-white rounded hover:bg-amber-600 transition-colors flex items-center gap-1 disabled:bg-gray-300 disabled:cursor-not-allowed"
                        >
                          <Wand2 className="w-3 h-3" />
                          Use for swipe
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {affiliateFunnelsError && (
            <div className="mt-4 pt-4 border-t border-gray-200 flex items-center gap-2 text-red-600 text-sm">
              {affiliateFunnelsError}
              <button onClick={fetchAffiliateData} className="text-amber-600 hover:underline">
                Retry
              </button>
            </div>
          )}
          {!affiliateFunnelsLoading && !affiliateFunnelsError && affiliateFunnels.length === 0 && (
            <p className="mt-4 pt-4 border-t border-gray-200 text-gray-500 text-sm">
              No saved funnels. Use the <a href="/affiliate-browser-chat" className="text-amber-600 hover:underline">Affiliate Browser Chat</a> to analyze and save funnels.
            </p>
          )}
        </div>

        {/* Domain & Publish Section */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-gray-500" />
              <label className="text-sm font-medium text-gray-700">Domain:</label>
            </div>
            <input
              type="text"
              value={funnelDomain}
              onChange={(e) => setFunnelDomain(e.target.value)}
              placeholder="myfunnel.com"
              className="flex-1 max-w-xs px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 outline-none"
            />
            <button
              onClick={autoGenerateSlugs}
              disabled={!funnelPages || funnelPages.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-lg hover:bg-amber-200 transition-colors disabled:opacity-50"
            >
              <Link2 className="w-3.5 h-3.5" />
              Auto-Name Steps
            </button>
            {funnelDomain && Object.keys(stepSlugs).length > 0 && (
              <>
                <button
                  onClick={applyLinksToAllSteps}
                  disabled={linkingInProgress}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition-colors disabled:opacity-50"
                >
                  {linkingInProgress ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
                  Apply Links to CTA
                </button>
                <div className="text-xs text-gray-500">
                  {Object.keys(stepSlugs).length} steps mapped
                </div>
              </>
            )}
          </div>
          {funnelDomain && Object.keys(stepSlugs).length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {funnelPages.map((page, i) => {
                const slug = stepSlugs[page.id];
                if (!slug) return null;
                const url = getStepUrl(page.id);
                const nextUrl = getNextStepUrl(page.id);
                return (
                  <div key={page.id} className="flex items-center gap-1.5 px-2 py-1 bg-gray-50 rounded-lg border border-gray-200 text-[11px]">
                    <span className="font-medium text-gray-600">Step {i + 1}:</span>
                    <input
                      type="text"
                      value={slug}
                      onChange={(e) => setStepSlugs(prev => ({ ...prev, [page.id]: e.target.value.replace(/[^a-z0-9-]/g, '') }))}
                      className="w-24 px-1.5 py-0.5 border border-gray-200 rounded text-[11px] focus:ring-1 focus:ring-amber-400 outline-none"
                    />
                    <span className="text-gray-400 truncate max-w-[150px]" title={url}>{url}</span>
                    {nextUrl && (
                      <span className="text-green-600" title={`CTA → ${nextUrl}`}>→ next</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Excel-style Table */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="excel-table text-sm">
              <thead>
                <tr>
                  <th className="w-10 px-2" title="Step order (1 = first page of funnel)">Step</th>
                  <th className="min-w-[120px]">Page</th>
                  <th className="min-w-[100px]">Type</th>
                  <th className="min-w-[120px]">Template</th>
                  <th className="min-w-[180px]">URL</th>
                  <th className="min-w-[140px]">Prompt</th>
                  <th className="min-w-[100px]">Project</th>
                  <th className="w-20">Status</th>
                  <th className="min-w-[120px]">Result</th>
                  <th className="min-w-[100px]">Feedback</th>
                  <th className="w-16">AI</th>
                  <th className="w-32">Actions</th>
                  <th className="w-40">Publish</th>
                </tr>
              </thead>
              <tbody>
                {(funnelPages || []).length === 0 ? (
                  <tr>
                    <td colSpan={12} className="text-center py-8 text-gray-500">
                      No steps. Click &quot;Add Step&quot; to start from Step 1.
                    </td>
                  </tr>
                ) : (
                  (funnelPages || []).map((page, index) => (
                    <tr key={page.id}>
                      {/* Step number (sequential: 1 = first, 2 = second, etc.) */}
                      <td className="text-center text-gray-500 bg-gray-50 font-medium">
                        {index + 1}
                      </td>

                      {/* Page Name */}
                      <td>
                        <DebouncedInput
                          type="text"
                          value={page.name}
                          onChange={(v) =>
                            updateFunnelPage(page.id, { name: v })
                          }
                          className="font-medium truncate"
                        />
                      </td>

                      {/* Page Type */}
                      <td>
                        {newTypeForPageId === page.id ? (
                          <div className="flex items-center gap-1">
                            <input
                              autoFocus
                              type="text"
                              value={newTypeName}
                              onChange={(e) => setNewTypeName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && newTypeName.trim()) {
                                  addCustomPageType(newTypeName.trim());
                                  const slug = newTypeName.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
                                  updateFunnelPage(page.id, { pageType: slug as PageType });
                                  setNewTypeForPageId(null);
                                  setNewTypeName('');
                                } else if (e.key === 'Escape') {
                                  setNewTypeForPageId(null);
                                  setNewTypeName('');
                                }
                              }}
                              placeholder="Type name + Enter"
                              className="w-28 px-1.5 py-0.5 text-xs border border-blue-400 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <button
                              onClick={() => {
                                if (newTypeName.trim()) {
                                  addCustomPageType(newTypeName.trim());
                                  const slug = newTypeName.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
                                  updateFunnelPage(page.id, { pageType: slug as PageType });
                                }
                                setNewTypeForPageId(null);
                                setNewTypeName('');
                              }}
                              className="text-green-600 hover:text-green-800 text-xs font-bold"
                            >✓</button>
                            <button
                              onClick={() => { setNewTypeForPageId(null); setNewTypeName(''); }}
                              className="text-red-500 hover:text-red-700 text-xs font-bold"
                            >✕</button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <select
                              value={page.pageType}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === '__new__') {
                                  setNewTypeForPageId(page.id);
                                  setNewTypeName('');
                                } else {
                                  updateFunnelPage(page.id, { pageType: v as PageType });
                                }
                              }}
                            >
                              {PAGE_TYPE_CATEGORIES.map((category) => {
                                const categoryOptions = groupedPageTypes[category.value] || [];
                                if (categoryOptions.length === 0) return null;
                                return (
                                  <optgroup key={category.value} label={category.label}>
                                    {categoryOptions.map((opt) => (
                                      <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                      </option>
                                    ))}
                                  </optgroup>
                                );
                              })}
                              <option value="__new__">+ New Type...</option>
                            </select>
                          </div>
                        )}
                      </td>

                      {/* Template to Swipe */}
                      <td>
                        <select
                          value={page.templateId || ''}
                          onChange={(e) => {
                            const templateId = e.target.value;
                            const selectedTemplate = (templates || []).find(t => t.id === templateId);
                            updateFunnelPage(page.id, {
                              templateId: templateId || undefined,
                              urlToSwipe: selectedTemplate?.sourceUrl || page.urlToSwipe,
                            });
                          }}
                          className="truncate"
                        >
                          <option value="">Template...</option>
                          {(templates || []).filter(t => (t.category || 'standard') === 'standard').length > 0 && (
                            <optgroup label="📄 Standard Templates">
                              {(templates || [])
                                .filter(t => (t.category || 'standard') === 'standard')
                                .map((template) => (
                                  <option key={template.id} value={template.id}>
                                    {template.name}{template.tags?.length ? ` [${template.tags.join(', ')}]` : ''}
                                  </option>
                                ))}
                            </optgroup>
                          )}
                          {(templates || []).filter(t => t.category === 'quiz').length > 0 && (
                            <optgroup label="❓ Quiz Templates">
                              {(templates || [])
                                .filter(t => t.category === 'quiz')
                                .map((template) => (
                                  <option key={template.id} value={template.id}>
                                    {template.name}{template.tags?.length ? ` [${template.tags.join(', ')}]` : ''}
                                  </option>
                                ))}
                            </optgroup>
                          )}
                        </select>
                      </td>

                      {/* URL to Swipe */}
                      <td>
                        <div className="flex items-center gap-0.5">
                          <DebouncedInput
                            type="url"
                            value={page.urlToSwipe}
                            onChange={(v) =>
                              updateFunnelPage(page.id, {
                                urlToSwipe: v,
                              })
                            }
                            placeholder="https://..."
                            className="flex-1 truncate"
                          />
                          {page.urlToSwipe && (
                            <a
                              href={page.urlToSwipe}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-500 hover:text-blue-700 p-0.5 flex-shrink-0"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                      </td>

                      {/* Prompt */}
                      <td>
                        <div className="flex items-center gap-1">
                          <DebouncedInput
                            type="text"
                            value={page.prompt || ''}
                            onChange={(v) =>
                              updateFunnelPage(page.id, { prompt: v })
                            }
                            placeholder="Instructions..."
                            className="truncate flex-1"
                          />
                          {savedPrompts.length > 0 && (
                            <div className="relative">
                              <button
                                type="button"
                                className="p-1 text-gray-400 hover:text-blue-600 rounded transition-colors shrink-0"
                                title="Select saved prompt"
                                onClick={() => {
                                  const el = document.getElementById(`row-prompt-${page.id}`);
                                  if (el) el.classList.toggle('hidden');
                                }}
                              >
                                <BookOpen className="w-3.5 h-3.5" />
                              </button>
                              <div
                                id={`row-prompt-${page.id}`}
                                className="hidden absolute right-0 top-full mt-1 w-72 max-h-52 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-xl z-50"
                              >
                                {savedPrompts.map(sp => (
                                  <button
                                    key={sp.id}
                                    type="button"
                                    className="w-full text-left px-3 py-2 hover:bg-blue-50 transition-colors border-b border-gray-100 last:border-0"
                                    onClick={() => {
                                      updateFunnelPage(page.id, { prompt: sp.content });
                                      fetch('/api/prompts', {
                                        method: 'PUT',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ id: sp.id, action: 'increment_use' }),
                                      }).catch(() => {});
                                      document.getElementById(`row-prompt-${page.id}`)?.classList.add('hidden');
                                    }}
                                  >
                                    <div className="flex items-center gap-1.5">
                                      {sp.is_favorite && <Star className="w-3 h-3 text-amber-500 shrink-0" fill="currentColor" />}
                                      <span className="text-xs font-medium text-gray-900 truncate">{sp.title}</span>
                                    </div>
                                    <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{sp.content}</p>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Project */}
                      <td>
                        <select
                          value={page.productId}
                          onChange={(e) =>
                            updateFunnelPage(page.id, {
                              productId: e.target.value,
                            })
                          }
                          className="truncate"
                        >
                          <option value="">Project...</option>
                          {(projects || []).map((proj) => (
                            <option key={proj.id} value={proj.id}>
                              {proj.name}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Status */}
                      <td className="text-center">
                        {getStatusBadge(page.swipeStatus)}
                      </td>

                      {/* Swipe Result */}
                      <td>
                        <div className="flex items-center gap-1">
                          {page.swipeStatus === 'completed' && (
                            <CheckCircle className="w-3 h-3 text-green-500 flex-shrink-0" />
                          )}
                          {page.swipeStatus === 'failed' && (
                            <XCircle className="w-3 h-3 text-red-500 flex-shrink-0" />
                          )}
                          <span className="truncate max-w-[80px]" title={page.swipeResult || ''}>
                            {page.swipeResult || '-'}
                          </span>
                          {(page.swipedData || page.clonedData) && (
                            <button
                              onClick={() => {
                                if (page.swipedData) {
                                  setPreviewTab('preview');
                                  setHtmlPreviewModal({
                                    isOpen: true,
                                    title: page.swipedData.newTitle || page.name,
                                    html: page.swipedData.html,
                                    mobileHtml: '',
                                    iframeSrc: '',
                                    metadata: {
                                      method: page.swipedData.methodUsed || 'unknown',
                                      length: page.swipedData.newLength || page.swipedData.html?.length || 0,
                                      duration: page.swipedData.processingTime || 0,
                                    },
                                    pageId: page.id,
                                    sourceType: 'swiped',
                                  });
                                } else if (page.clonedData) {
                                  setPreviewViewport('desktop');
                                  setPreviewTab('preview');
                                  setHtmlPreviewModal({
                                    isOpen: true,
                                    title: page.clonedData!.title || page.name,
                                    html: page.clonedData!.html,
                                    mobileHtml: page.clonedData!.mobileHtml || '',
                                    iframeSrc: '',
                                    metadata: {
                                      method: page.clonedData!.method_used || 'clone',
                                      length: page.clonedData!.content_length || page.clonedData!.html?.length || 0,
                                      duration: page.clonedData!.duration_seconds || 0,
                                    },
                                    pageId: page.id,
                                    sourceType: 'cloned',
                                  });
                                }
                              }}
                              className="p-1 bg-blue-100 text-blue-700 hover:bg-blue-200 rounded"
                              title="Preview"
                            >
                              <Eye className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </td>

                      {/* Feedback */}
                      <td>
                        <div className="flex items-center gap-1">
                          <DebouncedInput
                            type="text"
                            value={page.feedback || ''}
                            onChange={(v) =>
                              updateFunnelPage(page.id, { feedback: v })
                            }
                            placeholder="Feedback..."
                            className="flex-1"
                          />
                          {page.feedback && (
                            <MessageSquare className="w-3 h-3 text-green-500 flex-shrink-0" />
                          )}
                        </div>
                      </td>

                      {/* Analysis Status */}
                      <td className="text-center">
                        {page.analysisStatus ? (
                          <button
                            onClick={() => {
                              if (page.analysisResult) {
                                setAnalysisModal({
                                  isOpen: true,
                                  pageId: page.id,
                                  result: page.analysisResult,
                                  extractedData: page.extractedData || null
                                });
                              }
                            }}
                            className={`px-2 py-1 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 ${
                              page.analysisStatus === 'completed'
                                ? 'bg-purple-100 text-purple-800'
                                : page.analysisStatus === 'failed'
                                ? 'bg-red-100 text-red-800'
                                : page.analysisStatus === 'in_progress'
                                ? 'bg-yellow-100 text-yellow-800'
                                : 'bg-gray-100 text-gray-800'
                            }`}
                          >
                            {page.analysisStatus === 'completed' ? (
                              <span className="flex items-center gap-1">
                                <FileText className="w-3 h-3" />
                                View
                              </span>
                            ) : page.analysisStatus === 'in_progress' ? (
                              <span className="flex items-center gap-1">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                ...
                              </span>
                            ) : page.analysisStatus === 'failed' ? (
                              'Error'
                            ) : (
                              '-'
                            )}
                          </button>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td>
                        <div className="flex items-center gap-1">
                          {/* Clone Button (smooth-responder) */}
                          <button
                            onClick={() => openCloneModal(page)}
                            disabled={
                              cloningIds.includes(page.id) ||
                              !page.urlToSwipe
                            }
                            className={`p-1 rounded transition-colors ${
                              cloningIds.includes(page.id)
                                ? 'bg-amber-100 text-amber-700'
                                : !page.urlToSwipe
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                            }`}
                            title="Clone & Rewrite"
                          >
                            {cloningIds.includes(page.id) ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                          {/* Checkpoint Button — sends this single
                              step to the audit library and jumps to
                              its detail so the user can run it. */}
                          <button
                            onClick={() => handleCheckpointSingle(page.id)}
                            disabled={
                              checkpointingIds.includes(page.id) ||
                              !page.urlToSwipe
                            }
                            className={`p-1 rounded transition-colors ${
                              checkpointingIds.includes(page.id)
                                ? 'bg-emerald-100 text-emerald-700'
                                : !page.urlToSwipe
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                            }`}
                            title="Audita questa pagina nel Checkpoint"
                          >
                            {checkpointingIds.includes(page.id) ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <ShieldCheck className="w-3.5 h-3.5" />
                            )}
                          </button>
                          {/* Delete Button */}
                          <button
                            onClick={() => deleteFunnelPage(page.id)}
                            className="p-1 text-red-500 hover:bg-red-50 rounded"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>

                      {/* Publish */}
                      <td>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handlePublish(page.id, 'repli')}
                            disabled={!!publishingIds[page.id] || (!page.swipedData?.html && !page.clonedData?.html)}
                            className="px-2 py-1 text-[10px] font-semibold rounded bg-blue-100 text-blue-700 hover:bg-blue-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
                            title="Publish to Repli"
                          >
                            {publishingIds[page.id] === 'repli' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" />}
                            Repli
                          </button>
                          <button
                            onClick={() => handlePublish(page.id, 'checkoutchamp')}
                            disabled={!!publishingIds[page.id] || (!page.swipedData?.html && !page.clonedData?.html)}
                            className="px-2 py-1 text-[10px] font-semibold rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
                            title="Publish to CheckoutChamp"
                          >
                            {publishingIds[page.id] === 'checkoutchamp' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                            CC
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Swipe Configuration Modal */}
      {swipeConfigModal.isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-green-600 to-emerald-600">
              <div className="flex items-center gap-3">
                <Settings className="w-6 h-6 text-white" />
                <div>
                  <h2 className="text-xl font-bold text-white">
                    Configure Swipe
                  </h2>
                  <p className="text-white/80 text-sm">
                    {swipeConfigModal.pageName}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSwipeConfigModal({ isOpen: false, pageId: '', pageName: '', url: '' })}
                className="text-white/80 hover:text-white"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="space-y-4">
                {/* URL */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    URL to Swipe
                  </label>
                  <input
                    type="url"
                    value={swipeConfig.url}
                    onChange={(e) => setSwipeConfig({ ...swipeConfig, url: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none"
                    placeholder="https://landing-page.com"
                  />
                </div>

                {/* Prompt */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-gray-700">
                      Custom Prompt (Optional)
                    </label>
                    {savedPrompts.length > 0 && (
                      <div className="relative group">
                        <button
                          type="button"
                          className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition-colors font-medium"
                          onClick={() => {
                            const el = document.getElementById('swipe-prompt-dropdown');
                            if (el) el.classList.toggle('hidden');
                          }}
                        >
                          <BookOpen className="w-3.5 h-3.5" />
                          Use Saved Prompt
                          <ChevronDown className="w-3 h-3" />
                        </button>
                        <div
                          id="swipe-prompt-dropdown"
                          className="hidden absolute right-0 top-full mt-1 w-80 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-xl z-50"
                        >
                          {savedPrompts.map(sp => (
                            <button
                              key={sp.id}
                              type="button"
                              className="w-full text-left px-3 py-2.5 hover:bg-blue-50 transition-colors border-b border-gray-100 last:border-0"
                              onClick={() => {
                                handleSelectSavedPrompt(sp, 'swipe');
                                document.getElementById('swipe-prompt-dropdown')?.classList.add('hidden');
                              }}
                            >
                              <div className="flex items-center gap-2">
                                {sp.is_favorite && <Star className="w-3 h-3 text-amber-500 shrink-0" fill="currentColor" />}
                                <span className="text-sm font-medium text-gray-900 truncate">{sp.title}</span>
                              </div>
                              <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{sp.content}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <textarea
                    value={swipeConfig.prompt || ''}
                    onChange={(e) => setSwipeConfig({ ...swipeConfig, prompt: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none"
                    rows={2}
                    placeholder="Add custom instructions for the AI..."
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {/* Product Name */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Product Name *
                    </label>
                    <input
                      type="text"
                      value={swipeConfig.product_name}
                      onChange={(e) => setSwipeConfig({ ...swipeConfig, product_name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none"
                      placeholder="Your Product"
                    />
                  </div>

                  {/* Brand Name */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Brand Name
                    </label>
                    <input
                      type="text"
                      value={swipeConfig.brand_name}
                      onChange={(e) => setSwipeConfig({ ...swipeConfig, brand_name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none"
                      placeholder="YourBrand"
                    />
                  </div>
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Product Description
                  </label>
                  <textarea
                    value={swipeConfig.product_description}
                    onChange={(e) => setSwipeConfig({ ...swipeConfig, product_description: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none"
                    rows={2}
                    placeholder="Description of your product..."
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {/* CTA Text */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      CTA Text
                    </label>
                    <input
                      type="text"
                      value={swipeConfig.cta_text}
                      onChange={(e) => setSwipeConfig({ ...swipeConfig, cta_text: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none"
                      placeholder="BUY NOW"
                    />
                  </div>

                  {/* Language */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Language
                    </label>
                    <select
                      value={swipeConfig.language}
                      onChange={(e) => setSwipeConfig({ ...swipeConfig, language: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none"
                    >
                      <option value="en">English</option>
                      <option value="it">Italiano</option>
                      <option value="es">Español</option>
                      <option value="fr">Français</option>
                      <option value="de">Deutsch</option>
                    </select>
                  </div>
                </div>

                {/* CTA URL */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    CTA URL
                  </label>
                  <input
                    type="url"
                    value={swipeConfig.cta_url}
                    onChange={(e) => setSwipeConfig({ ...swipeConfig, cta_url: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none"
                    placeholder="https://yoursite.com/checkout"
                  />
                </div>

                {/* Benefits */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Benefits
                  </label>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={benefitInput}
                      onChange={(e) => setBenefitInput(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addBenefit())}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none"
                      placeholder="Add a benefit..."
                    />
                    <button
                      type="button"
                      onClick={addBenefit}
                      className="px-4 py-2 bg-green-100 text-green-700 rounded-lg hover:bg-green-200"
                    >
                      +
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {swipeConfig.benefits.map((benefit, index) => (
                      <span
                        key={index}
                        className="inline-flex items-center gap-1 px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm"
                      >
                        {benefit}
                        <button
                          onClick={() => removeBenefit(index)}
                          className="hover:text-green-600"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    {swipeConfig.benefits.length === 0 && (
                      <span className="text-sm text-gray-400 italic">No benefits added</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-3">
              <button
                onClick={() => setSwipeConfigModal({ isOpen: false, pageId: '', pageName: '', url: '' })}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleLaunchSwipeJob}
                disabled={!swipeConfig.url || !swipeConfig.product_name}
                className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                <Wand2 className="w-4 h-4" />
                Launch Swipe Job
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HTML Preview Modal */}
      {htmlPreviewModal.isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-1">
          <div className="bg-white rounded-xl shadow-2xl w-[98vw] h-[98vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-blue-600 to-cyan-600">
              <div className="flex items-center gap-3">
                <Code className="w-6 h-6 text-white" />
                <div>
                  <h2 className="text-xl font-bold text-white">
                    {htmlPreviewModal.title}
                  </h2>
                  {htmlPreviewModal.metadata && (
                    <p className="text-white/80 text-sm">
                      Method: {htmlPreviewModal.metadata.method} | 
                      {(htmlPreviewModal.metadata.length || 0).toLocaleString()} chars | 
                      {(htmlPreviewModal.metadata.duration || 0).toFixed(2)}s
                    </p>
                  )}
                  {htmlPreviewModal.iframeSrc && (
                    <p className="text-white/80 text-sm">
                      Result from pipeline job
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => { setPreviewTab('preview'); setHtmlPreviewModal({ isOpen: false, title: '', html: '', mobileHtml: '', iframeSrc: '', metadata: null }); }}
                className="text-white/80 hover:text-white text-2xl font-bold"
              >
                ×
              </button>
            </div>

            {/* Modal Body - Tabs */}
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="flex items-center border-b border-gray-200">
                <button
                  onClick={() => {
                    if (previewTab === 'preview') return;
                    // Spinner immediato: il switch html→preview rimonta
                    // l'iframe e ri-esegue doc.write con tutti gli script.
                    setPreviewLoading(true);
                    setPreviewTab('preview');
                  }}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    previewTab === 'preview'
                      ? 'text-blue-600 border-blue-600'
                      : 'text-gray-500 hover:text-gray-700 border-transparent'
                  }`}
                >
                  Preview
                </button>
                {htmlPreviewModal.html && (
                  <button
                    onClick={() => setShowVisualEditor(true)}
                    className="px-4 py-2 text-sm font-medium text-amber-600 hover:text-amber-700 flex items-center gap-1.5 border-b-2 border-transparent hover:border-amber-400 transition-colors"
                  >
                    <Paintbrush className="w-3.5 h-3.5" />
                    Edit Visually
                  </button>
                )}
                {htmlPreviewModal.html && (
                  <button
                    onClick={() => {
                      setEditableHtml(previewViewport === 'mobile' && htmlPreviewModal.mobileHtml
                        ? htmlPreviewModal.mobileHtml : htmlPreviewModal.html);
                      setPreviewTab('html');
                    }}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                      previewTab === 'html'
                        ? 'text-purple-600 border-purple-600'
                        : 'text-gray-500 hover:text-gray-700 border-transparent'
                    }`}
                  >
                    <Code className="w-3.5 h-3.5" />
                    Edit HTML
                  </button>
                )}
                {htmlPreviewModal.html && (
                  <button
                    onClick={() => {
                      const htmlToCopy = previewViewport === 'mobile' && htmlPreviewModal.mobileHtml
                        ? htmlPreviewModal.mobileHtml : htmlPreviewModal.html;
                      navigator.clipboard.writeText(htmlToCopy);
                      alert('HTML copied to clipboard!');
                    }}
                    className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700"
                  >
                    Copy HTML
                  </button>
                )}
                {htmlPreviewModal.iframeSrc && (
                  <a
                    href={htmlPreviewModal.iframeSrc}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 flex items-center gap-1"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Open in new tab
                  </a>
                )}

                {htmlPreviewModal.html && previewTab === 'preview' && (
                  <button
                    onClick={() => {
                      try {
                        previewIframeRef.current?.contentWindow?.postMessage(
                          { __funnelPreviewCmd: 'rerun' },
                          '*'
                        );
                      } catch {}
                    }}
                    className="px-3 py-1.5 ml-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded"
                    title="Re-run init scripts (jQuery/Swiper/FAQ)"
                  >
                    Re-run fallback
                  </button>
                )}

                {previewDiag && previewTab === 'preview' && (
                  <div
                    className={`ml-2 px-2 py-1 rounded text-[11px] font-mono ${
                      previewDiag.swipers === 0 && previewDiag.faqHeaders === 0
                        ? 'bg-red-100 text-red-800'
                        : previewDiag.label === 'after-fallback' || previewDiag.label === 'retry' || previewDiag.label === 'FORCED-OPEN'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-amber-100 text-amber-800'
                    }`}
                    title={`Live diag from preview iframe — fb ${previewDiag.version}`}
                  >
                    {previewDiag.label} · scr={previewDiag.scripts} · faq={previewDiag.faqHeaders} · sw={previewDiag.swipers}/{previewDiag.slides} · th={previewDiag.thumbs} · {previewDiag.version}
                  </div>
                )}

                {/* Desktop/Mobile viewport switcher */}
                {htmlPreviewModal.mobileHtml && (
                  <div className="ml-auto mr-3 flex items-center bg-gray-100 rounded-lg p-0.5 border border-gray-200">
                    <button
                      onClick={() => {
                        if (previewViewport === 'desktop' || previewLoading) return;
                        // Spinner attivo nel render corrente; React batcha le 2
                        // setState in un solo render → iframe ri-monta gia' con
                        // overlay sopra. La doc.write e' deferita (setTimeout 0
                        // nel ref-cb) cosi' il browser disegna spinner+iframe
                        // empty prima del freeze.
                        setPreviewLoading(true);
                        setPreviewViewport('desktop');
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                        previewViewport === 'desktop'
                          ? 'bg-white text-blue-700 shadow-sm border border-blue-200'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <Monitor className="w-3.5 h-3.5" />
                      Desktop
                    </button>
                    <button
                      onClick={() => {
                        if (previewViewport === 'mobile' || previewLoading) return;
                        setPreviewLoading(true);
                        setPreviewViewport('mobile');
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                        previewViewport === 'mobile'
                          ? 'bg-white text-blue-700 shadow-sm border border-blue-200'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <Smartphone className="w-3.5 h-3.5" />
                      Mobile
                    </button>
                  </div>
                )}
              </div>
              
              {/* Preview iframe OR HTML editor */}
              {previewTab === 'html' ? (
                <div className="flex-1 overflow-hidden flex flex-col">
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-800 text-gray-300 text-xs">
                    <span>{editableHtml.length.toLocaleString()} chars</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(editableHtml);
                          alert('HTML copied!');
                        }}
                        className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs"
                      >
                        Copy
                      </button>
                      <button
                        onClick={() => {
                          setPreviewLoading(true);
                          setHtmlPreviewModal(prev => ({ ...prev, html: editableHtml }));
                          setPreviewTab('preview');
                        }}
                        className="px-2 py-1 bg-green-600 hover:bg-green-500 rounded text-xs text-white"
                      >
                        Apply &amp; Preview
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={editableHtml}
                    onChange={(e) => setEditableHtml(e.target.value)}
                    className="flex-1 w-full font-mono text-xs p-3 bg-gray-900 text-green-400 border-0 resize-none focus:outline-none focus:ring-0"
                    spellCheck={false}
                    wrap="off"
                  />
                </div>
              ) : (
                <div className="flex-1 overflow-hidden bg-gray-100 p-2 flex items-start justify-center relative">
                  {previewLoading && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100/80 backdrop-blur-sm pointer-events-none">
                      <div className="flex items-center gap-2 text-gray-600 bg-white px-4 py-2 rounded-lg shadow border border-gray-200">
                        <svg className="animate-spin h-4 w-4 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                        </svg>
                        <span className="text-sm font-medium">Caricamento anteprima…</span>
                      </div>
                    </div>
                  )}
                  <iframe
                    key={`${previewViewport}-${htmlPreviewModal.html?.length || ''}-${htmlPreviewModal.iframeSrc || 'empty'}`}
                    ref={(iframe) => {
                      previewIframeRef.current = iframe;
                      if (!iframe) { previewInitedRef.current = null; return; }
                      // Skip se l'iframe e' gia' stato inizializzato in un render
                      // precedente: il key prop garantisce un nuovo elemento solo
                      // quando cambiano viewport/html/iframeSrc. Senza questo skip
                      // ogni setState del parent rieseguiva doc.write → loop.
                      if (previewInitedRef.current === iframe) return;
                      previewInitedRef.current = iframe;
                      if (htmlPreviewModal.iframeSrc) {
                        iframe.src = htmlPreviewModal.iframeSrc;
                        setPreviewLoading(false);
                      } else {
                        // Difer la doc.write a un macrotask successivo: cosi'
                        // il browser puo' completare il commit React e
                        // disegnare lo spinner overlay PRIMA che la sync
                        // doc.write su HTML grandi blocchi il main thread
                        // (~500-2000ms con scripts pesanti come Swiper, YT,
                        // ipinfo, snowplow). Dopo la doc.close() l'overlay
                        // viene rimosso.
                        setTimeout(() => {
                        const htmlToShow = previewViewport === 'mobile' && htmlPreviewModal.mobileHtml
                          ? htmlPreviewModal.mobileHtml : htmlPreviewModal.html;
                        if (htmlToShow) {
                          const doc = iframe.contentDocument || iframe.contentWindow?.document;
                          if (doc) {
                            doc.open();
                            let safeHtml = htmlToShow;
                            if (!safeHtml.includes('name="referrer"')) {
                              const refTag = '<meta name="referrer" content="no-referrer">';
                              safeHtml = safeHtml.includes('<head>') ? safeHtml.replace('<head>', '<head>' + refTag) : refTag + safeHtml;
                            }
                            safeHtml = safeHtml.replace(/loading=["']lazy["']/gi, 'loading="eager"');
                            // Strip vecchi fallback bake-ati nell'HTML (server-v1 aveva
                            // un click-delegate FAQ troppo aggressivo che killava le CTA).
                            // Riapplichiamo SEMPRE il fallback client v5+ qui sotto.
                            safeHtml = safeHtml.replace(/<script\b[^>]*data-fallback=[^>]*>[\s\S]*?<\/script>/gi, '');
                            safeHtml = safeHtml.replace(/<style\b[^>]*data-fallback=[^>]*>[\s\S]*?<\/style>/gi, '');
                            // Strip <li> vuoti orfani (punti senza testo) che certi builder
                            // lasciano per spaziatura. Loop finche stabile.
                            {
                              const emptyLiRe = /<li\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?\s*>|<(?:span|i|b|em|strong|small|font|p)\b[^>]*>\s*(?:&nbsp;|&#160;)?\s*<\/(?:span|i|b|em|strong|small|font|p)>)*\s*<\/li>/gi;
                              let prev = '';
                              let guard = 0;
                              while (safeHtml !== prev && guard < 4) {
                                prev = safeHtml;
                                safeHtml = safeHtml.replace(emptyLiRe, '');
                                guard++;
                              }
                            }
                            // Fallback init: rende interattiva la pagina clonata anche se gli
                            // <script> originali sono stati strippati a monte. Carica
                            // jQuery+Swiper dal CDN se mancano, inizializza Swiper, lega
                            // click thumb→main image, FAQ accordion, sticky CTA. Mostra
                            // anche un HUD di stato visibile dentro l'iframe e ascolta
                            // postMessage 'rerun-fallback' dal parent per ri-eseguire.
                            const fallbackInit = `
<script>(function(){
  var FB_VERSION = 'v5-2026-05-05';
  var STATE = { jq:false, sw:false, lastError:null, fired:0 };
  function postDiag(label){
    try{
      var s=document.scripts.length;
      var fq=document.querySelectorAll('.faq .faq-header,.faq-header,.faq-question,.accordion-header,[data-faq-toggle]').length;
      var sw=document.querySelectorAll('.swiper').length;
      var sl=document.querySelectorAll('.swiper-slide').length;
      var tb=document.querySelectorAll('.thumbImage img, .swiper-thumbs img').length;
      var msg={__funnelPreviewDiag:true,label:label,scripts:s,faqHeaders:fq,swipers:sw,slides:sl,thumbs:tb,jq:STATE.jq,swLib:STATE.sw,lastError:STATE.lastError,version:FB_VERSION};
      try{ (window.parent||window).postMessage(msg,'*'); }catch(_){}
      console.log('[preview]',label,JSON.stringify({v:FB_VERSION,s:s,fq:fq,sw:sw,sl:sl,tb:tb,jq:STATE.jq,swLib:STATE.sw}));
      paintHud(label, fq, sw, sl, tb);
    }catch(e){STATE.lastError=String(e);}
  }
  function forceOpenAllFaqs(){
    try{
      var n=0;
      document.querySelectorAll('.faq, .faq-wrapper, .faq-item, .accordion-item, details').forEach(function(p){
        p.classList.remove('fb-collapsed');
        p.classList.add('active','open','expanded','is-open','show');
        if(p.tagName==='DETAILS') p.setAttribute('open','');
        n++;
      });
      // Brutal: rimuove anche eventuali style inline display:none ai content
      document.querySelectorAll('.faq-content, .faq-content-wrapper, .faq-body, .faq-answer, .accordion-content, .accordion-body').forEach(function(c){
        c.style.removeProperty('display');
        c.style.removeProperty('max-height');
        c.style.removeProperty('height');
        c.removeAttribute('hidden');
      });
      console.log('[preview] force-opened',n,'FAQs (removed .fb-collapsed)');
      try{ (window.parent||window).postMessage({__funnelPreviewClick:true,target:'forceOpen',contents:n,newOpen:true},'*'); }catch(_){}
      paintHud('FORCED-OPEN', document.querySelectorAll('.faq-header').length, document.querySelectorAll('.swiper').length, document.querySelectorAll('.swiper-slide').length, document.querySelectorAll('.thumbImage img,.swiper-thumbs img').length);
    }catch(e){STATE.lastError='forceOpen:'+String(e);}
  }
  function paintHud(label, fq, sw, sl, tb){
    try{
      var h=document.getElementById('__fnHud');
      if(!h){
        h=document.createElement('div');
        h.id='__fnHud';
        h.style.cssText='position:fixed;top:8px;right:8px;z-index:2147483647;background:rgba(0,0,0,.85);color:#fff;font:12px/1.3 system-ui,sans-serif;padding:8px 12px;border-radius:6px;pointer-events:auto;max-width:360px;box-shadow:0 4px 14px rgba(0,0,0,.4)';
        (document.body||document.documentElement).appendChild(h);
      }
      var color = STATE.lastError ? '#ff7676' : (STATE.sw && fq>0 ? '#7ce58a' : '#ffd166');
      h.innerHTML='<div style="font-weight:700;color:'+color+'">FB '+label+' <span style="float:right;font-weight:400;font-size:10px;opacity:.7">'+FB_VERSION+'</span></div>'+
        '<div>jq='+STATE.jq+' Swiper='+STATE.sw+'</div>'+
        '<div>faq='+fq+' swiper='+sw+' slide='+sl+' thumb='+tb+'</div>'+
        (STATE.lastError?'<div style="color:#ff7676;word-break:break-all;margin-top:4px">'+STATE.lastError+'</div>':'')+
        '<div style="margin-top:6px;display:flex;gap:6px"><button id="__fnHudOpen" style="flex:1;padding:4px 8px;background:#3b82f6;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:11px">Open all FAQs</button><button id="__fnHudClose" style="padding:4px 8px;background:#666;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:11px">×</button></div>';
      var bOpen=document.getElementById('__fnHudOpen');
      if(bOpen) bOpen.addEventListener('click',function(ev){ ev.stopPropagation(); forceOpenAllFaqs(); });
      var bClose=document.getElementById('__fnHudClose');
      if(bClose) bClose.addEventListener('click',function(ev){ ev.stopPropagation(); h.remove(); });
    }catch(e){}
  }
  window.addEventListener('error',function(ev){ STATE.lastError = (ev.message||'err')+' @ '+(ev.filename||'?')+':'+(ev.lineno||0); });
  window.addEventListener('unhandledrejection',function(ev){ STATE.lastError = 'rej:'+(ev.reason && ev.reason.message || ev.reason || 'unknown'); });
  function loadCss(href){
    if(document.querySelector('link[data-fb-css="'+href+'"]'))return;
    var l=document.createElement('link'); l.rel='stylesheet'; l.href=href; l.dataset.fbCss=href; document.head.appendChild(l);
  }
  function loadScript(src,cb){
    var existing=document.querySelector('script[data-fb-src="'+src+'"]');
    if(existing){ if(existing.__loaded){cb();} else { existing.addEventListener('load',cb); existing.addEventListener('error',cb); } return; }
    var s=document.createElement('script'); s.src=src; s.async=false; s.dataset.fbSrc=src;
    s.addEventListener('load',function(){s.__loaded=true; cb();});
    s.addEventListener('error',function(){ STATE.lastError='loadFail:'+src; cb(); });
    (document.head||document.documentElement).appendChild(s);
  }
  function findFaqParent(header){
    return header.closest('.faq,.faq-wrapper,.faq-item,.accordion-item,[data-faq],details') || header.parentElement;
  }
  function toggleFaqContent(header){
    var p = findFaqParent(header);
    if(!p) return;
    // FAQ aperte di default: toggle = add/remove .fb-collapsed
    var willCollapse = !p.classList.contains('fb-collapsed');
    if(willCollapse){
      p.classList.add('fb-collapsed');
      p.classList.remove('active','open','expanded','is-open','show');
      if(p.tagName==='DETAILS') p.removeAttribute('open');
    } else {
      p.classList.remove('fb-collapsed');
      p.classList.add('active','open','expanded','is-open','show');
      if(p.tagName==='DETAILS') p.setAttribute('open','');
    }
    header.setAttribute('aria-expanded', willCollapse?'false':'true');
    var icon = header.querySelector('.faq-icon, .accordion-icon, svg');
    if(icon){ if(willCollapse) icon.classList.remove('fb-icon-rotated'); else icon.classList.add('fb-icon-rotated'); }
    try{
      (window.parent||window).postMessage({__funnelPreviewClick:true,target:'faq',headerText:(header.textContent||'').trim().slice(0,40),collapsed:willCollapse,parentClass:p.className.slice(0,80)},'*');
    }catch(_){}
  }
  function activateFaq(){
    try{
      // STRATEGIA 1: bind diretto sui selettori noti
      var sels=[
        '.faq-header','.faq-question','.faq-title',
        '.accordion-header','.accordion-question','.accordion-toggle','.accordion-button',
        '[data-faq-toggle]','[data-toggle="collapse"]','[data-bs-toggle="collapse"]',
        'details > summary'
      ];
      var bound=0;
      sels.forEach(function(sel){
        document.querySelectorAll(sel).forEach(function(h){
          if(h.__faqBound)return; h.__faqBound=true; bound++;
          h.style.cursor='pointer';
        });
      });
      // STRATEGIA 2: click delegate GLOBAL — SOLO su header espliciti.
      // ATTENZIONE: NON usiamo più il fallback "click in .faq → toggle primo
      // header" perché matchava CTA/link/bottoni dentro sezioni FAQ-like e
      // killava i click utente (preventDefault). Inoltre saltiamo se il click
      // è su un <a>/<button>/<input> per non rompere navigazione e form.
      if(!document.body.__faqDelegateBound){
        document.body.__faqDelegateBound = true;
        document.body.addEventListener('click', function(ev){
          var t = ev.target;
          if(!t || !t.closest) return;
          var actionable = t.closest('a,button,input,select,textarea,label,[role="button"],[onclick]');
          var header = t.closest('.faq-header,.faq-question,.faq-title,.accordion-header,.accordion-question,.accordion-toggle,.accordion-button,[data-faq-toggle],[data-toggle="collapse"],[data-bs-toggle="collapse"],summary');
          if(!header) return;
          // Se l'header contiene un <a>/<button> e l'utente ha cliccato proprio
          // su quello, lasciamo passare (potrebbe essere un link reale).
          if(actionable && header.contains(actionable) && actionable !== header) return;
          ev.preventDefault();
          ev.stopPropagation();
          try{ toggleFaqContent(header); }catch(e){ STATE.lastError='faqDel:'+String(e); }
        }, true);
      }
      console.log('[preview] FAQ headers bound:', bound, '+ global delegate active');
    }catch(e){STATE.lastError='faq:'+String(e);}
  }
  function activateSwiper(){
    try{
      if(typeof window.Swiper!=='function'){ return false; }
      STATE.sw=true;
      var initialized=0;
      // 1. Init thumb swipers per primi (servono come riferimento ai main)
      var thumbsInstances=[];
      document.querySelectorAll('.swiper.thumbImage, .swiper.swiper-thumbs').forEach(function(el){
        if(el.swiper||el.__swiperBound)return; el.__swiperBound=true;
        try{
          var inst=new window.Swiper(el,{
            slidesPerView:'auto', spaceBetween:10, watchSlidesProgress:true, freeMode:true,
            slideToClickedSlide:true
          });
          thumbsInstances.push(inst); initialized++;
        }catch(e){STATE.lastError='thumbInit:'+String(e);}
      });
      // 2. Init main swiper e collega thumbs
      var mainSwipers=[];
      document.querySelectorAll('.swiper.mainImage').forEach(function(el){
        if(el.swiper||el.__swiperBound)return; el.__swiperBound=true;
        var opts={
          slidesPerView:1, spaceBetween:10,
          navigation:{ nextEl: el.querySelector('.swiper-button-next')||document.querySelector('.swiper-button-next'), prevEl: el.querySelector('.swiper-button-prev')||document.querySelector('.swiper-button-prev') },
          pagination:{ el: el.querySelector('.swiper-pagination'), clickable:true }
        };
        if(thumbsInstances[0]) opts.thumbs={ swiper: thumbsInstances[0] };
        try{ var ms=new window.Swiper(el,opts); mainSwipers.push(ms); initialized++; }
        catch(e){STATE.lastError='mainInit:'+String(e);}
      });
      // 3. Init resto degli swiper (announcement bar, generici)
      document.querySelectorAll('.swiper').forEach(function(el){
        if(el.swiper||el.__swiperBound)return; el.__swiperBound=true;
        var isAnnouncement=el.classList.contains('announcement_bar');
        var opts={
          slidesPerView:1, spaceBetween:10, loop:isAnnouncement, autoplay: isAnnouncement?{delay:3500}:false,
          navigation:{ nextEl: el.querySelector('.swiper-button-next'), prevEl: el.querySelector('.swiper-button-prev') },
          pagination:{ el: el.querySelector('.swiper-pagination'), clickable:true }
        };
        try{ new window.Swiper(el,opts); initialized++; }catch(e){STATE.lastError='swInit:'+String(e);}
      });
      // 4. Brutal click handler: ogni thumb-slide chiama slideTo sul main swiper
      //    (Swiper.thumbs a volte non si attacca se il DOM cambia post-init)
      var firstMain = mainSwipers[0] || (document.querySelector('.swiper.mainImage') && document.querySelector('.swiper.mainImage').swiper);
      document.querySelectorAll('.swiper.thumbImage .swiper-slide, .swiper.swiper-thumbs .swiper-slide').forEach(function(slide,idx){
        if(slide.__thumbClickBound)return; slide.__thumbClickBound=true;
        slide.style.cursor='pointer';
        slide.addEventListener('click',function(){
          if(firstMain && typeof firstMain.slideTo==='function'){ firstMain.slideTo(idx); }
          // fallback img copy comunque
          var img = slide.querySelector('img');
          if(img){
            var src=img.currentSrc||img.src||img.getAttribute('data-src');
            var main = document.querySelector('.swiper.mainImage .swiper-slide-active img, .swiper.mainImage img:not(.thumb), .mainImage img, .product-image img');
            if(main && src){ main.src=src; main.removeAttribute('srcset'); }
          }
        });
      });
      return initialized>0;
    }catch(e){STATE.lastError='sw:'+String(e); return false;}
  }
  function activateThumbs(){
    try{
      // Click delegate global sui thumbnail. Resiliente al fatto che il DOM
      // possa cambiare dopo init Swiper.
      if(!document.body.__thumbDelegateBound){
        document.body.__thumbDelegateBound = true;
        document.body.addEventListener('click', function(ev){
          var t = ev.target;
          if(!t || !t.closest) return;
          var thumbContainer = t.closest('.thumbImage, .swiper-thumbs, [data-thumb-container]');
          if(!thumbContainer) return;
          // Trova il "thumb item" cliccato (slide o img)
          var thumbItem = t.closest('.swiper-slide, [data-thumb], img');
          if(!thumbItem) return;
          // Indice del thumb nella sua lista
          var siblings = Array.prototype.slice.call(thumbContainer.querySelectorAll('.swiper-slide, [data-thumb]'));
          if(siblings.length===0){
            // No swiper-slide? Lista di img
            siblings = Array.prototype.slice.call(thumbContainer.querySelectorAll('img'));
          }
          var idx = siblings.indexOf(thumbItem);
          if(idx<0){
            // Trova l'antenato che è in siblings
            var p=thumbItem;
            while(p && idx<0){ idx = siblings.indexOf(p); p = p.parentElement; }
          }
          // 1. Prova ad usare il main Swiper se esiste
          var mainEl = document.querySelector('.swiper.mainImage');
          if(mainEl && mainEl.swiper && idx>=0){
            try{ mainEl.swiper.slideTo(idx); }catch(_){}
          }
          // 2. Fallback puro: copia src dal thumb-img al main-img
          var thumbImg = thumbItem.tagName==='IMG' ? thumbItem : thumbItem.querySelector('img');
          if(thumbImg){
            var src = thumbImg.currentSrc || thumbImg.src || thumbImg.getAttribute('data-src');
            if(src){
              var mainImg = document.querySelector('.swiper.mainImage .swiper-slide-active img, .swiper.mainImage .swiper-slide img, .mainImage img:not(.thumb), .product-image img, [data-main-image] img');
              if(mainImg){ mainImg.src = src; mainImg.removeAttribute('srcset'); }
            }
          }
          try{
            (window.parent||window).postMessage({__funnelPreviewClick:true,target:'thumb',idx:idx,siblings:siblings.length},'*');
          }catch(_){}
        }, true);
      }
    }catch(e){STATE.lastError='thumbs:'+String(e);}
  }
  function activateStickyShow(){
    try{ document.querySelectorAll('.stickSection').forEach(function(s){ s.style.display=''; s.style.visibility='visible'; }); }catch(e){}
  }
  function bootstrap(){
    STATE.fired++;
    postDiag('boot');
    STATE.jq = typeof window.jQuery!=='undefined';
    STATE.sw = typeof window.Swiper==='function';
    loadCss('https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css');
    var pending=0; function done(){ if(--pending<=0) finalize(); }
    if(!STATE.jq){ pending++; loadScript('https://code.jquery.com/jquery-3.5.1.min.js',function(){STATE.jq=typeof window.jQuery!=='undefined'; done();}); }
    if(!STATE.sw){ pending++; loadScript('https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js',function(){STATE.sw=typeof window.Swiper==='function'; done();}); }
    if(pending===0) finalize();
  }
  function finalize(){
    postDiag('libs-ready');
    activateFaq();
    activateSwiper();
    activateThumbs();
    activateStickyShow();
    postDiag('ready');
    // Una sola retry silenziosa dopo 1.5s per coprire DOM tardivo. Non
    // ripostiamo diag così l'HUD resta su 'ready' e l'utente non pensa
    // che siamo in loop.
    setTimeout(function(){ activateSwiper(); activateThumbs(); activateStickyShow(); }, 1500);
  }
  window.addEventListener('message',function(ev){
    var d=ev.data;
    if(d && typeof d==='object' && d.__funnelPreviewCmd==='rerun'){
      console.log('[preview] rerun cmd received'); bootstrap();
    }
  });
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded',bootstrap); } else { setTimeout(bootstrap,50); }
})();<\/script>
`;
                            // Skip client-side fallback se l'HTML server-side
                            // ha già il suo (server-v1+). Evita doppia iniezione.
                            const hasServerFallback = /data-fallback="server-v\d+"/i.test(safeHtml) || /__FB_FALLBACK_INSTALLED/.test(safeHtml);
                            if (!hasServerFallback) {
                              // Job vecchio salvato prima della migration server-side:
                              // strippiamo gli script originali Vue/Funnelish ZOMBIE
                              // (montano a metà, lasciano la pagina inerte) e
                              // iniettiamo il fallback client.
                              const scriptCountBefore = (safeHtml.match(/<script\b/gi) || []).length;
                              if (scriptCountBefore > 1) {
                                safeHtml = safeHtml.replace(/<script\b(?![^>]*data-fallback=)[^>]*>[\s\S]*?<\/script>/gi, '');
                                safeHtml = safeHtml.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
                                safeHtml = safeHtml.replace(/\s+on[a-z]+="[^"]*"/gi, '');
                                safeHtml = safeHtml.replace(/\s+on[a-z]+='[^']*'/gi, '');
                              }
                              // Inietta CSS hard-override: FAQ aperte di default,
                              // .fb-collapsed le richiude (toggle inverso). Sticky CTA
                              // sempre visibile.
                              const fbStyleClient = `<style data-fallback="client-v5-style">html body .faq .faq-content-wrapper,html body .faq .faq-content,html body .faq-wrapper .faq-content-wrapper,html body .faq-wrapper .faq-content,html body .faq-item .faq-body,html body .faq-item .faq-answer,html body .accordion-item .accordion-content,html body .accordion-item .accordion-body,html body .accordion-item .accordion-collapse,html body details > *:not(summary){display:block !important;max-height:none !important;height:auto !important;min-height:0 !important;overflow:visible !important;visibility:visible !important;opacity:1 !important;transform:none !important;pointer-events:auto !important;}html body .faq.fb-collapsed .faq-content-wrapper,html body .faq.fb-collapsed .faq-content,html body .faq-wrapper.fb-collapsed .faq-content-wrapper,html body .faq-wrapper.fb-collapsed .faq-content,html body .faq-item.fb-collapsed .faq-body,html body .faq-item.fb-collapsed .faq-answer,html body .accordion-item.fb-collapsed .accordion-content,html body .accordion-item.fb-collapsed .accordion-body{display:none !important;}.faq-header,.faq-question,.faq-title,.accordion-header,.accordion-button,.accordion-question,.accordion-toggle,summary{cursor:pointer !important;}.fb-icon-rotated{transform:rotate(180deg) !important;transition:transform .2s !important;}html body .stickSection{display:block !important;visibility:visible !important;opacity:1 !important;}</style>`;
                              if (!/data-fallback=".*style"/i.test(safeHtml)) {
                                if (safeHtml.includes('</head>')) {
                                  safeHtml = safeHtml.replace('</head>', fbStyleClient + '</head>');
                                } else if (safeHtml.includes('<body')) {
                                  safeHtml = safeHtml.replace(/(<body[^>]*>)/, fbStyleClient + '$1');
                                }
                              }
                              if (safeHtml.includes('</body>')) {
                                safeHtml = safeHtml.replace('</body>', fallbackInit + '</body>');
                              } else {
                                safeHtml = safeHtml + fallbackInit;
                              }
                            }
                            doc.write(safeHtml);
                            doc.close();
                          }
                        }
                        setPreviewLoading(false);
                        }, 0);
                      }
                    }}
                    className={`bg-white rounded border border-gray-300 transition-all duration-300 ${
                      previewViewport === 'mobile' && htmlPreviewModal.mobileHtml
                        ? 'w-[390px] h-full shadow-xl border-2 border-gray-400 rounded-[2rem]'
                        : 'w-full h-full'
                    }`}
                    title="HTML Preview"
                    allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                  />
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-2">
              {htmlPreviewModal.html && (
                <button
                  onClick={() => setShowVisualEditor(true)}
                  className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors flex items-center gap-2 mr-auto"
                >
                  <Paintbrush className="w-4 h-4" />
                  Edit Visually
                </button>
              )}
              {htmlPreviewModal.html && (
                <button
                  onClick={() => {
                    const newWin = window.open('', '_blank');
                    if (newWin) {
                      newWin.document.open();
                      newWin.document.write(htmlPreviewModal.html);
                      newWin.document.close();
                    }
                  }}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors flex items-center gap-2"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open in New Window
                </button>
              )}
              {htmlPreviewModal.html && (
                <button
                  onClick={() => {
                    const blob = new Blob([htmlPreviewModal.html], { type: 'text/html' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${htmlPreviewModal.title.replace(/[^a-z0-9]/gi, '_')}.html`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Download HTML
                </button>
              )}
              <button
                onClick={() => { setPreviewTab('preview'); setHtmlPreviewModal({ isOpen: false, title: '', html: '', mobileHtml: '', iframeSrc: '', metadata: null }); }}
                className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Analysis Modal */}
      {analysisModal.isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-purple-600 to-blue-600">
              <div className="flex items-center gap-3">
                <FileText className="w-6 h-6 text-white" />
                <h2 className="text-xl font-bold text-white">
                  Funnel Step Analysis
                </h2>
              </div>
              <button
                onClick={() => setAnalysisModal({ isOpen: false, pageId: '', result: null, extractedData: null })}
                className="text-white/80 hover:text-white text-2xl font-bold"
              >
                ×
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Extracted Data */}
              {analysisModal.extractedData && (
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                  <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                    <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs">EXTRACTED</span>
                    Page Data
                  </h3>
                  <div className="space-y-3 text-sm">
                    {analysisModal.extractedData.headline && (
                      <div>
                        <span className="font-medium text-gray-700">Headline:</span>
                        <p className="text-gray-900 mt-1">&quot;{analysisModal.extractedData.headline}&quot;</p>
                      </div>
                    )}
                    {analysisModal.extractedData.subheadline && (
                      <div>
                        <span className="font-medium text-gray-700">Subheadline:</span>
                        <p className="text-gray-600 mt-1">{analysisModal.extractedData.subheadline}</p>
                      </div>
                    )}
                    {analysisModal.extractedData.cta && analysisModal.extractedData.cta.length > 0 && (
                      <div>
                        <span className="font-medium text-gray-700">CTA:</span>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {analysisModal.extractedData.cta.slice(0, 5).map((cta, i) => (
                            <span key={i} className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs">
                              {cta}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {analysisModal.extractedData.price && (
                      <div>
                        <span className="font-medium text-gray-700">Price:</span>
                        <span className="ml-2 bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-sm font-bold">
                          {analysisModal.extractedData.price}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Analysis Result */}
              <div className="bg-white rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <span className="bg-purple-100 text-purple-700 px-2 py-0.5 rounded text-xs">AI</span>
                  Analysis Result
                </h3>
                <div className="prose prose-sm max-w-none">
                  <pre className="whitespace-pre-wrap text-gray-700 text-sm leading-relaxed font-sans bg-gray-50 p-4 rounded-lg">
                    {analysisModal.result}
                  </pre>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end">
              <button
                onClick={() => setAnalysisModal({ isOpen: false, pageId: '', result: null, extractedData: null })}
                className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Vision Analysis Modal */}
      {visionModal.isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-purple-600 to-indigo-600">
              <div className="flex items-center gap-3">
                <ImageIcon className="w-6 h-6 text-white" />
                <div>
                  <h2 className="text-xl font-bold text-white">
                    AI Vision Analysis
                  </h2>
                  <p className="text-white/80 text-sm truncate max-w-md">
                    {visionModal.pageName} - {visionModal.sourceUrl}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => fetchVisionJobs(visionModal.sourceUrl)}
                  className="p-2 text-white/80 hover:text-white hover:bg-white/20 rounded-lg transition-colors"
                  title="Refresh"
                >
                  <RefreshCw className={`w-5 h-5 ${visionLoading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => {
                    setVisionModal({ isOpen: false, pageId: '', pageName: '', sourceUrl: '' });
                    setSelectedVisionJob(null);
                    setVisionJobs([]);
                    setVisionError(null);
                  }}
                  className="text-white/80 hover:text-white text-2xl font-bold px-2"
                >
                  ×
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6">
              {/* Loading State */}
              {visionLoading && !selectedVisionJob && (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="w-12 h-12 text-purple-500 animate-spin mb-4" />
                  <p className="text-gray-600">Loading vision analysis...</p>
                </div>
              )}

              {/* Error State */}
              {visionError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                  <div className="flex items-center gap-2 text-red-700">
                    <XCircle className="w-5 h-5" />
                    <span className="font-medium">Error</span>
                  </div>
                  <p className="text-red-600 mt-1">{visionError}</p>
                </div>
              )}

              {/* No Jobs Found */}
              {!visionLoading && !visionError && visionJobs.length === 0 && (
                <div className="text-center py-12">
                  <ImageIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">No analysis found</h3>
                  <p className="text-gray-500">
                    No vision analysis found for this page.
                    <br />
                    Launch a swipe job first to generate the analysis.
                  </p>
                </div>
              )}

              {/* Jobs List */}
              {visionJobs.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">
                    Available analyses ({visionJobs.length})
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {visionJobs.map((job) => (
                      <button
                        key={job.id}
                        onClick={() => fetchVisionJobDetail(job.id)}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
                          selectedVisionJob?.id === job.id
                            ? 'bg-purple-600 text-white'
                            : job.status === 'completed'
                            ? 'bg-purple-100 text-purple-700 hover:bg-purple-200'
                            : job.status === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {job.status === 'completed' ? (
                          <CheckCircle className="w-4 h-4" />
                        ) : job.status === 'failed' ? (
                          <XCircle className="w-4 h-4" />
                        ) : (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        )}
                        <span>{new Date(job.created_at).toLocaleString('en-US', { 
                          day: '2-digit', 
                          month: '2-digit', 
                          hour: '2-digit', 
                          minute: '2-digit' 
                        })}</span>
                        {job.total_sections_detected > 0 && (
                          <span className="bg-white/50 px-1.5 py-0.5 rounded text-xs">
                            {job.total_sections_detected} sections
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Selected Job Details */}
              {selectedVisionJob && (
                <div className="space-y-6">
                  {/* Screenshot Preview */}
                  {selectedVisionJob.screenshot_url && (
                    <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                      <h4 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
                        <Eye className="w-4 h-4" />
                        Page Screenshot
                      </h4>
                      <div className="relative rounded-lg overflow-hidden border border-gray-300 bg-white">
                        <img
                          src={selectedVisionJob.screenshot_url}
                          alt="Page screenshot"
                          className="w-full h-auto max-h-[400px] object-contain"
                        />
                      </div>
                    </div>
                  )}

                  {/* Page Structure Overview */}
                  {selectedVisionJob.page_structure && (
                    <div className="bg-indigo-50 rounded-lg p-4 border border-indigo-200">
                      <h4 className="font-medium text-indigo-900 mb-3 flex items-center gap-2">
                        <Layers className="w-4 h-4" />
                        Page Structure
                      </h4>
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                        {Object.entries(selectedVisionJob.page_structure).map(([key, value]) => (
                          <div key={key} className="bg-white rounded-lg p-3 text-center">
                            <div className={`text-lg font-bold ${
                              typeof value === 'boolean' 
                                ? value ? 'text-green-600' : 'text-gray-400'
                                : 'text-indigo-600'
                            }`}>
                              {typeof value === 'boolean' ? (value ? '✓' : '✗') : value}
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              {key.replace(/_/g, ' ').replace(/has /i, '')}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Sections Analysis */}
                  {selectedVisionJob.sections && selectedVisionJob.sections.length > 0 && (
                    <div className="bg-white rounded-lg border border-gray-200">
                      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                        <h4 className="font-medium text-gray-900 flex items-center gap-2">
                          <Layers className="w-4 h-4 text-purple-500" />
                          Detected Sections ({selectedVisionJob.sections.length})
                        </h4>
                        <button
                          onClick={() => setExpandedSections(
                            expandedSections.length === selectedVisionJob.sections.length
                              ? []
                              : selectedVisionJob.sections.map((_, i) => i)
                          )}
                          className="text-sm text-purple-600 hover:text-purple-800"
                        >
                          {expandedSections.length === selectedVisionJob.sections.length 
                            ? 'Collapse all' 
                            : 'Expand all'}
                        </button>
                      </div>
                      <div className="divide-y divide-gray-100">
                        {selectedVisionJob.sections.map((section, idx) => (
                          <div key={idx} className="p-4">
                            <button
                              onClick={() => toggleSectionExpanded(idx)}
                              className="w-full flex items-center justify-between text-left"
                            >
                              <div className="flex items-center gap-3">
                                <span className="w-8 h-8 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-sm font-bold">
                                  {section.section_index + 1}
                                </span>
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${getSectionTypeColor(section.section_type_hint)}`}>
                                  {section.section_type_hint}
                                </span>
                                {section.has_cta && (
                                  <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-xs font-medium">
                                    CTA
                                  </span>
                                )}
                                <span className="text-sm text-gray-500">
                                  Confidence: {Math.round(section.confidence * 100)}%
                                </span>
                              </div>
                              {expandedSections.includes(idx) ? (
                                <ChevronUp className="w-5 h-5 text-gray-400" />
                              ) : (
                                <ChevronDown className="w-5 h-5 text-gray-400" />
                              )}
                            </button>
                            
                            {expandedSections.includes(idx) && (
                              <div className="mt-3 ml-11 space-y-2">
                                {section.text_preview && (
                                  <div className="bg-gray-50 rounded-lg p-3">
                                    <p className="text-xs text-gray-500 mb-1">Text Preview</p>
                                    <p className="text-sm text-gray-700">{section.text_preview}</p>
                                  </div>
                                )}
                                {section.bounding_box && (
                                  <div className="text-xs text-gray-500">
                                    Position: x={section.bounding_box.x}, y={section.bounding_box.y}, 
                                    {section.bounding_box.width}x{section.bounding_box.height}px
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Images Analysis */}
                  {selectedVisionJob.images && selectedVisionJob.images.length > 0 && (
                    <div className="bg-white rounded-lg border border-gray-200">
                      <div className="px-4 py-3 border-b border-gray-200">
                        <h4 className="font-medium text-gray-900 flex items-center gap-2">
                          <ImageIcon className="w-4 h-4 text-blue-500" />
                          Analyzed Images ({selectedVisionJob.images.length})
                        </h4>
                      </div>
                      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                        {selectedVisionJob.images.map((img, idx) => (
                          <div key={idx} className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                            <div className="flex items-start gap-3">
                              <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                                <ImageIcon className="w-5 h-5 text-blue-600" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <span className="inline-block px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-medium mb-2">
                                  {img.image_type}
                                </span>
                                <p className="text-sm text-gray-700 mb-2">{img.description}</p>
                                {img.suggestion && (
                                  <div className="flex items-start gap-2 bg-yellow-50 rounded-lg p-2 border border-yellow-200">
                                    <Lightbulb className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
                                    <p className="text-xs text-yellow-800">{img.suggestion}</p>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recommendations */}
                  {selectedVisionJob.recommendations && selectedVisionJob.recommendations.length > 0 && (
                    <div className="bg-green-50 rounded-lg p-4 border border-green-200">
                      <h4 className="font-medium text-green-900 mb-3 flex items-center gap-2">
                        <Lightbulb className="w-4 h-4" />
                        AI Recommendations
                      </h4>
                      <ul className="space-y-2">
                        {selectedVisionJob.recommendations.map((rec, idx) => (
                          <li key={idx} className="flex items-start gap-2">
                            <span className="w-5 h-5 rounded-full bg-green-200 text-green-800 flex items-center justify-center text-xs font-bold flex-shrink-0">
                              {idx + 1}
                            </span>
                            <p className="text-sm text-green-800">{rec}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Raw Analysis */}
                  {selectedVisionJob.raw_analysis && (
                    <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                      <h4 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
                        <Code className="w-4 h-4" />
                        Complete Analysis (Raw)
                      </h4>
                      <pre className="text-xs text-gray-600 whitespace-pre-wrap font-mono bg-white p-4 rounded-lg border border-gray-200 max-h-[300px] overflow-y-auto">
                        {selectedVisionJob.raw_analysis}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
              <div className="text-sm text-gray-500">
                {selectedVisionJob && (
                  <>
                    Job ID: <code className="bg-gray-200 px-1 rounded">{selectedVisionJob.id.slice(0, 8)}...</code>
                    {selectedVisionJob.completed_at && (
                      <span className="ml-3">
                        Completed: {new Date(selectedVisionJob.completed_at).toLocaleString('en-US')}
                      </span>
                    )}
                  </>
                )}
              </div>
              <button
                onClick={() => {
                  setVisionModal({ isOpen: false, pageId: '', pageName: '', sourceUrl: '' });
                  setSelectedVisionJob(null);
                  setVisionJobs([]);
                  setVisionError(null);
                }}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cinematic full-screen overlay during Swipe All / single rewrite.
          Replaces the old tiny "Rewriting texts..." toast in the bottom-right
          corner with a real live view: page list with status, iframe preview
          of the page being rewritten, scrolling activity log, ETA + cancel. */}
      <SwipeCinemaOverlay
        swipeAll={swipeAllJob}
        cloneProgress={cloneProgress}
        cloneTargetPageName={cloneModal.pageName || cloneModal.url || ''}
        pages={(funnelPages || []).map<SwipePageInfo>((p) => ({
          id: p.id,
          name: p.name,
          pageType: p.pageType,
          url: p.urlToSwipe,
          swipeStatus: p.swipeStatus as SwipePageInfo['swipeStatus'],
          clonedHtml: p.clonedData?.html || p.swipedData?.html,
        }))}
        log={swipeLog as OverlayLogEntry[]}
        rewrites={rewriteStream}
        onCancel={() => {
          if (swipeAllJob?.isRunning) cancelSwipeAll();
        }}
        onClose={() => {
          if (!swipeAllJob?.isRunning && !cloneProgress) {
            setSwipeAllJob(null);
          }
        }}
      />

      {/* Clone Configuration Modal */}
      {cloneModal.isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-amber-500 to-orange-500">
              <div className="flex items-center gap-3">
                <Copy className="w-6 h-6 text-white" />
                <div>
                  <h2 className="text-xl font-bold text-white">Clone & Rewrite</h2>
                  <p className="text-white/80 text-sm truncate max-w-sm">{cloneModal.url}</p>
                </div>
              </div>
              <button
                onClick={() => setCloneModal({ isOpen: false, pageId: '', pageName: '', url: '' })}
                className="text-white/80 hover:text-white"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Mode Tabs */}
            <div className="flex border-b border-gray-200">
              <button
                onClick={() => setCloneMode('identical')}
                className={`flex-1 px-4 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  cloneMode === 'identical'
                    ? 'text-amber-700 border-b-2 border-amber-500 bg-amber-50'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Copy className="w-4 h-4" />
                Identical Clone
              </button>
              <button
                onClick={() => setCloneMode('rewrite')}
                className={`flex-1 px-4 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  cloneMode === 'rewrite'
                    ? 'text-amber-700 border-b-2 border-amber-500 bg-amber-50'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Wand2 className="w-4 h-4" />
                Rewrite for Product
              </button>
              <button
                onClick={() => setCloneMode('translate')}
                className={`flex-1 px-4 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  cloneMode === 'translate'
                    ? 'text-amber-700 border-b-2 border-amber-500 bg-amber-50'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Globe className="w-4 h-4" />
                Translate
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6">
              {/* Identical Mode */}
              {cloneMode === 'identical' && (
                <div className="text-center py-8">
                  <Copy className="w-16 h-16 text-amber-400 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">Identical Clone</h3>
                  <p className="text-gray-500 mb-4">
                    Download the exact HTML of the page without modifications.
                    <br />
                    Useful for analyzing the structure and as a base for subsequent rewrites.
                  </p>
                  <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 break-all mb-4">
                    {cloneModal.url}
                  </div>

                  {/* Mobile clone toggle */}
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-left max-w-md mx-auto">
                    <label className="flex items-center justify-between cursor-pointer group">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-blue-100 group-hover:bg-blue-200 transition-colors">
                          <Smartphone className="w-5 h-5 text-blue-600" />
                        </div>
                        <div>
                          <span className="text-sm font-semibold text-gray-900 block">Include Mobile version</span>
                          <span className="text-xs text-gray-500">Also clone the mobile version (viewport 390x844)</span>
                        </div>
                      </div>
                      <div className="relative">
                        <input
                          type="checkbox"
                          checked={cloneMobile}
                          onChange={(e) => setCloneMobile(e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:border-gray-300 after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                      </div>
                    </label>
                    {cloneMobile && (
                      <div className="mt-3 flex items-center gap-2 text-xs text-blue-600 bg-blue-100 rounded-lg px-3 py-2">
                        <Monitor className="w-3.5 h-3.5 shrink-0" />
                        <span>Desktop (1440x900)</span>
                        <span className="text-blue-400">+</span>
                        <Smartphone className="w-3.5 h-3.5 shrink-0" />
                        <span>Mobile (390x844 iPhone)</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Rewrite Mode */}
              {cloneMode === 'rewrite' && (
                <div className="space-y-4">
                  {(() => {
                    const modalPage = (funnelPages || []).find(p => p.id === cloneModal.pageId);
                    const quiz = modalPage && isQuizPage(modalPage);
                    return quiz ? (
                      <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 text-sm text-purple-800 flex items-center gap-2">
                        <Sparkles className="w-4 h-4 shrink-0" />
                        <span><strong>Quiz detected!</strong> JavaScript will be kept intact. Texts are rewritten for your product while the quiz logic and design stay identical.</span>
                      </div>
                    ) : (
                      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                        The HTML structure of the page is kept identical. Only the texts are rewritten by Claude AI for your product.
                      </div>
                    );
                  })()}

                  {/* What Claude will receive — transparency panel */}
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900">
                    <div className="font-semibold mb-1.5 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" /> Sent to Claude on Rewrite
                    </div>
                    <ul className="space-y-0.5">
                      <li>
                        <span className="font-medium">Knowledge base:</span>{' '}
                        <span className="text-emerald-700">
                          ON (cached) · COS, Tony Flores, Evaldo, Anghelache, Savage, 108 split tests
                        </span>
                      </li>
                      <li>
                        <span className="font-medium">Project brief:</span>{' '}
                        {cloneConfig.brief ? (
                          <span className="text-emerald-700">
                            {cloneConfig.brief.length.toLocaleString()} chars
                          </span>
                        ) : (
                          <span className="text-amber-700">—  add it in My Projects → Brief</span>
                        )}
                      </li>
                      <li>
                        <span className="font-medium">Market research:</span>{' '}
                        {cloneConfig.marketResearch ? (
                          <span className="text-emerald-700">
                            {cloneConfig.marketResearch.length.toLocaleString()} chars
                          </span>
                        ) : (
                          <span className="text-amber-700">—  add it in My Projects → Market Research</span>
                        )}
                      </li>
                    </ul>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Product Name *</label>
                      <input
                        type="text"
                        value={cloneConfig.productName}
                        onChange={(e) => setCloneConfig({ ...cloneConfig, productName: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
                        placeholder="E.g.: SuperGlow Serum"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Framework</label>
                      <select
                        value={cloneConfig.framework}
                        onChange={(e) => setCloneConfig({ ...cloneConfig, framework: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
                      >
                        <option value="">None</option>
                        <option value="AIDA">AIDA (Attention-Interest-Desire-Action)</option>
                        <option value="PAS">PAS (Problem-Agitate-Solve)</option>
                        <option value="BAB">BAB (Before-After-Bridge)</option>
                        <option value="4Ps">4Ps (Promise-Picture-Proof-Push)</option>
                        <option value="QUEST">QUEST (Qualify-Understand-Educate-Stimulate-Transition)</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Product Description *</label>
                    <textarea
                      value={cloneConfig.productDescription}
                      onChange={(e) => setCloneConfig({ ...cloneConfig, productDescription: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
                      rows={3}
                      placeholder="Describe your product, its benefits and features..."
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Target Audience</label>
                    <input
                      type="text"
                      value={cloneConfig.target}
                      onChange={(e) => setCloneConfig({ ...cloneConfig, target: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
                      placeholder="E.g.: Women 30-50 interested in skincare"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-sm font-medium text-gray-700">Custom Instructions (optional)</label>
                      {savedPrompts.length > 0 && (
                        <div className="relative">
                          <button
                            type="button"
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-100 transition-colors font-medium"
                            onClick={() => {
                              const el = document.getElementById('clone-prompt-dropdown');
                              if (el) el.classList.toggle('hidden');
                            }}
                          >
                            <BookOpen className="w-3.5 h-3.5" />
                            Use Saved Prompt
                            <ChevronDown className="w-3 h-3" />
                          </button>
                          <div
                            id="clone-prompt-dropdown"
                            className="hidden absolute right-0 top-full mt-1 w-80 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-xl z-50"
                          >
                            {savedPrompts.map(sp => (
                              <button
                                key={sp.id}
                                type="button"
                                className="w-full text-left px-3 py-2.5 hover:bg-amber-50 transition-colors border-b border-gray-100 last:border-0"
                                onClick={() => {
                                  handleSelectSavedPrompt(sp, 'clone');
                                  document.getElementById('clone-prompt-dropdown')?.classList.add('hidden');
                                }}
                              >
                                <div className="flex items-center gap-2">
                                  {sp.is_favorite && <Star className="w-3 h-3 text-amber-500 shrink-0" fill="currentColor" />}
                                  <span className="text-sm font-medium text-gray-900 truncate">{sp.title}</span>
                                </div>
                                <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{sp.content}</p>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <textarea
                      value={cloneConfig.customPrompt}
                      onChange={(e) => setCloneConfig({ ...cloneConfig, customPrompt: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
                      rows={2}
                      placeholder="E.g.: Luxurious but accessible tone, in English..."
                    />
                  </div>

                  <div className="bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-lg p-3">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cloneConfig.useOpenClaw}
                        onChange={(e) => setCloneConfig({ ...cloneConfig, useOpenClaw: e.target.checked })}
                        className="mt-1 w-4 h-4 text-purple-600 rounded focus:ring-2 focus:ring-purple-500"
                      />
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-purple-900">Use OpenClaw (local bot) instead of Claude</div>
                        <div className="text-xs text-purple-700 mt-0.5">
                          Routes the rewrite through your local OpenClaw via the Supabase queue. Requires <code className="bg-purple-100 px-1 rounded">openclaw-worker.js</code> running on your PC.
                        </div>
                      </div>
                    </label>
                  </div>
                </div>
              )}

              {/* Translate Mode */}
              {cloneMode === 'translate' && (
                <div className="space-y-4">
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
                    Translates all text in the cloned or rewritten HTML into another language.
                    You need to clone the page first (Identical Clone or Rewrite).
                  </div>

                  {(() => {
                    const page = (funnelPages || []).find(p => p.id === cloneModal.pageId);
                    const hasHtml = page?.clonedData?.html || page?.swipedData?.html;
                    return hasHtml ? (
                      <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800 flex items-center gap-2">
                        <CheckCircle className="w-4 h-4" />
                        HTML available ({((page?.swipedData?.html || page?.clonedData?.html)?.length || 0).toLocaleString()} chars)
                      </div>
                    ) : (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-center gap-2">
                        <XCircle className="w-4 h-4" />
                        No HTML available. Clone the page first.
                      </div>
                    );
                  })()}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Target Language</label>
                    <select
                      value={cloneConfig.targetLanguage}
                      onChange={(e) => setCloneConfig({ ...cloneConfig, targetLanguage: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
                    >
                      <option value="Italian">Italian (Italiano)</option>
                      <option value="English">English</option>
                      <option value="Spanish">Spanish (Español)</option>
                      <option value="French">French (Français)</option>
                      <option value="German">German (Deutsch)</option>
                      <option value="Portuguese">Portuguese (Português)</option>
                      <option value="Dutch">Dutch (Nederlands)</option>
                      <option value="Polish">Polish (Polski)</option>
                      <option value="Romanian">Romanian (Română)</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-3">
              <button
                onClick={() => setCloneModal({ isOpen: false, pageId: '', pageName: '', url: '' })}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleClone}
                disabled={
                  (cloneMode === 'rewrite' && (!cloneConfig.productName || !cloneConfig.productDescription)) ||
                  (cloneMode === 'translate' && !(() => {
                    const page = (funnelPages || []).find(p => p.id === cloneModal.pageId);
                    return page?.clonedData?.html || page?.swipedData?.html;
                  })())
                }
                className="flex items-center gap-2 px-6 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                {cloneMode === 'identical' && <><Copy className="w-4 h-4" /> Clone</>}
                {cloneMode === 'rewrite' && (() => {
                  const mp = (funnelPages || []).find(p => p.id === cloneModal.pageId);
                  const isQ = mp && isQuizPage(mp);
                  return isQ
                    ? <><Sparkles className="w-4 h-4" /> Quiz Rewrite (keep JS)</>
                    : <><Wand2 className="w-4 h-4" /> Clone &amp; Rewrite</>;
                })()}
                {cloneMode === 'translate' && <><Globe className="w-4 h-4" /> Translate</>}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ═══ Quiz Preview Modal ═══ */}
      {quizPreviewOpen && quizPreviewHtml && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[95vh] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-gray-200 bg-gradient-to-r from-violet-50 to-purple-50 px-6 py-4 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100">
                  <Sparkles className="w-5 h-5 text-violet-600" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-bold text-gray-900 truncate">
                    Generated Quiz — {quizPreviewStats?.funnelName}
                  </h3>
                  <p className="text-xs text-gray-500">
                    {quizPreviewStats?.totalSteps} total steps &middot;{' '}
                    {quizPreviewStats?.quizQuestions} questions &middot;{' '}
                    {((quizPreviewStats?.htmlSize ?? 0) / 1024).toFixed(1)} KB
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleDownloadQuizHtml}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors shadow-sm"
                >
                  <Download className="w-4 h-4" />
                  Download HTML
                </button>
                <button
                  onClick={handleGenerateQuiz}
                  disabled={quizGenerating}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
                >
                  {quizGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  Regenerate
                </button>
                <button
                  onClick={() => setQuizPreviewOpen(false)}
                  className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Quiz Preview Iframe */}
            <div className="flex-1 overflow-hidden bg-gray-100 p-2">
              <iframe
                srcDoc={quizPreviewHtml}
                className="w-full h-full border-0 rounded-lg bg-white shadow-inner"
                title="Quiz Preview"
                sandbox="allow-scripts allow-same-origin allow-forms"
              />
            </div>

            {/* Modal Footer */}
            <div className="border-t border-gray-200 bg-gray-50 px-6 py-3 flex items-center justify-between shrink-0">
              <p className="text-xs text-gray-500">
                Generated from funnel structure + original branding via Gemini Vision + Claude AI
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    if (quizPreviewHtml) {
                      const win = window.open('', '_blank');
                      if (win) {
                        win.document.write(quizPreviewHtml);
                        win.document.close();
                      }
                    }
                  }}
                  className="text-xs text-violet-600 hover:text-violet-800 hover:underline flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" />
                  Open in new tab
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Visual HTML Editor */}
      {showVisualEditor && htmlPreviewModal.html && (() => {
        // Risolve il Project legato alla pagina aperta nell'editor.
        // Serve per pre-compilare il prompt di "Swipe for Product" sui video
        // (e in futuro su altri media) con nome, descrizione e brief reali.
        const editorPage = htmlPreviewModal.pageId
          ? (funnelPages || []).find(p => p.id === htmlPreviewModal.pageId)
          : null;
        const editorProject = editorPage
          ? (projects || []).find(p => p.id === editorPage.productId)
          : null;
        return (
        <VisualHtmlEditor
          initialHtml={htmlPreviewModal.html}
          initialMobileHtml={htmlPreviewModal.mobileHtml || undefined}
          pageTitle={htmlPreviewModal.title || 'Edit Landing'}
          productContext={editorProject ? {
            name: editorProject.name,
            description: editorProject.description || '',
            brief: editorProject.brief || '',
            imageUrl:
              (Array.isArray(editorProject.logo) && editorProject.logo[0]?.url) ||
              '',
          } : undefined}
          onSave={(html, mobileHtml) => {
            setHtmlPreviewModal(prev => ({ ...prev, html, mobileHtml: mobileHtml || prev.mobileHtml }));

            if (htmlPreviewModal.pageId) {
              const pid = htmlPreviewModal.pageId;
              const page = (funnelPages || []).find(p => p.id === pid);
              if (page) {
                if (htmlPreviewModal.sourceType === 'swiped' && page.swipedData) {
                  updateFunnelPage(pid, {
                    swipedData: { ...page.swipedData, html, newLength: html.length },
                  });
                } else if (page.clonedData) {
                  updateFunnelPage(pid, {
                    clonedData: {
                      ...page.clonedData,
                      html,
                      mobileHtml: mobileHtml || page.clonedData.mobileHtml,
                      content_length: html.length,
                    },
                  });
                }
              }
            }
          }}
          onClose={() => setShowVisualEditor(false)}
        />
        );
      })()}
      {/* Save Funnel Modal */}
      {showSaveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-1">Save Funnel</h3>
            <p className="text-sm text-gray-500 mb-4">
              Save {funnelPages?.length || 0} steps to archive. Each page will be organized by type.
            </p>
            <input
              type="text"
              value={saveFunnelName}
              onChange={(e) => setSaveFunnelName(e.target.value)}
              placeholder="Funnel name..."
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && saveFunnelName.trim()) {
                  e.preventDefault();
                  setIsSaving(true);
                  saveCurrentFunnelAsArchive(saveFunnelName.trim())
                    .then(() => { setShowSaveModal(false); setIsSaving(false); })
                    .catch(() => { setIsSaving(false); alert('Error saving'); });
                }
              }}
            />
            <div className="flex justify-end gap-3 mt-5">
              <button
                onClick={() => setShowSaveModal(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
                disabled={isSaving}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!saveFunnelName.trim()) return;
                  setIsSaving(true);
                  saveCurrentFunnelAsArchive(saveFunnelName.trim())
                    .then(() => { setShowSaveModal(false); setIsSaving(false); })
                    .catch(() => { setIsSaving(false); alert('Error saving'); });
                }}
                disabled={!saveFunnelName.trim() || isSaving}
                className="px-5 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {isSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
