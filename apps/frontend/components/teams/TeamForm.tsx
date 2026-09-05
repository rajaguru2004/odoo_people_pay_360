'use client';

import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useDepartments } from '@/hooks/useDepartments';
import { useEmployees } from '@/hooks/useEmployees';
import { useCreateTeam, useUpdateTeam } from '@/hooks/useTeams';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';
import type { CreateTeamPayload, Team, TeamType } from '@/types/team';

const teamSchema = z.object({
  code: z.string().trim().min(1, 'Team code is required').max(32),
  name: z.string().trim().min(1, 'Team name is required').max(120),
  description: z.string().trim(),
  // A team always belongs somewhere: it is the department that owns the budget
  // the team's time is charged against.
  departmentId: z.string().min(1, 'Department is required'),
  teamLeadId: z.string(),
  type: z.string(),
  isActive: z.boolean(),
});

type TeamFormValues = z.infer<typeof teamSchema>;

const TYPE_OPTIONS: Array<{ value: TeamType; label: string }> = [
  { value: 'PERMANENT', label: 'Permanent' },
  { value: 'PROJECT', label: 'Project' },
  { value: 'CROSS_FUNCTIONAL', label: 'Cross functional' },
];

export default function TeamForm({ team }: { team?: Team }) {
  const router = useRouter();
  const createTeam = useCreateTeam();
  const updateTeam = useUpdateTeam();

  const departments = useDepartments();
  const people = useEmployees({ limit: 200, status: 'ACTIVE', sortBy: 'firstName', sortOrder: 'asc' });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<TeamFormValues>({
    resolver: zodResolver(teamSchema),
    defaultValues: {
      code: team?.code ?? '',
      name: team?.name ?? '',
      description: team?.description ?? '',
      departmentId: team?.departmentId ?? '',
      teamLeadId: team?.teamLeadId ?? '',
      type: team?.type ?? 'PERMANENT',
      isActive: team?.isActive ?? true,
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    const payload: CreateTeamPayload = {
      code: values.code.trim(),
      name: values.name.trim(),
      departmentId: values.departmentId,
      type: values.type as TeamType,
      isActive: values.isActive,
      ...(values.description.trim() ? { description: values.description.trim() } : {}),
      ...(values.teamLeadId ? { teamLeadId: values.teamLeadId } : {}),
    };

    try {
      if (team) {
        await updateTeam.mutateAsync({ id: team.id, payload });
        toast.success('Team updated');
        router.push(`/dashboard/teams/${team.id}`);
      } else {
        const created = await createTeam.mutateAsync(payload);
        toast.success('Team created');
        router.push(`/dashboard/teams/${created.data.id}`);
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not save this team'));
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Card>
        <CardHeader title="Team" subtitle="What the group is called and who owns it." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Team code"
            placeholder="TEAM-PAYROLL"
            error={errors.code?.message}
            {...register('code')}
          />
          <Input label="Team name" error={errors.name?.message} {...register('name')} />
          <Select
            label="Department"
            placeholder="Choose a department"
            error={errors.departmentId?.message}
            {...register('departmentId')}
          >
            {(departments.data?.data ?? []).map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
          <Select label="Team lead" placeholder="Not appointed yet" {...register('teamLeadId')}>
            {(people.data?.data ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {fullName(person)}
              </option>
            ))}
          </Select>
          <Select label="Team type" {...register('type')}>
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-text-body">
              <input
                type="checkbox"
                className="h-4 w-4 rounded-sm border-surface-border accent-brand-primary"
                {...register('isActive')}
              />
              Active
            </label>
          </div>
          <div className="sm:col-span-2">
            <Textarea
              label="Description"
              placeholder="What this team is responsible for."
              {...register('description')}
            />
          </div>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          {team ? 'Save changes' : 'Create team'}
        </Button>
      </div>
    </form>
  );
}
