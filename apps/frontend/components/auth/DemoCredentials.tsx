'use client';

import { useState } from 'react';
import { ChevronDown, FlaskConical } from 'lucide-react';
import type { UserRole } from '@/types/auth';
import { cn } from '@/utils/cn';

/**
 * The accounts `prisma/seed.ts` creates.
 *
 * They live HERE, in the component that draws them, rather than in
 * `utils/demoAccounts.ts` beside the on/off decision. That module is imported
 * by the sign-in page unconditionally; this one is referenced only from a
 * branch the bundler can prove is dead when the panel is off. Keeping the
 * credentials on this side of the line is what makes them absent from a
 * production bundle rather than merely unrendered.
 */
export interface DemoAccount {
  email: string;
  role: UserRole;
  /** What this account is FOR — the reason to pick it over the others. */
  label: string;
  description: string;
}

/**
 * The seed's own default, overridable for a deployment that seeded with a
 * different SEED_ADMIN_PASSWORD. Inlined at build time like every other
 * NEXT_PUBLIC_ value, which is one more reason the panel is gated.
 */
export const DEMO_PASSWORD =
  process.env.NEXT_PUBLIC_DEMO_PASSWORD || 'Admin@123';

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: 'admin@peoplepay360.com',
    role: 'ADMIN',
    label: 'Administrator',
    description: 'Everything, including settings and audit',
  },
  {
    email: 'hr@peoplepay360.com',
    role: 'HR_MANAGER',
    label: 'HR manager',
    description: 'People, organisation and time',
  },
  {
    email: 'payroll@peoplepay360.com',
    role: 'PAYROLL_OFFICER',
    label: 'Payroll officer',
    description: 'Attendance and pay, no governance hubs',
  },
  {
    email: 'employee@peoplepay360.com',
    role: 'EMPLOYEE',
    label: 'Employee',
    description: 'Own record only',
  },
];

interface DemoCredentialsProps {
  /**
   * Fills the sign-in form. Deliberately does NOT submit.
   *
   * The credentials land in the visible fields and the reader can see exactly
   * which account they are about to use before pressing Sign in. A button that
   * filled and submitted in one motion would be quicker and would also make it
   * impossible to tell, after the fact, which of four accounts you are looking
   * at the system as.
   */
  onFill: (email: string, password: string) => void;
  disabled?: boolean;
}

/**
 * The seeded accounts, one button each.
 *
 * The caller decides whether to render this at all, so the component never has
 * to be trusted with the gate.
 */
export default function DemoCredentials({ onFill, disabled }: DemoCredentialsProps) {
  // Closed by default. The panel is a convenience, not the primary path, and an
  // open list of four accounts above the fold makes the real form look like the
  // secondary option.
  const [open, setOpen] = useState(false);

  const fill = (account: DemoAccount) => onFill(account.email, DEMO_PASSWORD);

  return (
    <div className="mt-6 rounded-[var(--radius-card)] border border-dashed border-surface-border bg-surface-page/60 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-start text-sm font-medium text-text-body"
      >
        <FlaskConical className="h-4 w-4 shrink-0 text-brand-primary" aria-hidden />
        <span className="flex-1">Demo accounts</span>
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-text-muted transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      {open && (
        <>
          <p className="mt-2 text-xs text-text-muted">
            Seeded by <code className="font-mono">npm run db:seed</code>. Pick one to
            fill the form.
          </p>

          <ul className="mt-3 space-y-1.5">
            {DEMO_ACCOUNTS.map((account) => (
              <li key={account.email}>
                <button
                  type="button"
                  onClick={() => fill(account)}
                  disabled={disabled}
                  aria-label={`Fill the form with the ${account.label} account`}
                  className={cn(
                    'w-full rounded-[var(--radius-button)] border border-surface-border bg-surface-card px-3 py-2 text-start transition-colors',
                    'hover:border-brand-primary hover:bg-brand-primary/5',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-text-heading">
                      {account.label}
                    </span>
                    {/* The email is shown rather than hidden behind the label:
                        four buttons that differ only by a word are four buttons
                        somebody will press the wrong one of. */}
                    <span className="truncate font-mono text-[11px] text-text-muted">
                      {account.email}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-text-muted">
                    {account.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
