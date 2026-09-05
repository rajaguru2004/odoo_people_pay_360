'use client';

import { useQueries } from '@tanstack/react-query';
import axiosInstance from '@/lib/axios';
import { useAuthStore } from '@/store/authStore';

/**
 * The hubs whose modules have no aggregate endpoint of their own.
 *
 * This file used to hold five. Organization left in Phase F; Workplace and
 * Talent left in Phase G; Schedules reads `/calendar/hub-summary`. **System is
 * the last one**, and it no longer counts anything off a page — both of its
 * figures come from real aggregates (`/audit-logs/stats` and
 * `/notifications/unread-count`), so the row-envelope helpers this file carried
 * went with the hubs that needed them.
 *
 * The rule those helpers existed to enforce is worth keeping in mind for the
 * next hub: where a list is paginated, prefer the meta total over the page
 * length. A page count silently capped at 20 is the failure mode every hub that
 * lived here had at least once.
 */

/*
 * The Organization hub moved OFF this file in Phase F.
 *
 * It now reads one server aggregate (`/organization/hub-summary`) through
 * `hooks/useOrganizationHub.ts`. It used to count pending change requests from
 * the LENGTH of a page of `/departments/change-requests`, which sends no
 * pagination meta — so every queue longer than a page read short on the one
 * card whose whole job is to say how much work is waiting.
 */

/*
 * Workplace and Talent moved OFF this file in Phase G.
 *
 * They now read one server aggregate each — `/workplace/hub-summary` and
 * `/talent/hub-summary` — through `hooks/useWorkplaceHub.ts` and
 * `hooks/useTalentHub.ts`.
 *
 * Talent is the one worth remembering: it counted rewards and disciplinary
 * actions from the LENGTH of one page of each list, because neither
 * `/rewards` nor `/disciplines` accepts a date range. The page rendered a panel
 * telling the reader that its own numbers were browser counts. Both tables
 * carry a real business date; there was simply no endpoint that could reach it.
 */

/* ── System ─────────────────────────────────────────────────────────────── */

export interface AuditRow {
  id: string;
  action?: string;
  resource?: string;
  createdAt?: string;
  user?: { email?: string; employee?: { fullName?: string } | null } | null;
}

export interface AuditStats {
  windowHours: number;
  total: number;
  destructive: number;
  byAction: Array<{ action: string; count: number }>;
  byResource: Array<{ resource: string; count: number }>;
  topActors: Array<{ userId: string | null; name: string; count: number }>;
}

export function useSystemHub() {
  // `audit-logs` is `@Roles('ADMIN')` on the whole controller, but the System
  // hub is navigable by HR_MANAGER — so HR used to load this page, fire a
  // request it could never be answered, and get a console full of 403s on a
  // screen that was otherwise fine. The request is simply not made now.
  //
  // Deliberately NOT widening the endpoint: who may read the audit trail is a
  // security decision, and it is not this hub's to take.
  const { user } = useAuthStore();
  const canReadAudit = user?.role === 'ADMIN';
  const key = ['module', 'system'] as const;

  const results = useQueries({
    queries: [
      {
        // `/audit-logs/stats` (Phase B). This used to be counted in the browser
        // from one page of the log, so a busy day under-reported and the figure
        // was only ever as wide as the page size. Now the window is a real time
        // window, aggregated in the database.
        queryKey: [...key, 'auditStats'],
        queryFn: () =>
          axiosInstance.get('/audit-logs/stats', { params: { hours: 24 } }).then((r: any) => r?.data ?? r),
        enabled: canReadAudit,
        staleTime: 60_000,
      },
      {
        queryKey: [...key, 'notifications'],
        queryFn: () => axiosInstance.get('/notifications/unread-count'),
        staleTime: 60_000,
      },
    ],
  });

  const [audit, notifications] = results;
  const stats = audit.data as AuditStats | undefined;
  const nc: any = (notifications.data as any)?.data ?? notifications.data;

  return {
    stats,
    last24h: stats?.total ?? NaN,
    destructive24h: stats?.destructive ?? NaN,
    topActors: stats?.topActors ?? [],
    unread: Number(nc?.count ?? nc?.unread ?? NaN),
    loading: (canReadAudit && audit.isLoading) || notifications.isLoading,
    auditFailed: audit.isError,
    /**
     * The audit figures were never asked for, because this role may not read
     * them. Distinct from `auditFailed` on purpose: "not allowed to know" and
     * "tried and could not find out" are different sentences, and a card that
     * blames a failure for a permission is misleading.
     */
    auditRestricted: !canReadAudit,
    notificationsFailed: notifications.isError,
  };
}
