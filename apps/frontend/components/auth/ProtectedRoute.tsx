'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { hasPermission, PERMISSIONS } from '@/utils/permissions';
import { UserRole } from '@/types/auth';

/**
 * Client-side route gate.
 *
 * This used to call `redirect()` from `next/navigation` in the render body.
 * That function is built for Server Components and Route Handlers, where it
 * throws a control-flow signal the framework unwinds. Thrown from a Client
 * Component's render it aborts the render mid-flight, and React's retry of the
 * partially-rendered tree ends in
 *
 *     Minified React error #310 — rendered more hooks than during the previous render
 *
 * so a user who should have seen the 403 page saw a crashed one instead. The
 * only routes where this surfaced were `/dashboard/banks` and
 * `/dashboard/banks/config`, because they are the only two that have to deny an
 * *authenticated* non-admin; everywhere else the denial path is never taken.
 *
 * Navigation now happens in an effect, after render, via the router — the
 * supported way to leave a Client Component. Hooks run unconditionally and in a
 * fixed order, so the render can no longer be abandoned halfway.
 *
 * ---
 *
 * The second defect, and why this file computes a `verdict` rather than a pair
 * of booleans.
 *
 * The guard used to ask two yes/no questions — "authenticated?" and "denied?" —
 * of a store that has THREE states, not two. `auth-storage` is a zustand
 * `persist` store, and `useSyncExternalStore` serves `getInitialState()` (the
 * state as it was BEFORE rehydration) during React's hydration pass; `loadUser()`
 * in `DashboardLayout` then refreshes it over the network. So between the first
 * client render and a settled session, the store legitimately passes through
 * "I do not know yet" — and the old code had nowhere to put that:
 *
 *   - `user: null, isAuthenticated: false` — logged out, OR not read yet. It
 *     took the first reading and fired `router.replace('/login')`, a wrong-way
 *     navigation that then raced the correct `/403` one a render later.
 *   - `user: null, isAuthenticated: true` — a session with no identity attached
 *     (rehydrated flag ahead of the record, or `loadUser()` still in flight).
 *     Every check was short-circuited by `user &&`, so `denied` came out FALSE
 *     and `!isAuthenticated || denied` came out false too: the guard **rendered
 *     the protected page to a user it had not yet cleared**, fired its requests,
 *     and never called `router.replace` at all. That is the intermittent
 *     "HR stayed on /dashboard/banks" failure — not a slow redirect, an absent
 *     one.
 *
 * Both are fixed by refusing to answer until the store can be answered from:
 * `hasHydrated` says storage has been read, and a settled session is one that
 * either carries a `user` or has definitively concluded there is nobody. Until
 * then the verdict is `pending` — render nothing, navigate nowhere. This is a
 * state check, not a delay: nothing here waits on a timer, and the verdict is
 * recomputed the moment the store changes.
 *
 * The verdict is computed once and both the effect and the render body read it,
 * so the thing that navigates and the thing that decides what to paint can never
 * disagree.
 */

interface ProtectedRouteProps {
    children: React.ReactNode;
    requiredPermission?: keyof typeof PERMISSIONS;
    requiredRoles?: UserRole[];
    /**
     * The employee this route is about, when the route is about one person.
     *
     * A permission name answers "may this ROLE see this KIND of thing", which
     * is the wrong question for `/dashboard/employees/[id]`: an employee is
     * entitled to their own record and to no-one else's, and the server agrees
     * (`GET /employees/:id` admits EMPLOYEE for self). Without this, the guard
     * redirected them to /403 before the request was ever made — and the page's
     * own `canEditProfile = ... || user.employee.id === id` was unreachable
     * code.
     *
     * Passing the id from the URL keeps the check answerable BEFORE the record
     * loads, which is what a route guard needs.
     */
    selfEmployeeId?: string;
}

/**
 * What the guard has concluded, as one value.
 *
 * `pending` is the state the old two-boolean version could not express, and the
 * one every intermittent failure came out of.
 */
type Verdict = 'pending' | 'allow' | 'signIn' | 'forbidden';

export default function ProtectedRoute({
    children,
    requiredPermission,
    requiredRoles,
    selfEmployeeId,
}: ProtectedRouteProps) {
    const { user, isAuthenticated, isLoading, hasHydrated } = useAuthStore();
    const router = useRouter();

    // Viewing your own record satisfies the guard on its own. It does not widen
    // anything else: the page still projects per role, and the server still
    // decides what the payload contains.
    // Read both shapes on purpose. `user.employee.id` is the joined record and
    // `user.employeeId` is the column; which one a session carries depends on
    // whether it came from a login response or from a restored store, and a
    // guard that reads only one of them silently denies the other.
    const ownEmployeeId =
        (user as { employee?: { id?: string }; employeeId?: string } | null)
            ?.employee?.id ??
        (user as { employeeId?: string } | null)?.employeeId;
    const isSelf = Boolean(
        selfEmployeeId && ownEmployeeId && ownEmployeeId === selfEmployeeId,
    );

    const missingPermission = Boolean(
        requiredPermission && user && !hasPermission(user.role, requiredPermission),
    );
    const wrongRole = Boolean(requiredRoles && user && !requiredRoles.includes(user.role));
    const denied = !isSelf && (missingPermission || wrongRole);

    /**
     * Can the session be decided from at all?
     *
     * Two things have to be true. Storage must have been read — `hasHydrated`,
     * without which `isAuthenticated: false` means nothing. And the session must
     * have settled on an answer: either it carries a `user` to check, or it has
     * concluded there is nobody (not authenticated, nothing in flight). A
     * session flag with no `user` behind it is the middle of a restore, not a
     * cleared user.
     *
     * `isLoading` only counts while there is no `user` yet. Once an identity is
     * known the verdict is decidable, and a background `loadUser()` refresh must
     * not blank a page the user is already legitimately on.
     */
    const sessionResolved =
        hasHydrated && (user !== null || (!isAuthenticated && !isLoading));

    const verdict: Verdict = !sessionResolved
        ? 'pending'
        : !isAuthenticated
            ? 'signIn'
            : denied
                ? 'forbidden'
                : 'allow';

    useEffect(() => {
        if (verdict === 'signIn') {
            router.replace('/login');
        } else if (verdict === 'forbidden') {
            router.replace('/403');
        }
        // `pending` navigates nowhere on purpose: the guard has not been given
        // an answer yet, and guessing one is what produced the /login-then-/403
        // double navigation.
    }, [verdict, router]);

    // Render nothing unless the session has been checked AND cleared. Showing
    // the children for even one frame would flash data the user is not allowed
    // to see, and the requests behind it would be fired and refused — a 401 from
    // one of them redirects the whole window and abandons the /403 navigation.
    if (verdict !== 'allow') return null;

    return <>{children}</>;
}
