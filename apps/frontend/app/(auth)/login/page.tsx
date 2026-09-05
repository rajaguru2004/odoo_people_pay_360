'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Mail, Lock, Eye, EyeOff, ArrowRight, Sparkles, Shield, CheckCircle2 } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { getDefaultRouteForRole } from '@/utils/permissions';
import { useBrandingStore } from '@/store/brandingStore';

function LoginLogo({ className = "w-10 h-10" }: { className?: string }) {
  const { branding } = useBrandingStore();

  if (branding.company_logo_svg?.trim()) {
    return (
      <div
        className={`${className} flex items-center justify-center [&>svg]:w-full [&>svg]:h-full`}
        dangerouslySetInnerHTML={{ __html: branding.company_logo_svg }}
      />
    );
  }

  if (branding.company_logo_url?.trim()) {
    return (
      <img
        src={branding.company_logo_url}
        alt={branding.company_name}
        className={`${className} object-contain rounded-xl`}
      />
    );
  }

  // Original fallback
  return <Shield className="text-text-on-brand w-8 h-8" />;
}

export default function LoginPage() {
  const { branding } = useBrandingStore();
  const router = useRouter();
  const { login } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login({ email, password });

      // Get user from store after successful login
      const user = useAuthStore.getState().user;

      // Role-based redirect
      if (user?.role) {
        const defaultRoute = getDefaultRouteForRole(user.role);
        router.push(defaultRoute);
      } else {
        router.push('/dashboard');
      }
    } catch (err: any) {
      console.error('Login error:', err);
      // Error can be ApiError object with message property
      const errorMessage = err?.message || err?.error || 'Login failed. Please check the information again.';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const fillDemoAccount = (type: 'admin' | 'hr' | 'employee') => {
    if (type === 'admin') {
      setEmail('admin@company.com');
      setPassword('Admin@123');
    } else if (type === 'hr') {
      setEmail('hr.manager@company.com');
      setPassword('Password123!');
    } else {
      // Get first employee user
      setEmail('employee1@company.com');
      setPassword('Password123!');
    }
  };

  return (
    <div className="min-h-screen relative overflow-hidden bg-linear-to-br from-brand-primary via-brand-primary-dark to-text-heading flex items-center justify-center p-4">
      {/* Animated Background Blobs */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-brand-primary-light/10 rounded-full blur-[120px] animate-float" style={{ animationDuration: '8s' }}></div>
        <div className="absolute top-[20%] right-[-5%] w-[40%] h-[60%] bg-brand-accent/20 rounded-full blur-[100px] animate-float" style={{ animationDuration: '10s' }}></div>
        <div className="absolute bottom-[-10%] left-[20%] w-[40%] h-[40%] bg-brand-primary-dark/50 rounded-full blur-[120px] animate-float" style={{ animationDuration: '12s' }}></div>
      </div>

      {/* Grid Pattern */}
      <div className="absolute inset-0 opacity-5"></div>

      <div className="w-full max-w-6xl mx-auto grid md:grid-cols-2 gap-8 items-center relative z-10">
        {/* Left Side - Branding */}
        <motion.div
          initial={{ opacity: 0, x: -50 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
          className="hidden md:block space-y-8"
        >
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="w-16 h-16 bg-linear-to-br from-brand-accent to-brand-accent-dark rounded-[--radius-card] flex items-center justify-center shadow-2xl shadow-brand-accent/30 p-1.5 overflow-hidden">
              <LoginLogo className="w-10 h-10" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-text-on-brand" title={branding.company_name}>
                {branding.company_name}
              </h1>
              <p className="text-brand-primary-light/70 text-sm" title={branding.company_subtitle}>
                {branding.company_subtitle}
              </p>
            </div>
          </div>

          {/* Features */}
          <div className="space-y-4">
            <h2 className="text-4xl font-bold text-text-on-brand leading-tight">
              Welcome <br />
              <span className="text-transparent bg-clip-text bg-linear-to-r from-brand-accent to-brand-primary-light">
                to {branding.company_name}
              </span>
            </h2>
            <p className="text-brand-primary-light/80 text-lg leading-relaxed">
              Comprehensive Employee Self-Service platform, helping businesses automate 100% of HR processes.
            </p>
          </div>

          {/* Benefits */}
          <div className="space-y-3">
            {[
              'Manage employees easily',
              'Accurate automatic timekeeping',
              'Calculate salary quickly',
              'Real-time detailed reporting'
            ].map((feature, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.5 + index * 0.1 }}
                className="flex items-center gap-3 text-text-on-brand/90"
              >
                <div className="w-6 h-6 rounded-full bg-brand-accent/20 flex items-center justify-center">
                  <CheckCircle2 size={14} className="text-brand-accent" />
                </div>
                <span className="text-brand-primary-light/90">{feature}</span>
              </motion.div>
            ))}
          </div>


        </motion.div>

        {/* Right Side - Login Form */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          <div className="bg-surface-card/95 backdrop-blur-xl rounded-[--radius-card] shadow-2xl p-8 md:p-10 border border-surface-border">
            {/* Mobile Logo */}
            <div className="md:hidden flex items-center gap-3 mb-8">
              <div className="w-12 h-12 bg-linear-to-br from-brand-accent to-brand-accent-dark rounded-[--radius-input] flex items-center justify-center p-1.5 overflow-hidden">
                <LoginLogo className="w-8 h-8" />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-bold text-text-heading" title={branding.company_name}>
                  {branding.company_name}
                </h1>
              </div>
            </div>

            <div className="mb-8">
              <h2 className="text-3xl font-bold text-text-heading mb-2">Log in</h2>
              <p className="text-text-muted">Please enter information to continue</p>
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-6 p-4 bg-red-50 border-l-4 border-red-500 rounded-lg"
              >
                <p className="text-red-700 text-sm font-medium">{error}</p>
              </motion.div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Email Field */}
              <div>
                <label className="block text-sm font-medium text-text-body mb-2">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" size={20} />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@company.com"
                    required
                    className="w-full pl-12 pr-4 py-3.5 bg-surface-page border-2 border-surface-border rounded-[--radius-input] focus:outline-none focus:border-brand-primary focus:bg-surface-card transition-all text-text-heading placeholder:text-text-muted"
                  />
                </div>
              </div>

              {/* Password Field */}
              <div>
                <label className="block text-sm font-medium text-text-body mb-2">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" size={20} />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    className="w-full pl-12 pr-12 py-3.5 bg-surface-page border-2 border-surface-border rounded-[--radius-input] focus:outline-none focus:border-brand-primary focus:bg-surface-card transition-all text-text-heading placeholder:text-text-muted"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-body transition-colors"
                  >
                    {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
              </div>

              {/* Remember Me & Forgot Password */}
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4 h-4 rounded-[--radius-badge] border-surface-border text-brand-primary focus:ring-2 focus:ring-brand-primary/20"
                  />
                  <span className="text-sm text-text-body group-hover:text-text-heading transition-colors">
                    Remember me
                  </span>
                </label>
                <button
                  type="button"
                  className="text-sm text-brand-accent hover:text-brand-accent-dark transition-colors font-semibold"
                >
                  Forgot password?
                </button>
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-linear-to-r from-brand-accent to-brand-accent-dark text-text-on-accent font-semibold py-4 rounded-[--radius-button] hover:shadow-lg hover:shadow-brand-accent/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 group"
              >
                {loading ? (
                  <>
                    <div className="w-5 h-5 border-2 border-text-on-brand border-t-transparent rounded-full animate-spin"></div>
                    <span>Signing in...</span>
                  </>
                ) : (
                  <>
                    <span>Log in</span>
                    <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
                  </>
                )}
              </button>
            </form>

            {/* Demo accounts - development only */}
            {process.env.NODE_ENV === 'development' && (
              <>
                {/* Divider */}
                <div className="relative my-8">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-surface-border"></div>
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-4 bg-surface-card text-text-muted">or use a demo account</span>
                  </div>
                </div>

                {/* Demo Accounts */}
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => fillDemoAccount('admin')}
                      className="px-4 py-3 border-2 border-brand-primary/20 text-brand-primary rounded-[--radius-button] hover:bg-brand-primary-light/10 hover:border-brand-primary transition-all font-semibold text-sm flex items-center justify-center gap-2"
                    >
                      <Shield size={16} />
                      <span>Admin</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => fillDemoAccount('hr')}
                      className="px-4 py-3 border-2 border-brand-accent/20 text-brand-accent rounded-[--radius-button] hover:bg-brand-accent/10 hover:border-brand-accent transition-all font-semibold text-sm flex items-center justify-center gap-2"
                    >
                      <Sparkles size={16} />
                      <span>HR Manager</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => fillDemoAccount('employee')}
                    className="w-full px-4 py-3 border-2 border-status-success/20 text-status-success rounded-[--radius-button] hover:bg-status-success-bg/40 hover:border-status-success transition-all font-semibold text-sm flex items-center justify-center gap-2"
                  >
                    <CheckCircle2 size={16} />
                    <span>Employee</span>
                  </button>
                </div>

                {/* Account Info */}
                <div className="mt-4 p-4 bg-brand-primary-light/10 rounded-[--radius-card] border border-brand-primary/20">
                  <p className="text-xs font-semibold text-brand-primary mb-2">📋 Demo account information:</p>
                  <div className="space-y-1 text-xs text-brand-primary">
                    <p>• <strong>Admin:</strong> admin@company.com / Admin@123</p>
                    <p>• <strong>HR Manager:</strong> hr.manager@company.com / Password123!</p>
                    <p>• <strong>Employee:</strong> employee1@company.com / Password123!</p>
                  </div>
                </div>
              </>
            )}

            {/* Footer Note */}
            <p className="text-center text-xs text-text-muted mt-6">
              By logging in, you agree to the{' '}
              <a href="#" className="text-brand-primary hover:underline font-semibold">Terms of use</a>
              {' '}and{' '}
              <a href="#" className="text-brand-primary hover:underline font-semibold">Privacy policy</a>
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
