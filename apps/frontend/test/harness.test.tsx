import { describe, expect, it } from 'vitest';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/authStore';
import { usePermission } from '@/hooks/usePermission';
import { formatDate } from '@/utils/formatters';
import { renderWithProviders, screen } from './render';
import { routerMock } from './router-mock';

/**
 * Proves the harness itself works, so a failure in a real component test is
 * about that component and not about the scaffolding underneath it. Every
 * assertion here maps to one of the four things renderWithProviders sets up.
 */

function Probe() {
  const t = useTranslations('common');
  const { can, isAdmin } = usePermission();
  const user = useAuthStore((s) => s.user);
  return (
    <div>
      <span data-testid="role">{user?.role ?? 'anonymous'}</span>
      <span data-testid="is-admin">{String(isAdmin())}</span>
      <span data-testid="can-manage-payroll">{String(can('MANAGE_PAYROLL'))}</span>
      <span data-testid="translated">{t('save')}</span>
      <span data-testid="date">{formatDate('2026-03-09T10:00:00.000Z')}</span>
    </div>
  );
}

describe('component test harness', () => {
  it('defaults to an ADMIN session', () => {
    renderWithProviders(<Probe />);
    expect(screen.getByTestId('role')).toHaveTextContent('ADMIN');
    expect(screen.getByTestId('is-admin')).toHaveTextContent('true');
  });

  it('seeds the requested role, and permissions follow it', () => {
    renderWithProviders(<Probe />, { role: 'EMPLOYEE' });
    expect(screen.getByTestId('role')).toHaveTextContent('EMPLOYEE');
    expect(screen.getByTestId('can-manage-payroll')).toHaveTextContent('false');
  });

  it('renders logged-out when role is null', () => {
    renderWithProviders(<Probe />, { role: null });
    expect(screen.getByTestId('role')).toHaveTextContent('anonymous');
    expect(screen.getByTestId('can-manage-payroll')).toHaveTextContent('false');
  });

  it('provides translations rather than throwing', () => {
    renderWithProviders(<Probe />);
    // Whatever `common.save` resolves to, it must not be empty and must not
    // have thrown — a missing key falls back to the key itself.
    expect(screen.getByTestId('translated').textContent).toBeTruthy();
  });

  it('pins the date format, so date assertions are stable', () => {
    renderWithProviders(<Probe />, { dateFormat: 'YYYY-MM-DD' });
    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-09');
  });

  it('defaults the date format to DD/MM/YYYY when unspecified', () => {
    renderWithProviders(<Probe />);
    expect(screen.getByTestId('date')).toHaveTextContent('09/03/2026');
  });

  it('exposes a router mock that records navigation', () => {
    function Nav() {
      return (
        <button type="button" onClick={() => routerMock.push('/dashboard/employees')}>
          go
        </button>
      );
    }
    renderWithProviders(<Nav />);
    screen.getByRole('button', { name: 'go' }).click();
    expect(routerMock.push).toHaveBeenCalledWith('/dashboard/employees');
  });

  it('lands framer-motion on its animate values in a single frame', () => {
    // Guards the `skipAnimations` line in setup.ts. A motion component still
    // mounts at `initial` — nothing makes that synchronous — but with the flag
    // it reaches `animate` on the first frame instead of easing there over
    // 300ms, which is the difference between a test that waits once and one
    // that flakes under load. Asserted on the value, not on `toBeVisible()`:
    // mid-transition opacity is a fraction, which already counts as visible.
    renderWithProviders(
      <motion.div
        data-testid="fades-in"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      />,
    );
    const el = screen.getByTestId('fades-in');
    expect(el.style.opacity).toBe('0');

    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        expect(el.style.opacity).toBe('1');
        resolve();
      });
    });
  });
});
