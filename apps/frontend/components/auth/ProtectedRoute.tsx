'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { hasPermission } from '@/utils/permissions';
import type { UserRole } from '@/types/auth';

interface ProtectedRouteProps {
  children: ReactNode;
  /** A permission string from `utils/permissions.ts`. */
  requiredPermission?: string;
  requiredRoles?: UserRole[];
  /**
   * The employee this route is about, when the route is about one person.
   *
   * A permission answers "may this ROLE see this KIND of thing", which is the
   * wrong question for `/dashboard/employees/[id]`: an employee is entitled to
   * their own record and to nobody else's, and the server agrees. Passing the id
   * from the URL keeps the check answerable BEFORE the record loads, which is
   * what a route guard needs.
   */
  selfEmployeeId?: string;
}

/**
 * What the guard has concluded, as ONE value rather than a pair of booleans.
 *
 * The auth store has three states, not two. `persist` serves the
 * pre-rehydration state during React's hydration pass, so between the first
 * client render and a settled session the store legitimately says "I do not know
 * yet" — and a guard holding two booleans has nowhere to put that. It reads the
 * blank as "signed out" and navigates the wrong way, or reads a session flag
 * with no user behind it as "cleared" and renders a protected page to a caller
 * it has not checked.
 */
type Verdict = 'pending' | 'allow' | 'signIn' | 'forbidden';

/**
 * Client-side route gate.
 *
 * Wrap a screen that only some roles may open. The verdict is computed once and
 * read by both the effect and the render body, so what navigates and what paints
 * can never disagree.
 *
 * This is a UI affordance, exactly like `utils/permissions.ts`: it decides what
 * to draw, and the backend's RolesGuard decides what is allowed.
 */
export default function ProtectedRoute({
  children,
  requiredPermission,
  requiredRoles,
  selfEmployeeId,
}: ProtectedRouteProps) {
  const router = useRouter();
  const { user, isAuthenticated, isLoading, hasHydrated } = useAuthStore();

  // Read both shapes on purpose. `user.employee.id` is the joined record and
  // `user.employeeId` is the column; which one a session carries depends on
  // whether it came from a login response or from a restored store, and a guard
  // that reads only one silently denies the other.
  const ownEmployeeId = user?.employee?.id ?? user?.employeeId ?? undefined;
  const isSelf = Boolean(selfEmployeeId && ownEmployeeId && ownEmployeeId === selfEmployeeId);

  const missingPermission = Boolean(
    requiredPermission && user && !hasPermission(user.role, requiredPermission),
  );
  const wrongRole = Boolean(requiredRoles && user && !requiredRoles.includes(user.role));
  // Viewing your own record satisfies the guard on its own. It widens nothing
  // else: the page still projects per role, and the server still decides what
  // the payload contains.
  const denied = !isSelf && (missingPermission || wrongRole);

  /**
   * Can the session be decided from at all?
   *
   * Two things have to hold. Storage must have been read — `hasHydrated`,
   * without which `isAuthenticated: false` means nothing. And the session must
   * have settled: it either carries a `user` to check, or it has concluded there
   * is nobody. A session flag with no user behind it is the middle of a restore,
   * not a cleared visitor.
   *
   * `isLoading` counts only while there is no user yet. Once an identity is
   * known the verdict is decidable, and a background refresh must not blank a
   * page the user is legitimately on.
   */
  const sessionResolved = hasHydrated && (user !== null || (!isAuthenticated && !isLoading));

  const verdict: Verdict = !sessionResolved
    ? 'pending'
    : !isAuthenticated
      ? 'signIn'
      : denied
        ? 'forbidden'
        : 'allow';

  useEffect(() => {
    // In an effect, via the router — never `redirect()` in the render body.
    // That function belongs to Server Components; thrown from a client render it
    // abandons the render mid-flight and React retries a half-built tree.
    if (verdict === 'signIn') {
      router.replace('/login');
    } else if (verdict === 'forbidden') {
      router.replace('/403');
    }
    // `pending` navigates nowhere on purpose: nobody has answered yet, and
    // guessing is what sends a signed-in user to /login and back.
  }, [verdict, router]);

  // Anything short of `allow` renders nothing. Showing the children for even one
  // frame flashes data the user may not see, and the requests behind it are
  // fired and refused — a 401 from one of them redirects the window and abandons
  // the /403 navigation this guard just started.
  if (verdict !== 'allow') return null;

  return <>{children}</>;
}
