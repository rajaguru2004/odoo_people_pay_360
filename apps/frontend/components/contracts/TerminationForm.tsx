'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useCreateTermination } from '@/hooks/useContracts';
import { apiErrorMessage } from '@/utils/apiError';
import type { TerminationCategory } from '@/types/contract';

const CATEGORIES: Array<{ value: TerminationCategory; label: string }> = [
  { value: 'RESIGNATION', label: 'Resignation' },
  { value: 'DISMISSAL', label: 'Dismissal' },
  { value: 'END_OF_CONTRACT', label: 'End of contract' },
  { value: 'RETIREMENT', label: 'Retirement' },
  { value: 'REDUNDANCY', label: 'Redundancy' },
  { value: 'MUTUAL_AGREEMENT', label: 'Mutual agreement' },
  { value: 'DEATH', label: 'Death in service' },
];

const terminationSchema = z
  .object({
    category: z.string().min(1, 'A reason category is required'),
    noticeDate: z.string().min(1, 'Notice date is required'),
    terminationDate: z.string().min(1, 'Last working day is required'),
    reason: z.string().trim().min(1, 'A reason is required'),
    noticeServed: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (
      values.noticeDate &&
      values.terminationDate &&
      values.terminationDate < values.noticeDate
    ) {
      // Notice cannot be given after the person has already left; the settlement
      // is calculated from the gap between these two dates.
      ctx.addIssue({
        code: 'custom',
        path: ['terminationDate'],
        message: 'The last working day cannot fall before notice was given',
      });
    }
  });

type TerminationFormValues = z.infer<typeof terminationSchema>;

/**
 * Raising a termination request — which is not the same act as ending the
 * employment.
 *
 * Nothing here changes the contract or the employee record. An ADMIN approving
 * the request in the queue is the only thing that does, which is why this form
 * asks for a reason it will be read by somebody else.
 */
export default function TerminationForm({
  contractId,
  onDone,
  onCancel,
}: {
  contractId: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const createTermination = useCreateTermination();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<TerminationFormValues>({
    resolver: zodResolver(terminationSchema),
    defaultValues: {
      category: 'RESIGNATION',
      noticeDate: new Date().toISOString().slice(0, 10),
      terminationDate: '',
      reason: '',
      noticeServed: true,
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await createTermination.mutateAsync({
        contractId,
        category: values.category as TerminationCategory,
        noticeDate: values.noticeDate,
        terminationDate: values.terminationDate,
        reason: values.reason.trim(),
        noticeServed: values.noticeServed,
      });
      toast.success('Termination requested — an administrator has to approve it');
      onDone?.();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not raise this termination request'));
    }
  });

  return (
    <Card>
      <CardHeader
        title="Request termination"
        subtitle="This raises a request. Employment ends only when an administrator approves it."
      />
      <form onSubmit={onSubmit} noValidate>
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Select label="Category" error={errors.category?.message} {...register('category')}>
            {CATEGORIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Input
            type="date"
            label="Notice date"
            error={errors.noticeDate?.message}
            {...register('noticeDate')}
          />
          <Input
            type="date"
            label="Last working day"
            error={errors.terminationDate?.message}
            {...register('terminationDate')}
          />
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-text-body">
              <input
                type="checkbox"
                className="h-4 w-4 rounded-sm border-surface-border accent-brand-primary"
                {...register('noticeServed')}
              />
              {/* Whether the notice is worked or paid out reaches the final
                  settlement, so it is asked here rather than assumed. */}
              Notice will be worked, not paid out
            </label>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Textarea
              label="Reason"
              rows={3}
              error={errors.reason?.message}
              placeholder="What the approver needs to know."
              {...register('reason')}
            />
          </div>
        </CardBody>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-surface-border-light px-5 py-4">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" variant="danger" isLoading={isSubmitting}>
            Submit request
          </Button>
        </div>
      </form>
    </Card>
  );
}
