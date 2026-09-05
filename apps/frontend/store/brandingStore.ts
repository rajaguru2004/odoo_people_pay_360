import { create } from 'zustand';
import settingsService from '@/services/settingsService';
import type { PublicBranding } from '@/types/settings';

/**
 * Company branding, fetched once at app start.
 *
 * Seeded with the same defaults the backend serves, so the very first paint —
 * before the fetch resolves, and when the API is unreachable — is the finished
 * design rather than an unstyled flash.
 */
const DEFAULTS: PublicBranding = {
  company_name: 'People Pay 360',
  company_short_name: 'PP360',
  primary_color: '#00358F',
  accent_color: '#f66600',
  default_currency: 'OMR',
  default_timezone: 'Asia/Muscat',
};

interface BrandingState {
  branding: PublicBranding;
  isLoaded: boolean;
  fetchBranding: () => Promise<void>;
  setBranding: (patch: Partial<PublicBranding>) => void;
}

export const useBrandingStore = create<BrandingState>((set) => ({
  branding: DEFAULTS,
  isLoaded: false,

  fetchBranding: async () => {
    try {
      const response = await settingsService.getPublic();
      set({ branding: { ...DEFAULTS, ...response.data }, isLoaded: true });
    } catch {
      // Backend unreachable. Keep the defaults and mark it settled — a retry
      // loop here would hammer a down API on every mount for no visible gain.
      set({ isLoaded: true });
    }
  },

  setBranding: (patch) => set((s) => ({ branding: { ...s.branding, ...patch } })),
}));
