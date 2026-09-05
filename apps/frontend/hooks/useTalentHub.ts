'use client';

import { useModuleHub } from './useModuleHub';
import type { TalentHubSummary } from '@/types/talentHub';

/**
 * How people are developed, recognised and heard.
 *
 * The version this replaces counted rewards and disciplinary actions in the
 * BROWSER, over one page of each list, and rendered a panel telling the reader
 * so. Both tables carry a real business date; there was simply no endpoint that
 * could filter on it. There is now, and the disclaimer panel goes with it.
 */
export function useTalentHub() {
  return useModuleHub<TalentHubSummary>('talent', '/talent/hub-summary');
}
