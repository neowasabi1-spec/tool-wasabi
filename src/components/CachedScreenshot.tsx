'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Eye, Globe, Loader2 } from 'lucide-react';

const CACHE_PREFIX = 'sc_';
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days
const MAX_CONCURRENT = 3;

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
    // localStorage full - clear old screenshot caches
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
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size < 500) return null;

    // Compress via canvas to reduce localStorage size
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

          const doFetch = () => {
            activeRequests++;
            setLoading(true);
            fetchAndCompress(url).then((dataUrl) => {
              activeRequests--;
              setLoading(false);
              if (dataUrl) {
                saveToCache(url, dataUrl);
                setSrc(dataUrl);
              } else {
                setFailed(true);
              }
              processQueue();
            });
          };

          if (activeRequests >= MAX_CONCURRENT) {
            queue.push(doFetch);
          } else {
            doFetch();
          }
        }
      },
      { rootMargin: '200px' }
    );

    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [url]);

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
        <>
          <Globe className="w-6 h-6 text-white/60 mb-1" />
          <span className="text-white/90 text-xs font-semibold truncate max-w-[90%] text-center">{domain}</span>
        </>
      ) : (
        <>
          <Eye className="w-6 h-6 text-white/50 mb-1" />
          <span className="text-white/80 text-[10px] font-medium truncate max-w-[90%] text-center">{domain}</span>
        </>
      )}
    </div>
  );
}
