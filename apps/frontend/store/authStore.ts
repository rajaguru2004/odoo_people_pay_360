import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User, LoginCredentials } from '@/types/auth';
import authService from '@/services/authService';
import { useBranchStore } from './branchStore';
import {
  AnalyticsEvent,
  clearAnalyticsUser,
  setAnalyticsUser,
  trackEvent,
} from '@/lib/analytics/events';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  /**
   * Whether `persist` has finished reading `auth-storage`.
   *
   * `user: null, isAuthenticated: false` is ambiguous on its own: it is both the
   * initial state of a store that has not read storage yet AND the settled state
   * of a logged-out visitor. Anything that has to *decide* something from the
   * session — a route guard, most of all — needs those two told apart, because
   * acting on the first one is acting on an answer nobody has given yet.
   *
   * This flag is the only thing that separates them. It flips exactly once, when
   * the middleware has read storage (or has definitively found nothing there);
   * see `onRehydrateStorage` at the bottom of this file.
   */
  hasHydrated: boolean;

  // Actions
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  loadUser: () => Promise<void>;
  clearError: () => void;
  setHasHydrated: (value: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      hasHydrated: false,

      login: async (credentials: LoginCredentials) => {
        try {
          set({ isLoading: true, error: null });

          const response = await authService.login(credentials);
          
          // Backend returns: { success: true, data: { user, accessToken } }
          // So we need to access response.data (which is already unwrapped by axios)
          const { user, accessToken } = response.data;

          // A new session must never inherit the previous user's branch
          // selection — it is persisted globally and would be sent as
          // X-Branch-Id by someone with no access to that branch.
          useBranchStore.getState().clearSelectedBranch();

          // Save tokens and user (no refreshToken in current backend)
          authService.saveTokens(accessToken, accessToken);
          authService.saveUser(user);

          set({
            user,
            isAuthenticated: true,
            isLoading: false
          });

          // Analytics: identify first, so the events that follow this sign-in
          // are attributed to the right (pseudonymous) user and role. Only the
          // role travels — never the address that was typed into the form.
          setAnalyticsUser({
            id: user.id,
            role: user.role,
            globalBranchAccess: user.isGlobalBranchAccess,
          });
          trackEvent(AnalyticsEvent.LOGIN, { method: 'password', user_role: user.role });
        } catch (error: any) {
          // Sign-in failures are a product signal (locked accounts, wrong
          // portal). The status code says what happened; the message may quote
          // the account, so it is not sent.
          trackEvent(AnalyticsEvent.LOGIN_FAILED, { status: error?.statusCode ?? 0 });

          const errorMessage = error.message || 'Login failed';
          set({
            error: errorMessage,
            isLoading: false
          });
          throw error;
        }
      },

      logout: async () => {
        try {
          // Emitted before the identity is dropped so the event still carries it.
          trackEvent(AnalyticsEvent.LOGOUT);
          clearAnalyticsUser();

          await authService.logout();
          useBranchStore.getState().clearSelectedBranch();
          set({
            user: null,
            isAuthenticated: false,
            error: null
          });
        } catch (error: any) {
          console.error('Logout error:', error);
        }
      },

      loadUser: async () => {
        try {
          // Check if token exists
          if (!authService.isAuthenticated()) {
            set({ isAuthenticated: false, user: null });
            return;
          }

          set({ isLoading: true });

          // Try to get user from localStorage first
          const cachedUser = authService.getUser();
          if (cachedUser) {
            set({ user: cachedUser, isAuthenticated: true, isLoading: false });
          }

          // Fetch fresh user data from API
          const response = await authService.getMe();
          authService.saveUser(response.data);

          set({
            user: response.data,
            isAuthenticated: true,
            isLoading: false
          });
        } catch (error: any) {
          // Token invalid, logout
          await authService.logout();
          useBranchStore.getState().clearSelectedBranch();
          set({
            user: null,
            isAuthenticated: false,
            isLoading: false
          });
        }
      },

      clearError: () => {
        set({ error: null });
      },

      setHasHydrated: (value: boolean) => {
        set({ hasHydrated: value });
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated
      }),
      /**
       * Runs once the middleware has read `auth-storage` — including when it
       * read it and found nothing, which is the case that matters most.
       *
       * In the browser this fires synchronously while this module is being
       * evaluated, because `localStorage` is a synchronous store. On the server
       * there is no storage to read, so `hydrate()` returns early and this never
       * fires — `hasHydrated` stays `false` through SSR and through React's
       * hydration pass on the client, which is correct: neither of those renders
       * knows who the user is.
       *
       * That asymmetry is deliberate. `useSyncExternalStore` serves
       * `getInitialState()` — the *pre*-rehydration state — during hydration,
       * so a component that reads this store renders at least once against
       * `user: null, isAuthenticated: false` even when the session was restored
       * before React started. Consumers that branch on the session must wait for
       * this flag rather than treat that first render as an answer.
       */
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
