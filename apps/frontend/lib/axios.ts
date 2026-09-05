import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { ApiError } from '@/types/api';
import { API_BASE } from './apiBase';
import { triggerPermissionError } from './permissionError';

const axiosInstance = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
});

// ── Request ──────────────────────────────────────────────────────────────────
axiosInstance.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('accessToken');
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// ── Response ─────────────────────────────────────────────────────────────────
axiosInstance.interceptors.response.use(
  (response) => {
    // Blob responses are file downloads — hand them back untouched.
    if (response.config.responseType === 'blob') return response;

    // The backend answers { success, data, message, meta }. Returning
    // response.data preserves that whole envelope, so a caller that needs
    // `meta` for pagination still has it.
    return response.data;
  },
  async (error: AxiosError<ApiError>) => {
    const originalRequest = error.config;
    const status = error.response?.status;

    // 403 — surface the shared permission-denied modal.
    if (status === 403) {
      triggerPermissionError(error.response?.data?.message);
    }

    // 401 — the session is gone. Clear it and send the user to login, but only
    // if they are not already there: redirecting /login to /login turns a failed
    // sign-in attempt into a page reload that discards the error message.
    if (status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
      if (!window.location.pathname.includes('/login')) {
        window.location.href = '/login';
      }
    }

    /**
     * NOTE for callers: this REJECTS WITH A FLAT OBJECT, not an AxiosError.
     * There is no `.response` on it, so `err.response.data.message` reads
     * undefined and any fallback string wins — which is how a precise backend
     * message ends up displayed as a generic "something failed". Read
     * `err.message`, or use `apiErrorMessage()` in utils/apiError.ts.
     */
    const apiError: ApiError = {
      success: false,
      statusCode: status || 500,
      message: error.response?.data?.message || error.message || 'An error occurred',
      timestamp: error.response?.data?.timestamp || new Date().toISOString(),
      path: originalRequest?.url || '',
      errors: error.response?.data?.errors || null,
      details: error.response?.data ?? null,
    };

    return Promise.reject(apiError);
  },
);

export default axiosInstance;
