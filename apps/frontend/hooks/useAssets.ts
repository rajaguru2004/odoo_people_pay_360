'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import assetService from '@/services/assetService';
import type {
  AssignAssetData,
  CreateAssetData,
  QueryAssetsParams,
  ReturnAssetData,
} from '@/types/asset';

export const assetKeys = {
  all: ['assets'] as const,
  list: (params: QueryAssetsParams) => [...assetKeys.all, 'list', params] as const,
  detail: (id: string) => [...assetKeys.all, 'detail', id] as const,
  summary: () => [...assetKeys.all, 'summary'] as const,
  mine: (openOnly: boolean) => [...assetKeys.all, 'mine', openOnly] as const,
  open: (employeeId?: string) =>
    [...assetKeys.all, 'open', employeeId ?? 'everyone'] as const,
  clearance: (employeeId: string) =>
    [...assetKeys.all, 'clearance', employeeId] as const,
};

export function useAssets(params: QueryAssetsParams = {}) {
  return useQuery({
    queryKey: assetKeys.list(params),
    queryFn: () => assetService.list(params),
  });
}

export function useAsset(id: string | undefined) {
  return useQuery({
    queryKey: assetKeys.detail(id!),
    queryFn: () => assetService.get(id!),
    enabled: !!id,
  });
}

/**
 * The register totals.
 *
 * `enabled` rather than a catch: the route is ADMIN/HR only, and a manager who
 * may legitimately read the register would otherwise fire a request they are
 * refused — which the axios interceptor turns into a permission dialog over a
 * screen they are entitled to.
 */
export function useAssetSummary(enabled = true) {
  return useQuery({
    queryKey: assetKeys.summary(),
    queryFn: () => assetService.summary(),
    enabled,
  });
}

export function useMyAssets(openOnly = false) {
  return useQuery({
    queryKey: assetKeys.mine(openOnly),
    queryFn: () => assetService.mine(openOnly),
  });
}

export function useOpenAssignments(employeeId?: string) {
  return useQuery({
    queryKey: assetKeys.open(employeeId),
    queryFn: () => assetService.openAssignments(employeeId),
  });
}

export function useAssetClearance(employeeId: string | undefined) {
  return useQuery({
    queryKey: assetKeys.clearance(employeeId!),
    queryFn: () => assetService.clearance(employeeId!),
    enabled: !!employeeId,
  });
}

/** Every write moves custody, which moves the totals and the clearance too. */
function invalidateAssets(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({ queryKey: assetKeys.all });
}

export function useCreateAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAssetData) => assetService.create(payload),
    onSuccess: () => invalidateAssets(queryClient),
  });
}

export function useDeleteAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => assetService.remove(id),
    onSuccess: () => invalidateAssets(queryClient),
  });
}

export function useAssignAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: AssignAssetData) => assetService.assign(payload),
    onSuccess: () => invalidateAssets(queryClient),
  });
}

export function useReturnAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      assignmentId,
      payload,
    }: {
      assignmentId: string;
      payload: ReturnAssetData;
    }) => assetService.returnAsset(assignmentId, payload),
    onSuccess: () => invalidateAssets(queryClient),
  });
}

export function useAcknowledgeAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ assignmentId, note }: { assignmentId: string; note?: string }) =>
      assetService.acknowledge(assignmentId, note),
    onSuccess: () => invalidateAssets(queryClient),
  });
}
