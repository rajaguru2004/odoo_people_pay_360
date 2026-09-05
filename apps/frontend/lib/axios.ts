import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { ApiError, ApiResponse } from '@/types/api';
import { triggerPermissionError } from './permissionError';
import { useBranchStore } from '@/store/branchStore';
import { currentDevToken } from '@/store/devModeStore';
import { API_BASE } from './apiBase';
import { trackApiAction } from './analytics/events';

const axiosInstance = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// Request interceptor
axiosInstance.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // Add auth token if available
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('accessToken');
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      // Multi-branch: the selected branch is a scoped view selector. Absent =
      // server default (all-branches for global, envelope for scoped users).
      //
      // Only sent for roles that may actually switch. An EMPLOYEE or MANAGER is
      // pinned server-side, so sending a branch header for them can only ever
      // produce "You do not have access to the selected branch" — which is
      // exactly what happened when a stale selection outlived the admin's
      // session and the next user inherited it. Belt and braces alongside
      // clearSelectedBranch() on login/logout.
      const branchId = useBranchStore.getState().selectedBranchId;
      if (branchId && config.headers) {
        let role: string | undefined;
        try {
          const raw = localStorage.getItem('user');
          role = raw ? JSON.parse(raw)?.role : undefined;
        } catch {
          // Corrupt/absent user blob — fall through and send nothing.
        }
        if (role === 'ADMIN' || role === 'HR_MANAGER') {
          config.headers['X-Branch-Id'] = branchId;
        }
      }

      // Developer-mode elevation. A second, short-lived token kept separate from
      // Authorization: the access token alone never unlocks a gated route, and
      // the login/refresh flow stays untouched. In memory only, so a reload
      // re-locks.
      const devToken = currentDevToken();
      if (devToken && config.headers) {
        config.headers['X-Dev-Token'] = devToken;
      }
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor
axiosInstance.interceptors.response.use(
  (response) => {
    // Analytics: every WRITE the portal makes, recorded in one place.
    //
    // Method + sanitised endpoint + status only — no request body, no response
    // body, so nothing about an employee can travel with it. Doing it here
    // rather than in 50 screens is what keeps the measurement complete and
    // keeps a hand-written call from ever leaking a payload. No-op unless a GA
    // measurement id is configured, and it cannot throw. See lib/analytics/.
    trackApiAction({
      method: response.config?.method ?? '',
      url: response.config?.url ?? '',
      status: response.status,
      ok: true,
    });

    // Don't process blob responses (for file downloads)
    if (response.config.responseType === 'blob') {
      return response;
    }
    
    // Backend returns: { success: true, data: {...}, message: '...' }
    // Return the whole response.data to preserve the structure
    return response.data;
  },
  async (error: AxiosError<ApiError>) => {
    const originalRequest = error.config;

    // Developer-mode endpoints report on a SECOND credential, not on the login
    // session. Their 401 means "wrong developer password" and their 403 means
    // "not elevated" — neither says anything about the access token. Running
    // the handlers below on them would sign the admin out of the app for a typo
    // in the dev-password box, and pop the generic Access Denied modal over
    // settings tabs that are hidden on purpose. The dialog shows its own error.
    const isDevModeRequest = originalRequest?.url?.includes('/dev-mode/');

    // Handle 403 Forbidden — show permission-denied modal
    if (error.response?.status === 403 && !isDevModeRequest) {
      const msg: string | undefined =
        (error.response?.data as any)?.message;
      triggerPermissionError(msg);
    }

    // Handle 401 Unauthorized
    if (error.response?.status === 401 && !isDevModeRequest) {
      // Clear tokens and redirect to login
      if (typeof window !== 'undefined') {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        
        // Only redirect if not already on login page
        if (!window.location.pathname.includes('/login')) {
          window.location.href = '/login';
        }
      }
    }

    // Analytics: failed writes matter more than successful ones — they are
    // where a journey breaks. Same three fields, same guarantees.
    trackApiAction({
      method: originalRequest?.method ?? '',
      url: originalRequest?.url ?? '',
      status: error.response?.status || 0,
      ok: false,
    });

    // Handle other errors - return a proper error object.
    //
    // NOTE for callers: this REJECTS WITH A FLAT OBJECT, not an AxiosError. There is
    // no `.response` on it, so `err.response.data.message` reads undefined and any
    // fallback string wins — which is how a precise backend message ends up shown as
    // a generic "something failed". Read `err.message`, or use
    // `apiErrorMessage()` in utils/apiError.ts, which handles both shapes.
    const apiError: ApiError = {
      success: false,
      statusCode: error.response?.status || 500,
      message: error.response?.data?.message || error.message || 'An error occurred',
      timestamp: error.response?.data?.timestamp || new Date().toISOString(),
      path: originalRequest?.url || '',
      errors: error.response?.data?.errors || null,
      // Everything the endpoint sent, so nothing is lost to the flattening above.
      details: error.response?.data ?? null,
    };

    // Only log errors in development mode and exclude 401 (already handled above)
    // Disabled to reduce console noise
    // if (process.env.NODE_ENV === 'development' && apiError.statusCode !== 401) {
    //   console.error('API Error:', {
    //     url: originalRequest?.url,
    //     method: originalRequest?.method,
    //     status: apiError.statusCode,
    //     message: apiError.message,
    //   });
    // }

    return Promise.reject(apiError);
  }
);

export default axiosInstance;
