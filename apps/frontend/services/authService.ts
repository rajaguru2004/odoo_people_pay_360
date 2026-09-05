import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { LoginCredentials, LoginResponse, RegisterData, User, ChangePasswordData } from '@/types/auth';

class AuthService {
  async login(credentials: LoginCredentials): Promise<ApiResponse<LoginResponse>> {
    return axiosInstance.post('/auth/login', credentials);
  }

  async register(data: RegisterData): Promise<ApiResponse<User>> {
    return axiosInstance.post('/auth/register', data);
  }

  async getMe(): Promise<ApiResponse<User>> {
    return axiosInstance.get('/auth/me');
  }

  async changePassword(data: ChangePasswordData): Promise<ApiResponse<void>> {
    return axiosInstance.patch('/auth/change-password', data);
  }

  async logout(): Promise<void> {
    // Clear local storage
    if (typeof window !== 'undefined') {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('user');
    }
  }

  // Helper methods
  saveTokens(accessToken: string, refreshToken: string): void {
    if (typeof window !== 'undefined') {
      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('refreshToken', refreshToken);
    }
  }

  saveUser(user: User): void {
    if (typeof window !== 'undefined') {
      localStorage.setItem('user', JSON.stringify(user));
    }
  }

  getUser(): User | null {
    if (typeof window !== 'undefined') {
      const userStr = localStorage.getItem('user');
      return userStr ? JSON.parse(userStr) : null;
    }
    return null;
  }

  getAccessToken(): string | null {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('accessToken');
    }
    return null;
  }

  isAuthenticated(): boolean {
    return !!this.getAccessToken();
  }
}

export default new AuthService();
