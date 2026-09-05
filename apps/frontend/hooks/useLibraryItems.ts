'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import libraryService from '@/services/libraryService';
import type {
  CreateLibraryItemData,
  LibraryItemQuery,
  UpdateLibraryItemPayload,
} from '@/types/library';

export const libraryKeys = {
  all: ['library-items'] as const,
  list: (query: LibraryItemQuery) => [...libraryKeys.all, 'list', query] as const,
};

export function useLibraryItems(query: LibraryItemQuery = {}) {
  return useQuery({
    queryKey: libraryKeys.list(query),
    queryFn: () => libraryService.list(query),
  });
}

export function useCreateLibraryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateLibraryItemData) => libraryService.create(payload),
    // The whole subtree, not the one list that was edited: leave types are read
    // by the leave screens under their own filters, and a narrower key leaves
    // those holding a list that no longer matches the library.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
  });
}

export function useUpdateLibraryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateLibraryItemPayload }) =>
      libraryService.update(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
  });
}

export function useDeleteLibraryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => libraryService.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
  });
}

export function useSeedLibraryDefaults() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => libraryService.seed(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
  });
}
