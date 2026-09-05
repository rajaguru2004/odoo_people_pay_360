'use client';

import { useModuleHub } from './useModuleHub';
import type { WorkplaceHubSummary } from '@/types/workplaceHub';

/** What the company owns and owes: assets, clearances and letter requests. */
export function useWorkplaceHub() {
  return useModuleHub<WorkplaceHubSummary>('workplace', '/workplace/hub-summary');
}
