'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import visaService from '@/services/visaService';
import type {
  CreateLegalDocumentPayload,
  LegalDocumentListQuery,
  RenewLegalDocumentPayload,
  UpdateLegalDocumentPayload,
} from '@/types/legalDocument';

export const visaKeys = {
  all: ['legal-documents'] as const,
  list: (query: LegalDocumentListQuery) =>
    [...visaKeys.all, 'list', query] as const,
  detail: (id: string) => [...visaKeys.all, 'detail', id] as const,
  summary: () => [...visaKeys.all, 'summary'] as const,
  expiring: (days: number) => [...visaKeys.all, 'expiring', days] as const,
};

export function useVisas(query: LegalDocumentListQuery = {}) {
  return useQuery({
    queryKey: visaKeys.list(query),
    queryFn: () => visaService.list(query),
  });
}

export function useVisa(id: string | undefined) {
  return useQuery({
    queryKey: visaKeys.detail(id!),
    queryFn: () => visaService.get(id!),
    enabled: !!id,
  });
}

export function useVisaSummary() {
  return useQuery({
    queryKey: visaKeys.summary(),
    queryFn: () => visaService.summary(),
  });
}

export function useExpiringVisas(days = 30) {
  return useQuery({
    queryKey: visaKeys.expiring(days),
    queryFn: () => visaService.expiring(days),
  });
}

export function useCreateVisa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateLegalDocumentPayload) =>
      visaService.create(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: visaKeys.all }),
  });
}

export function useUpdateVisa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: UpdateLegalDocumentPayload;
    }) => visaService.update(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: visaKeys.all }),
  });
}

export function useRenewVisa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: RenewLegalDocumentPayload;
    }) => visaService.renew(id, payload),
    // A renewal touches two rows — the demoted old one and its successor — and
    // moves the summary counts, so nothing narrower than the subtree is correct.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: visaKeys.all }),
  });
}

export function useCancelVisa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => visaService.cancel(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: visaKeys.all }),
  });
}
