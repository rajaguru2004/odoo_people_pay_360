'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import changeRequestService, {
  type ChangeRequestListQuery,
} from '@/services/changeRequestService';
import type { ReviewPayload } from '@/types/common';
import type { CreateChangeRequestPayload } from '@/types/department';
import { departmentKeys } from './useDepartments';

export const changeRequestKeys = {
  all: ['department-change-requests'] as const,
  list: (query: ChangeRequestListQuery) =>
    [...changeRequestKeys.all, 'list', query] as const,
  detail: (id: string) => [...changeRequestKeys.all, 'detail', id] as const,
};

export function useChangeRequests(query: ChangeRequestListQuery = {}) {
  return useQuery({
    queryKey: changeRequestKeys.list(query),
    queryFn: () => changeRequestService.list(query),
  });
}

export function useChangeRequest(id: string | undefined) {
  return useQuery({
    queryKey: changeRequestKeys.detail(id!),
    queryFn: () => changeRequestService.get(id!),
    enabled: !!id,
  });
}

export function useCreateChangeRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateChangeRequestPayload) =>
      changeRequestService.create(payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: changeRequestKeys.all }),
  });
}

export function useReviewChangeRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ReviewPayload }) =>
      changeRequestService.review(id, payload),
    // Approving WRITES to the department, so both subtrees are stale. Only
    // invalidating the queue would leave the org chart showing the old head.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: changeRequestKeys.all });
      void queryClient.invalidateQueries({ queryKey: departmentKeys.all });
    },
  });
}

export function useCancelChangeRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => changeRequestService.cancel(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: changeRequestKeys.all }),
  });
}
