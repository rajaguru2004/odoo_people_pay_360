'use client';

import { useModuleHub } from './useModuleHub';
import type { WorkplaceHubSummary } from '@/types/workplaceHub';

/**
 * What the company owns, owes and is running.
 *
 * The aggregate reports all five `ProjectStatus` values, where `/projects/stats`
 * returns four and drops `PLANNING` and `CANCELLED` — which is why the previous
 * project mix bar could not add up to the total printed beside it.
 */
export function useWorkplaceHub() {
  return useModuleHub<WorkplaceHubSummary>('workplace', '/workplace/hub-summary');
}
