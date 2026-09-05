'use client';

import { useEffect } from 'react';
import { useBrandingStore } from '@/store/brandingStore';

/**
 * Applies the company name to document.title after branding loads.
 *
 * The SERVER-rendered title in app/layout.tsx is the source of truth — Next
 * re-applies a route's metadata on every client navigation, so a client-only
 * title would be overwritten on each page change. This exists for the one case
 * metadata cannot cover: the name being changed in Settings without a reload.
 */
export default function TitleManager() {
  const companyName = useBrandingStore((s) => s.branding.company_name);

  useEffect(() => {
    if (companyName) document.title = companyName;
  }, [companyName]);

  return null;
}
