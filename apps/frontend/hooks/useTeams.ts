'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import teamService from '@/services/teamService';
import type {
  AddTeamMemberPayload,
  CreateTeamPayload,
  UpdateTeamMemberPayload,
  UpdateTeamPayload,
} from '@/types/team';

export const teamKeys = {
  all: ['teams'] as const,
  list: (params: { departmentId?: string; includeInactive?: boolean }) =>
    [...teamKeys.all, 'list', params] as const,
  detail: (id: string) => [...teamKeys.all, 'detail', id] as const,
};

export function useTeams(
  params: { departmentId?: string; includeInactive?: boolean } = {},
) {
  return useQuery({
    queryKey: teamKeys.list(params),
    queryFn: () => teamService.list(params),
  });
}

export function useTeam(id: string | undefined) {
  return useQuery({
    queryKey: teamKeys.detail(id!),
    queryFn: () => teamService.get(id!),
    enabled: !!id,
  });
}

export function useCreateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTeamPayload) => teamService.create(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: teamKeys.all }),
  });
}

export function useUpdateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateTeamPayload }) =>
      teamService.update(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: teamKeys.all }),
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => teamService.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: teamKeys.all }),
  });
}

export function useAddTeamMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      teamId,
      payload,
    }: {
      teamId: string;
      payload: AddTeamMemberPayload;
    }) => teamService.addMember(teamId, payload),
    // The roster count on the LIST changes too, so the whole subtree goes —
    // refreshing only the detail leaves "4 members" beside a list of five.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: teamKeys.all }),
  });
}

export function useUpdateTeamMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      teamId,
      memberId,
      payload,
    }: {
      teamId: string;
      memberId: string;
      payload: UpdateTeamMemberPayload;
    }) => teamService.updateMember(teamId, memberId, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: teamKeys.all }),
  });
}

export function useRemoveTeamMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, memberId }: { teamId: string; memberId: string }) =>
      teamService.removeMember(teamId, memberId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: teamKeys.all }),
  });
}
