'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import { fetchAffiliateSavedFunnels } from '@/lib/supabase-operations';
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
 * Client-side rewrite via OpenClaw using direct Supabase queue polling.
 * Bypasses Vercel's 60s serverless timeout by polling from the browser.
 */
async function rewriteWithOpenClawFromBrowser(args: {
  html: string;
  productName: string;
  productDescription: string;
  customPrompt?: string;
  onProgress?: (batchesDone: number, batchesTotal: number) => void;
}): Promise<{ html: string; replacements: number; totalTexts: number; originalLength: number; newLength: number; provider: string }> {
  const { html, productName, productDescription, customPrompt, onProgress } = args;
  const { supabase } = await import('@/lib/supabase');

  // 1. Extract texts server-side via the existing route (fast: <5s)
  const extractRes = await fetch('/api/quiz-rewrite/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });
  if (!extractRes.ok) {
    const t = await extractRes.text();
    throw new Error(`Extract failed: ${t.substring(0, 200)}`);
  }
  const { texts, systemPrompt } = await extractRes.json() as {
    texts: Array<{ original: string; tag: string }>;
    systemPrompt: string;
  };

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
    const { data, error } = await supabase
      .from('openclaw_messages')
      .insert({
        user_message: batchPrompt,
        system_prompt: effectiveSystem,
        section: 'Quiz Rewrite',
        status: 'pending',
      })
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
      // Quiz: remove entire <noscript> blocks (tags + content) — they show
      // "Activate JavaScript" messages that are misleading in the preview
      clean = clean.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
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
    products,
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

  // Save Funnel Modal
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveFunnelName, setSaveFunnelName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // API Mode
  const [apiMode, setApiMode] = useState<ApiMode>('localDev');
  const api = API_ENDPOINTS[apiMode];

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
  });
  const [cloningIds, setCloningIds] = useState<string[]>([]);
  const [cloneProgress, setCloneProgress] = useState<{
    phase: string;
    totalTexts: number;
    processedTexts: number;
    message: string;
  } | null>(null);

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

  // Bulk product selection for all rows
  const handleBulkProductChange = useCallback((productId: string) => {
    if (!productId) return;
    for (const page of funnelPages) {
      updateFunnelPage(page.id, { productId });
    }
  }, [funnelPages, updateFunnelPage]);

  const handleUseAffiliateStepForSwipe = (step: AffiliateFunnelStep, funnelName: string) => {
    const stepType = step.step_type || 'landing';
    const pageType: PageType = STEP_TYPE_TO_PAGE_TYPE[stepType] || 'landing';

    addFunnelPage({
      name: step.title
        ? `${funnelName} - Step ${step.step_index}: ${step.title}`.slice(0, 80)
        : `${funnelName} - Step ${step.step_index}`,
      pageType,
      productId: products[0]?.id || '',
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

        const page = (funnelPages || []).find(p => p.id === pageId);
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
  }, [api, funnelPages, updateFunnelPage]);

  // Polling effect
  useEffect(() => {
    if (activeJobs.length === 0) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    pollingRef.current = setInterval(async () => {
      for (const job of activeJobs) {
        if (job.status === 'pending' || job.status === 'running') {
          await pollJobStatus(job.jobId, job.pageId);
        }
      }
    }, 5000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [activeJobs, pollJobStatus]);

  const handleAddPage = () => {
    const stepNum = (funnelPages || []).length + 1;
    addFunnelPage({
      name: `Step ${stepNum}`,
      pageType: 'landing',
      productId: products[0]?.id || '',
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
    const productNames = (products || []).map(p => p.name);

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

      const resolveProduct = (raw: string): string => {
        if (!raw) return products[0]?.id || '';
        const lower = raw.toLowerCase().trim();
        const exact = products.find(p => p.name.toLowerCase() === lower);
        if (exact) return exact.id;
        const partial = products.find(p => p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase()));
        if (partial) return partial.id;
        return products[0]?.id || '';
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

  // Open swipe config modal
  const openSwipeConfig = (page: typeof funnelPages[0]) => {
    const product = (products || []).find(p => p.id === page.productId);
    
    setSwipeConfig({
      url: page.urlToSwipe,
      product_name: product?.name || '',
      product_description: product?.description || '',
      cta_text: product?.ctaText || 'BUY NOW',
      cta_url: product?.ctaUrl || '',
      language: 'en',
      benefits: product?.benefits || [],
      brand_name: product?.brandName || '',
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

  const isQuizPage = (page: { pageType: string; urlToSwipe: string }) => {
    if (page.pageType === 'quiz_funnel') return true;
    const urlLower = (page.urlToSwipe || '').toLowerCase();
    return QUIZ_URL_PATTERNS.some(p => urlLower.includes(p));
  };

  // Clone via smooth-responder Edge Function
  const openCloneModal = (page: typeof funnelPages[0]) => {
    const product = (products || []).find(p => p.id === page.productId);
    setCloneConfig({
      productName: product?.name || '',
      productDescription: product?.description || '',
      framework: '',
      target: '',
      customPrompt: page.prompt || '',
      language: 'it',
      targetLanguage: 'Italiano',
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

  const handleClone = async () => {
    const pageId = cloneModal.pageId;
    const url = cloneModal.url;
    const pageName = cloneModal.pageName;
    const mode = cloneMode;

    setCloneModal({ isOpen: false, pageId: '', pageName: '', url: '' });
    setCloningIds(prev => [...prev, pageId]);

    const currentPage = (funnelPages || []).find(p => p.id === pageId);
    const pageIsQuiz = currentPage && isQuizPage(currentPage);

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
          body: JSON.stringify({ url, cloneMode: 'identical', viewport: cloneMobile ? 'both' : 'desktop', keepScripts: pageIsQuiz }),
        });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || 'Clone failed');

        if (data.warning) {
          console.warn('⚠️ Clone warning:', data.warning);
        }

        const clonedHtml = sanitizeClonedHtml(data.content, url, { keepScripts: pageIsQuiz });
        const clonedMobileHtml = data.mobileContent ? sanitizeClonedHtml(data.mobileContent, url, { keepScripts: pageIsQuiz }) : '';
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

        // If no HTML exists, first clone the page to get it
        if (!htmlToRewrite) {
          setCloneProgress({ phase: 'extract', totalTexts: 0, processedTexts: 0, message: 'Cloning page first...' });
          const cloneRes = await fetch('/api/clone-funnel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, cloneMode: 'identical', viewport: 'desktop', keepScripts: pageIsQuiz }),
          });
          const cloneData = await cloneRes.json();
          if (!cloneRes.ok || cloneData.error) throw new Error(cloneData.error || 'Clone failed — cannot rewrite without HTML');
          htmlToRewrite = sanitizeClonedHtml(cloneData.content, url, { keepScripts: pageIsQuiz });

          updateFunnelPage(pageId, {
            clonedData: {
              html: htmlToRewrite,
              title: cloneData.title || pageName,
              clonedAt: new Date(),
              method: 'identical',
            },
          });
        }

        setCloneProgress({ phase: 'processing', totalTexts: 0, processedTexts: 0, message: cloneConfig.useOpenClaw ? 'Rewriting texts with OpenClaw (local)...' : 'Trinity sta riscrivendo...' });

        let rewriteData: { html: string; replacements: number; totalTexts: number; originalLength?: number; newLength?: number; provider?: string; error?: string };

        if (cloneConfig.useOpenClaw) {
          rewriteData = await rewriteWithOpenClawFromBrowser({
            html: htmlToRewrite,
            productName: cloneConfig.productName,
            productDescription: cloneConfig.productDescription,
            customPrompt: cloneConfig.customPrompt || undefined,
            onProgress: (done, total) => setCloneProgress({ phase: 'processing', totalTexts: total, processedTexts: done, message: `Rewriting via OpenClaw (${done}/${total} batches)...` }),
          });
        } else {
          // Async rewrite via Supabase queue (avoids Netlify 10s timeout)
          setCloneProgress({ phase: 'processing', totalTexts: 0, processedTexts: 0, message: 'Trinity sta riscrivendo...' });

          // Step 1: Enqueue the job (returns immediately with jobId)
          const enqueueRes = await fetch('/api/quiz-rewrite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              html: htmlToRewrite,
              productName: cloneConfig.productName,
              productDescription: cloneConfig.productDescription,
              customPrompt: cloneConfig.customPrompt || undefined,
            }),
          });
          const enqueueData = await enqueueRes.json() as { jobId?: string; status?: string; totalTexts?: number; error?: string };
          if (!enqueueRes.ok || enqueueData.error) throw new Error(enqueueData.error || 'Failed to start rewrite job');
          if (!enqueueData.jobId) throw new Error('No jobId returned from rewrite API');

          const { jobId, totalTexts: jobTotalTexts } = enqueueData;
          setCloneProgress({ phase: 'processing', totalTexts: jobTotalTexts || 0, processedTexts: 0, message: `Trinity sta riscrivendo... (job: ${jobId.substring(0, 8)})` });

          // Step 2: Poll status endpoint until completed or timeout (5 minutes)
          const POLL_INTERVAL_MS = 3000;
          const MAX_WAIT_MS = 5 * 60 * 1000;
          const pollStart = Date.now();
          let pollResult: { html: string; replacements: number; totalTexts: number; originalLength: number; newLength: number; provider: string } | null = null;

          while (!pollResult) {
            if (Date.now() - pollStart > MAX_WAIT_MS) {
              throw new Error('Rewrite timeout dopo 5 minuti. Controlla che openclaw-worker.js sia in esecuzione.');
            }
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

            const statusRes = await fetch(`/api/quiz-rewrite/status/${jobId}`);
            const statusData = await statusRes.json() as { status: string; result?: typeof pollResult; error?: string };

            if (statusData.status === 'completed' && statusData.result) {
              pollResult = statusData.result;
            } else if (statusData.status === 'error') {
              throw new Error(statusData.error || 'Rewrite job failed');
            } else {
              // Still pending/processing — update progress message
              const elapsed = Math.round((Date.now() - pollStart) / 1000);
              setCloneProgress({ phase: 'processing', totalTexts: jobTotalTexts || 0, processedTexts: 0, message: `Trinity sta riscrivendo... (${elapsed}s)` });
            }
          }

          rewriteData = pollResult;
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
        const translatedHtml = sanitizeClonedHtml(data.content, url, { keepScripts: pageIsQuiz });
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
              {/* Bulk Product Selector */}
              {(funnelPages || []).length > 0 && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <Target className="w-4 h-4 text-amber-600" />
                  <span className="text-sm font-medium text-amber-800 whitespace-nowrap">Product for all:</span>
                  <select
                    value=""
                    onChange={(e) => handleBulkProductChange(e.target.value)}
                    className="min-w-[160px] px-2 py-1 border border-amber-300 rounded-md text-sm bg-white focus:ring-2 focus:ring-amber-400 focus:border-amber-400"
                  >
                    <option value="">— Select —</option>
                    {(products || []).map((prod) => (
                      <option key={prod.id} value={prod.id}>
                        {prod.name}
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
                  <th className="min-w-[100px]">Product</th>
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

                      {/* Product */}
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
                          <option value="">Product...</option>
                          {(products || []).map((prod) => (
                            <option key={prod.id} value={prod.id}>
                              {prod.name}
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
                  onClick={() => setPreviewTab('preview')}
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

                {/* Desktop/Mobile viewport switcher */}
                {htmlPreviewModal.mobileHtml && (
                  <div className="ml-auto mr-3 flex items-center bg-gray-100 rounded-lg p-0.5 border border-gray-200">
                    <button
                      onClick={() => setPreviewViewport('desktop')}
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
                      onClick={() => setPreviewViewport('mobile')}
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
                <div className="flex-1 overflow-hidden bg-gray-100 p-2 flex items-start justify-center">
                  <iframe
                    key={`${previewViewport}-${htmlPreviewModal.html?.length || ''}-${htmlPreviewModal.iframeSrc || 'empty'}`}
                    ref={(iframe) => {
                      if (!iframe) return;
                      if (htmlPreviewModal.iframeSrc) {
                        iframe.src = htmlPreviewModal.iframeSrc;
                      } else {
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
                            doc.write(safeHtml);
                            doc.close();
                          }
                        }
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

      {/* Clone Progress Floating Indicator */}
      {cloneProgress && (
        <div className="fixed bottom-6 right-6 z-40 bg-white rounded-xl shadow-2xl border border-amber-200 p-4 w-80">
          <div className="flex items-center gap-3 mb-3">
            <Loader2 className="w-5 h-5 text-amber-600 animate-spin" />
            <span className="font-medium text-gray-900">
              {cloneProgress.phase === 'extract' ? 'Extracting texts...' :
               cloneProgress.phase === 'translating' ? 'Translating...' :
               'Rewriting texts...'}
            </span>
          </div>
          <div className="text-sm text-gray-600 mb-2">{cloneProgress.message}</div>
          {cloneProgress.totalTexts > 0 && (
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-500 transition-all duration-500"
                style={{ width: `${Math.round((cloneProgress.processedTexts / cloneProgress.totalTexts) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

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
      {showVisualEditor && htmlPreviewModal.html && (
        <VisualHtmlEditor
          initialHtml={htmlPreviewModal.html}
          initialMobileHtml={htmlPreviewModal.mobileHtml || undefined}
          pageTitle={htmlPreviewModal.title || 'Edit Landing'}
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
      )}
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
