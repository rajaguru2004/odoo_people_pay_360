'use client';

import { useQuery } from '@tanstack/react-query';
import profileTemplateService from '@/services/profileTemplateService';
import { ResolvedTemplate, TemplateMode } from '@/types/profile-template';

/**
 * The active employee-form template for the current user.
 *
 * Long `staleTime` on purpose: a template changes when an admin edits it, which
 * is roughly never compared with how often an employee form renders. The admin
 * builder invalidates this key after a write so its own preview stays live.
 */
export const PROFILE_TEMPLATE_KEY = 'profile-template-active';

export function useProfileTemplate(
  params: { branchId?: string; mode?: TemplateMode; employeeId?: string } = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery<ResolvedTemplate>({
    queryKey: [
      PROFILE_TEMPLATE_KEY,
      params.branchId ?? null,
      params.mode ?? 'EDIT',
      params.employeeId ?? null,
    ],
    queryFn: () => profileTemplateService.getActive(params),
    staleTime: 5 * 60_000,
    // A template failure must not leave the user staring at a spinner: callers
    // fall back to rendering nothing template-driven rather than retrying hard.
    retry: 1,
    enabled: options.enabled ?? true,
  });
}
