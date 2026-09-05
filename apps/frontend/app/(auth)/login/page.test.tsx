import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '@/test/utils';
import LoginPage from './page';

// Forced ON so the panel is under test regardless of the NODE_ENV the suite
// happens to run under. The gate itself is tested in utils/demoAccounts.test.ts.
vi.mock('@/utils/demoAccounts', () => ({ DEMO_LOGINS_ENABLED: true }));

describe('Sign in — demo accounts', () => {
  it('fills both fields from a demo account without submitting', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    const email = screen.getByLabelText('Email') as HTMLInputElement;
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(email.value).toBe('');

    await user.click(screen.getByRole('button', { name: /demo accounts/i }));
    await user.click(
      screen.getByRole('button', { name: /fill the form with the hr manager account/i }),
    );

    expect(email.value).toBe('hr@peoplepay360.com');
    expect(password.value).not.toBe('');

    // Still on the form, nothing submitted — the reader gets to see which
    // account they are about to use.
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeEnabled();
  });
});
