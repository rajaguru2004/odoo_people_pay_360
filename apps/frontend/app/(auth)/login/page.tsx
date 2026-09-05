'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { AlertCircle, Eye, EyeOff, Lock, Mail, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { getDefaultRouteForRole } from '@/utils/permissions';
import { apiErrorMessage } from '@/utils/apiError';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

export default function LoginPage() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const { branding } = useBrandingStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login({ email, password });
      const user = useAuthStore.getState().user;
      router.push(getDefaultRouteForRole(user?.role));
    } catch (err) {
      setError(apiErrorMessage(err, 'Sign-in failed. Check your details and try again.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-page px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="w-full max-w-md rounded-[var(--radius-card)] border border-surface-border bg-surface-card p-8 shadow-sm"
      >
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-[var(--radius-card)] bg-brand-primary">
            {branding.company_logo_url ? (
              <img src={branding.company_logo_url} alt="" className="h-10 w-10 object-contain" />
            ) : (
              <ShieldCheck className="h-7 w-7 text-text-on-brand" aria-hidden />
            )}
          </span>
          <h1 className="text-2xl font-semibold text-text-heading">{branding.company_name}</h1>
          <p className="mt-1 text-sm text-text-muted">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Input
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            icon={<Mail className="h-4 w-4" aria-hidden />}
          />

          <div className="relative">
            <Input
              label="Password"
              type={showPassword ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              icon={<Lock className="h-4 w-4" aria-hidden />}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute end-3 top-[34px] text-text-muted hover:text-text-body"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[var(--radius-input)] bg-status-error-bg px-3 py-2 text-sm text-status-error"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <Button type="submit" size="lg" className="w-full" isLoading={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </motion.div>
    </main>
  );
}
