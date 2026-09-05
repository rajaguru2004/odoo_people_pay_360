'use client';

import { useEffect } from 'react';
import { useBrandingStore } from '@/store/brandingStore';

/**
 * Keeps the browser-tab favicon in sync with the company branding.
 *
 * Design notes (this used to cause full-page reloads — see git history):
 *   - Subscribes to ONLY the `company_favicon_url` primitive via a selector,
 *     so unrelated branding/state changes never re-run this effect.
 *   - Updates the existing <link rel="icon"> href IN PLACE; it never removes
 *     and re-appends head nodes, and writes only when the value differs.
 *   - The URL is content-hashed server-side, so it changes only when the logo
 *     changes — no `Date.now()` cache-busters, no per-render churn, no proxy
 *     API route.
 *
 * Render-free: returns null. Mount once near the app root.
 */
export default function FaviconManager() {
  const faviconUrl = useBrandingStore((s) => s.branding.company_favicon_url);

  useEffect(() => {
    if (!faviconUrl) return;
    if (typeof document === 'undefined') return;

    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }

    // Only touch the DOM when the href actually changes.
    if (link.href !== faviconUrl) {
      link.type = 'image/png';
      link.href = faviconUrl;
    }
  }, [faviconUrl]);

  return null;
}
