import { create } from 'zustand';

/**
 * Developer-mode elevation, held for this tab only.
 *
 * Deliberately NOT wrapped in `persist`, unlike authStore and branchStore. That
 * omission is the feature: closing or reloading the tab drops the elevation, so
 * a developer who walks away from a machine cannot leave the hidden settings
 * standing open for whoever sits down next. The 5-tap + password ritual is
 * cheap to repeat; a forgotten elevation is not cheap to discover.
 *
 * The token lives in memory for the same reason — putting it in localStorage
 * would survive the reload we are trying to force.
 */
interface DevModeState {
  /** Elevation token, sent as `X-Dev-Token`. Null when locked. */
  devToken: string | null;
  /** Epoch ms at which the token stops being accepted. */
  expiresAt: number | null;
  /** Whether the backend has a developer password configured at all. When
   *  false the header icon never renders and the 5-tap does nothing. */
  available: boolean;
  /** Whether the backend is actually enforcing the gates yet. */
  enforced: boolean;
  /** Set once the status probe has answered, so the UI does not flash. */
  checked: boolean;

  setAvailability: (v: { available: boolean; enforced: boolean }) => void;
  elevate: (token: string, expiresAtIso: string) => void;
  clear: () => void;
}

/** Timer that force-locks at expiry. Module scope so re-elevating replaces it
 *  rather than leaving an orphan that clears a fresh token. */
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

export const useDevModeStore = create<DevModeState>((set) => ({
  devToken: null,
  expiresAt: null,
  available: false,
  enforced: false,
  checked: false,

  setAvailability: ({ available, enforced }) => set({ available, enforced, checked: true }),

  elevate: (token, expiresAtIso) => {
    const expiresAt = new Date(expiresAtIso).getTime();

    if (expiryTimer) clearTimeout(expiryTimer);
    const ms = expiresAt - Date.now();
    if (ms > 0) {
      expiryTimer = setTimeout(() => {
        // The backend would reject the token anyway; locking the UI at the same
        // moment keeps the two in step instead of showing tabs that 403.
        useDevModeStore.getState().clear();
      }, ms);
    }

    set({ devToken: token, expiresAt });
  },

  clear: () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    set({ devToken: null, expiresAt: null });
  },
}));

/** Non-reactive read, for the axios interceptor. */
export function currentDevToken(): string | null {
  const { devToken, expiresAt } = useDevModeStore.getState();
  if (!devToken || !expiresAt) return null;
  if (expiresAt <= Date.now()) return null;
  return devToken;
}
