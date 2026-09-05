import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { LoginCredentials, User } from '@/types/auth';
import authService from '@/services/authService';

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
   * of a logged-out visitor. Anything that DECIDES something from the session —
   * a route guard most of all — needs those two told apart, because acting on
   * the first is acting on an answer nobody has given yet.
   *
   * It flips exactly once, when the middleware has read storage or definitively
   * found nothing there. On the server it never flips, which is correct: SSR
   * does not know who the user is.
   */
  hasHydrated: boolean;

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

      login: async (credentials) => {
        try {
          set({ isLoading: true, error: null });

          const response = await authService.login(credentials);
          const { user, accessToken } = response.data;

          authService.saveToken(accessToken);
          authService.saveUser(user);

          set({ user, isAuthenticated: true, isLoading: false });
        } catch (error: any) {
          const message = error?.message || 'Login failed';
          set({ error: message, isLoading: false });
          throw error;
        }
      },

      logout: async () => {
        try {
          await authService.logout();
          set({ user: null, isAuthenticated: false, error: null });
        } catch (error) {
          console.error('Logout error:', error);
        }
      },

      loadUser: async () => {
        try {
          if (!authService.isAuthenticated()) {
            set({ isAuthenticated: false, user: null });
            return;
          }

          set({ isLoading: true });

          // Show the cached user immediately so the shell can render, then
          // reconcile with the server. A role or a deactivation changed
          // elsewhere lands on this refresh rather than at token expiry.
          const cached = authService.getUser();
          if (cached) set({ user: cached, isAuthenticated: true, isLoading: false });

          const response = await authService.getMe();
          authService.saveUser(response.data);
          set({ user: response.data, isAuthenticated: true, isLoading: false });
        } catch {
          await authService.logout();
          set({ user: null, isAuthenticated: false, isLoading: false });
        }
      },

      clearError: () => set({ error: null }),
      setHasHydrated: (value) => set({ hasHydrated: value }),
    }),
    {
      name: 'auth-storage',
      // The token is NOT persisted through zustand — it lives in localStorage
      // under its own key, read by the axios interceptor. Keeping the two apart
      // means clearing the session cannot half-succeed.
      partialize: (state) => ({ user: state.user, isAuthenticated: state.isAuthenticated }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
