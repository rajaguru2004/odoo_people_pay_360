import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '@/test/utils';
import DemoCredentials, { DEMO_ACCOUNTS, DEMO_PASSWORD } from './DemoCredentials';

describe('DemoCredentials', () => {
  it('stays closed until asked, so the real form is the primary path', () => {
    renderWithProviders(<DemoCredentials onFill={vi.fn()} />);

    expect(screen.getByRole('button', { name: /demo accounts/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText(DEMO_ACCOUNTS[0].email)).not.toBeInTheDocument();
  });

  it('offers one button per seeded account, each naming its email', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DemoCredentials onFill={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /demo accounts/i }));

    for (const account of DEMO_ACCOUNTS) {
      // The email is on the button, not only in its label: four rows that
      // differ by a single word are four rows somebody presses the wrong one of.
      expect(screen.getByText(account.email)).toBeInTheDocument();
    }
  });

  it('hands the credentials back rather than signing in on its own', async () => {
    const onFill = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<DemoCredentials onFill={onFill} />);

    await user.click(screen.getByRole('button', { name: /demo accounts/i }));
    await user.click(
      screen.getByRole('button', { name: /fill the form with the administrator account/i }),
    );

    // Filling and submitting in one motion would be quicker and would also make
    // it impossible to tell which of four accounts you are looking at the
    // system as.
    expect(onFill).toHaveBeenCalledWith('admin@peoplepay360.com', DEMO_PASSWORD);
  });

  it('goes inert while a sign-in is already in flight', async () => {
    const onFill = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<DemoCredentials onFill={onFill} disabled />);

    await user.click(screen.getByRole('button', { name: /demo accounts/i }));
    await user.click(
      screen.getByRole('button', { name: /fill the form with the employee account/i }),
    );

    expect(onFill).not.toHaveBeenCalled();
  });

  it('offers one account per role the seed creates, each named uniquely', () => {
    expect(DEMO_ACCOUNTS.map((a) => a.role)).toEqual([
      'ADMIN',
      'HR_MANAGER',
      'PAYROLL_OFFICER',
      'EMPLOYEE',
    ]);

    const emails = DEMO_ACCOUNTS.map((a) => a.email);
    expect(new Set(emails).size).toBe(emails.length);
  });
});
