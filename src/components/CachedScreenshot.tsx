'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';

const CACHE_PREFIX = 'sc2_';
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7;
const MAX_CONCURRENT = 3;
const MAX_RETRIES = 2;
const RETRY_DELAY = 8000;

let activeRequests = 0;
const queue: (() => void)[] = [];

function processQueue() {
  while (activeRequests < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift();
    if (next) next();
  }
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
    localStorage.setItem(CACHE_PREFIX + url, JSON.stringify({ data: dataUrl, ts: Date.now() }));
  } catch {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.slice(0, Math.ceil(keysToRemove.length / 2)).forEach(k => localStorage.removeItem(k));
    try {
      localStorage.setItem(CACHE_PREFIX + url, JSON.stringify({ data: dataUrl, ts: Date.now() }));
    } catch { /* still full */ }
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
  const [useIframe, setUseIframe] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const fetchedRef = useRef(false);
  const retriesRef = useRef(0);

  const attemptFetch = useCallback((isRetry = false) => {
    const doFetch = () => {
      activeRequests++;
      setLoading(true);
      setUseIframe(false);
      fetchAndCompress(url).then((dataUrl) => {
        activeRequests--;
        if (dataUrl) {
          setLoading(false);
          saveToCache(url, dataUrl);
          setSrc(dataUrl);
        } else if (retriesRef.current < MAX_RETRIES) {
          retriesRef.current++;
          setTimeout(() => doFetch(), RETRY_DELAY * retriesRef.current);
          return;
        } else {
          setLoading(false);
          setUseIframe(true);
        }
        processQueue();
      });
    };

    if (isRetry) {
      retriesRef.current = 0;
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

  if (src) {
    return (
      <div ref={containerRef} style={{ height }} className={`relative overflow-hidden bg-gray-100 ${className}`}>
        <img src={src} alt={alt} className="w-full h-full object-cover object-top" loading="lazy" />
      </div>
    );
  }

  if (useIframe && url) {
    return (
      <div ref={containerRef} style={{ height }} className={`relative overflow-hidden bg-white ${className}`}>
        <iframe
          src={url}
          title={alt || 'Preview'}
          sandbox="allow-same-origin allow-scripts"
          loading="lazy"
          referrerPolicy="no-referrer"
          className="absolute top-0 left-0 border-0 pointer-events-none"
          style={{
            width: '1280px',
            height: '960px',
            transform: 'scale(0.234)',
            transformOrigin: 'top left',
          }}
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className={`relative overflow-hidden flex flex-col items-center justify-center bg-gray-100 ${className}`}
    >
      {loading ? (
        <>
          <Loader2 className="w-5 h-5 text-gray-400 animate-spin mb-1.5" />
          <span className="text-gray-400 text-[10px] font-medium">Loading preview...</span>
        </>
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-gray-50 to-gray-200 flex items-center justify-center">
          <span className="text-gray-300 text-[10px]">No preview</span>
        </div>
      )}
    </div>
  );
}
