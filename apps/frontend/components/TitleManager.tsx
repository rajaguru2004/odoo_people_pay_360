'use client';

import { useEffect } from 'react';
import { useBrandingStore } from '@/store/brandingStore';

/**
 * Keeps `document.title` in sync with the company name from settings.
 * Subscribes to ONLY `company_name` via a selector — unrelated branding
 * changes never trigger this effect. Render-free: returns null.
 */
export default function TitleManager() {
  const companyName = useBrandingStore((s) => s.branding.company_name);

  useEffect(() => {
    if (!companyName || typeof document === 'undefined') return;
    document.title = companyName;
  }, [companyName]);

  return null;
}
