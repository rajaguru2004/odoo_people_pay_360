'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import libraryItemService, {
  type LibraryType,
  type SaveLibraryItemPayload,
} from '@/services/libraryItemService';
import type {
  CreateLibraryItemPayload,
  LibraryItemQuery,
} from '@/types/library';
import { balanceKeys, leaveKeys } from './useLeaveRequests';

export const libraryKeys = {
  all: ['library-items'] as const,
  list: (type: LibraryType | undefined, activeOnly: boolean | undefined) =>
    [...libraryKeys.all, 'list', type ?? 'any', activeOnly ?? 'any'] as const,
};

/**
 * Accepts either the positional form or a `{ type, activeOnly }` query object.
 * Both spellings are in use across the settings screens and the self-service
 * pages, and normalising here is cheaper than touching every caller.
 */
export function useLibraryItems(
  typeOrQuery?: LibraryType | LibraryItemQuery,
  activeOnlyArg?: boolean,
) {
  const query: LibraryItemQuery =
    typeof typeOrQuery === 'string'
      ? { type: typeOrQuery, activeOnly: activeOnlyArg }
      : (typeOrQuery ?? {});

  return useQuery({
    queryKey: libraryKeys.list(query.type, query.activeOnly),
    queryFn: () => libraryItemService.list(query.type, query.activeOnly),
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
    mutationFn: (payload: CreateLibraryItemPayload) =>
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

/**
 * The same soft DELETE as `useDeactivateLibraryItem`, under the name the
 * settings screen calls it by. There is no hard delete: the label is the key a
 * year of history is stored against.
 */
export const useDeleteLibraryItem = useDeactivateLibraryItem;

export function useSeedLibraryDefaults() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => libraryItemService.seedDefaults(),
    onSuccess: () => invalidate(queryClient),
  });
}
