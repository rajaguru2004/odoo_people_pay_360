'use client';

import { useRouter } from 'next/navigation';
import { ShieldOff } from 'lucide-react';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/Button';

/**
 * Where `ProtectedRoute` sends a signed-in user who may not open a screen.
 *
 * Its own route rather than a modal: the guard navigates, so the denial needs a
 * URL of its own. It names the situation without naming the screen — telling
 * someone what they were refused is telling them it exists.
 */
export default function ForbiddenPage() {
  const router = useRouter();

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-page p-6">
      <div className="w-full max-w-md rounded-[var(--radius-card)] border border-surface-border bg-surface-card">
        <EmptyState
          headingLevel={1}
          icon={<ShieldOff className="h-6 w-6" aria-hidden />}
          title="You do not have access to this page"
          description="Your role does not include this screen. If that looks wrong, ask an administrator to review your access."
          action={
            // `replace`, not `push`: the denied URL is still in history, and a
            // push would leave Back pointing straight at the bounce that sent
            // the user here.
            <Button onClick={() => router.replace('/dashboard')}>Back to dashboard</Button>
          }
        />
      </div>
    </div>
  );
}
