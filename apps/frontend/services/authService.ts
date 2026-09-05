import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { ChangePasswordData, LoginCredentials, LoginResponse, RegisterData, User } from '@/types/auth';

class AuthService {
  login(credentials: LoginCredentials): Promise<ApiResponse<LoginResponse>> {
    return axiosInstance.post('/auth/login', credentials);
  }

  register(data: RegisterData): Promise<ApiResponse<User>> {
    return axiosInstance.post('/auth/register', data);
  }

  getMe(): Promise<ApiResponse<User>> {
    return axiosInstance.get('/auth/me');
  }

  changePassword(data: ChangePasswordData): Promise<ApiResponse<{ changed: boolean }>> {
    return axiosInstance.patch('/auth/change-password', data);
  }

  async logout(): Promise<void> {
    // The token is a stateless JWT — there is nothing to revoke server-side, so
    // signing out IS clearing it locally.
    if (typeof window !== 'undefined') {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
    }
  }

  // ── Local session helpers ──────────────────────────────────────────────────
  saveToken(accessToken: string): void {
    if (typeof window !== 'undefined') localStorage.setItem('accessToken', accessToken);
  }

  saveUser(user: User): void {
    if (typeof window !== 'undefined') localStorage.setItem('user', JSON.stringify(user));
  }

  getUser(): User | null {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem('user');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as User;
    } catch {
      // Corrupt blob — treat it as no session rather than throwing during render.
      return null;
    }
  }

  getAccessToken(): string | null {
    return typeof window === 'undefined' ? null : localStorage.getItem('accessToken');
  }

  isAuthenticated(): boolean {
    return !!this.getAccessToken();
  }
}

export default new AuthService();
