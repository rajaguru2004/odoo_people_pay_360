'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import libraryItemService, {
  type LibraryType,
  type SaveLibraryItemPayload,
} from '@/services/libraryItemService';
import { balanceKeys, leaveKeys } from './useLeaveRequests';

export const libraryKeys = {
  all: ['library-items'] as const,
  list: (type: LibraryType | undefined, activeOnly: boolean | undefined) =>
    [...libraryKeys.all, 'list', type ?? 'any', activeOnly ?? 'any'] as const,
};

export function useLibraryItems(type?: LibraryType, activeOnly?: boolean) {
  return useQuery({
    queryKey: libraryKeys.list(type, activeOnly),
    queryFn: () => libraryItemService.list(type, activeOnly),
  });
}

/**
 * Every library write invalidates the LEAVE subtree as well.
 *
 * Adding a leave type changes what a request form may offer and what a balance
 * screen has a column for, so a cached picker without the new row is a screen
 * that quietly disagrees with the database about which types exist.
 */
function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
  void queryClient.invalidateQueries({ queryKey: leaveKeys.types() });
  void queryClient.invalidateQueries({ queryKey: balanceKeys.all });
}

export function useCreateLibraryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: SaveLibraryItemPayload) =>
      libraryItemService.create(payload),
    onSuccess: () => invalidate(queryClient),
  });
}

export function useUpdateLibraryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: SaveLibraryItemPayload;
    }) => libraryItemService.update(id, payload),
    onSuccess: () => invalidate(queryClient),
  });
}

export function useDeactivateLibraryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => libraryItemService.deactivate(id),
    onSuccess: () => invalidate(queryClient),
  });
}
