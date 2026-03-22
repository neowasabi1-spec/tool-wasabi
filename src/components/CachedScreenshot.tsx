'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Globe, Loader2, RefreshCw } from 'lucide-react';

const CACHE_PREFIX = 'sc_';
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days
const MAX_CONCURRENT = 3;
const MAX_RETRIES = 2;
const RETRY_DELAY = 8000; // mshots needs time to generate

let activeRequests = 0;
const queue: (() => void)[] = [];

function processQueue() {
  while (activeRequests < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift();
    if (next) next();
  }
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url.slice(0, 30);
  }
}

function getColorFromUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = url.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 45%, 65%)`;
}

function loadFromCache(url: string): string | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + url);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) {
      localStorage.removeItem(CACHE_PREFIX + url);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveToCache(url: string, dataUrl: string) {
  try {
    localStorage.setItem(
      CACHE_PREFIX + url,
      JSON.stringify({ data: dataUrl, ts: Date.now() })
    );
  } catch {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.slice(0, Math.ceil(keysToRemove.length / 2)).forEach(k => localStorage.removeItem(k));
    try {
      localStorage.setItem(
        CACHE_PREFIX + url,
        JSON.stringify({ data: dataUrl, ts: Date.now() })
      );
    } catch { /* still full, skip */ }
  }
}

async function fetchAndCompress(url: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/thumbnail?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size < 500) return null;

    const img = new Image();
    const objectUrl = URL.createObjectURL(blob);

    return new Promise<string | null>((resolve) => {
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 300;
        canvas.height = 200;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, 300, 200);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
        URL.revokeObjectURL(objectUrl);
        resolve(dataUrl);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(null);
      };
      img.src = objectUrl;
    });
  } catch {
    return null;
  }
}

interface CachedScreenshotProps {
  url: string;
  alt?: string;
  className?: string;
  height?: string;
}

export default function CachedScreenshot({ url, alt = '', className = '', height = '180px' }: CachedScreenshotProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const fetchedRef = useRef(false);
  const retriesRef = useRef(0);

  const attemptFetch = useCallback((isRetry = false) => {
    const doFetch = () => {
      activeRequests++;
      setLoading(true);
      setFailed(false);
      fetchAndCompress(url).then((dataUrl) => {
        activeRequests--;
        if (dataUrl) {
          setLoading(false);
          saveToCache(url, dataUrl);
          setSrc(dataUrl);
        } else if (retriesRef.current < MAX_RETRIES) {
          retriesRef.current++;
          // Retry after delay (mshots queues the render on first request)
          setTimeout(() => {
            doFetch();
          }, RETRY_DELAY * retriesRef.current);
          return; // don't process queue yet, we're retrying
        } else {
          setLoading(false);
          setFailed(true);
        }
        processQueue();
      });
    };

    if (isRetry) {
      retriesRef.current = 0;
      if (activeRequests >= MAX_CONCURRENT) {
        queue.push(doFetch);
      } else {
        doFetch();
      }
      return;
    }

    if (activeRequests >= MAX_CONCURRENT) {
      queue.push(doFetch);
    } else {
      doFetch();
    }
  }, [url]);

  useEffect(() => {
    if (!url) return;

    const cached = loadFromCache(url);
    if (cached) {
      setSrc(cached);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !fetchedRef.current) {
          fetchedRef.current = true;
          observer.disconnect();
          attemptFetch();
        }
      },
      { rootMargin: '200px' }
    );

    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [url, attemptFetch]);

  const domain = getDomain(url);
  const color1 = getColorFromUrl(url);
  const color2 = getColorFromUrl(url + 'x');

  if (src) {
    return (
      <div ref={containerRef} style={{ height }} className={`relative overflow-hidden bg-gray-100 ${className}`}>
        <img
          src={src}
          alt={alt}
          className="w-full h-full object-cover object-top"
          loading="lazy"
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ height, background: `linear-gradient(135deg, ${color1}, ${color2})` }}
      className={`relative overflow-hidden flex flex-col items-center justify-center ${className}`}
    >
      {loading ? (
        <>
          <Loader2 className="w-6 h-6 text-white/80 animate-spin mb-2" />
          <span className="text-white/70 text-[10px] font-medium">Loading preview...</span>
        </>
      ) : failed ? (
        <button
          onClick={(e) => { e.stopPropagation(); retriesRef.current = 0; fetchedRef.current = true; attemptFetch(true); }}
          className="flex flex-col items-center gap-1 hover:scale-105 transition-transform"
        >
          <Globe className="w-6 h-6 text-white/60" />
          <span className="text-white/90 text-xs font-semibold truncate max-w-[90%] text-center">{domain}</span>
          <span className="flex items-center gap-1 text-white/50 text-[9px] mt-1">
            <RefreshCw className="w-3 h-3" /> Retry
          </span>
        </button>
      ) : (
        <>
          <Globe className="w-6 h-6 text-white/50 mb-1" />
          <span className="text-white/80 text-[10px] font-medium truncate max-w-[90%] text-center">{domain}</span>
        </>
      )}
    </div>
  );
}
