'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import letterService from '@/services/letterService';
import { vaultKeys } from './useVault';
import type { RequestLetterData } from '@/types/letter';

export const letterKeys = {
  all: ['letters'] as const,
  templates: (activeOnly: boolean) =>
    [...letterKeys.all, 'templates', activeOnly] as const,
  mine: () => [...letterKeys.all, 'mine'] as const,
  queue: (status?: string) => [...letterKeys.all, 'queue', status ?? 'all'] as const,
};

export function useLetterTemplates(activeOnly = true) {
  return useQuery({
    queryKey: letterKeys.templates(activeOnly),
    queryFn: () => letterService.listTemplates(activeOnly),
  });
}

export function useMyLetters() {
  return useQuery({
    queryKey: letterKeys.mine(),
    queryFn: () => letterService.myRequests(),
  });
}

export function useLetterQueue(status?: string) {
  return useQuery({
    queryKey: letterKeys.queue(status),
    queryFn: () => letterService.list(status),
  });
}

export function useRequestLetter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RequestLetterData) => letterService.request(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: letterKeys.all });
      // An instantly issued letter is filed in the vault on the way out, so the
      // documents screen is stale the moment this resolves.
      void queryClient.invalidateQueries({ queryKey: vaultKeys.all });
    },
  });
}

export function useIssueLetter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => letterService.issue(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: letterKeys.all });
      void queryClient.invalidateQueries({ queryKey: vaultKeys.all });
    },
  });
}

export function useRejectLetter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      letterService.reject(id, reason),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: letterKeys.all }),
  });
}
