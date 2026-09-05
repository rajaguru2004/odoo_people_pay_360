'use client';

import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ClipboardCheck, Play } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';

/**
 * The period a run is for, and nothing else.
 *
 * The server resolves a month and a year to the actual period — its first day,
 * its last day and the label it will be known by — so this form never computes
 * a date. A browser that worked out `periodStart` itself would put the run in
 * the previous month for every reader west of Greenwich.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Every field is a STRING here and converted only when the payload is built.
 *
 * A `<select>` yields strings whatever the values look like, and a schema that
 * declared `number` would fail validation on the very first render with a
 * message about a type the user cannot see.
 */
const runSchema = z.object({
  month: z.string().min(1, 'Choose a month'),
  year: z.string().min(1, 'Choose a year'),
  notes: z.string(),
});

type RunFormFields = z.infer<typeof runSchema>;

export interface PayrollRunFormValues {
  month: number;
  year: number;
  notes?: string;
}

export interface PayrollRunFormProps {
  /** Ask the server what this period WOULD refuse. Writes nothing. */
  onCheck: (values: PayrollRunFormValues) => void;
  /** Create the run and calculate it. */
  onGenerate: (values: PayrollRunFormValues) => void;
  checking?: boolean;
  generating?: boolean;
  /** The server's verdict from the standing pre-flight. */
  canGenerate?: boolean;
  /**
   * The period the standing pre-flight actually answered for.
   *
   * Moving the picker after a check invalidates it: the findings on screen are
   * about August and the button would generate September, which is the one
   * mistake this screen exists to prevent.
   */
  checkedPeriod?: { month: number; year: number } | null;
  /** Defaults for the picker, so the page can open on the period it means. */
  defaultMonth: number;
  defaultYear: number;
}

export default function PayrollRunForm({
  onCheck,
  onGenerate,
  checking = false,
  generating = false,
  canGenerate = false,
  checkedPeriod = null,
  defaultMonth,
  defaultYear,
}: PayrollRunFormProps) {
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RunFormFields>({
    resolver: zodResolver(runSchema),
    defaultValues: {
      month: String(defaultMonth),
      year: String(defaultYear),
      notes: '',
    },
  });

  // `useWatch` rather than `watch()`: the latter hands back a function the
  // React compiler cannot memoize, and the subscription is what tells the
  // Generate button that the period moved under a standing pre-flight.
  const month = Number(useWatch({ control, name: 'month' }));
  const year = Number(useWatch({ control, name: 'year' }));

  const toPayload = (values: RunFormFields): PayrollRunFormValues => ({
    month: Number(values.month),
    year: Number(values.year),
    ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
  });

  const check = handleSubmit((values) => onCheck(toPayload(values)));
  const generate = handleSubmit((values) => onGenerate(toPayload(values)));

  const checkedThisPeriod =
    checkedPeriod !== null && checkedPeriod.month === month && checkedPeriod.year === year;

  // A picker of the surrounding years. Wide enough to correct a late run and to
  // open next January's, and narrow enough that the list is still a list.
  const years = Array.from({ length: 7 }, (_, index) => defaultYear - 4 + index);

  return (
    <form onSubmit={check} className="space-y-5" noValidate>
      <Card>
        <CardHeader
          title="Period"
          subtitle="The month this run pays for. The server resolves it to the period's own dates."
        />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Select label="Month" error={errors.month?.message} {...register('month')}>
            {MONTHS.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </Select>
          <Select label="Year" error={errors.year?.message} {...register('year')}>
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          <div className="sm:col-span-2 lg:col-span-3">
            <Textarea
              label="Notes"
              rows={3}
              placeholder="Anything whoever approves this run should read first."
              {...register('notes')}
            />
          </div>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="submit" variant="outline" isLoading={checking} data-testid="run-preflight">
          <ClipboardCheck className="h-4 w-4" aria-hidden />
          Run pre-flight
        </Button>
        <Button
          type="button"
          onClick={() => void generate()}
          // Three separate reasons to refuse, and the hint below says which.
          disabled={!canGenerate || !checkedThisPeriod || checking}
          isLoading={generating}
          data-testid="run-generate"
        >
          <Play className="h-4 w-4" aria-hidden />
          Generate payslips
        </Button>
      </div>

      <p className="text-end text-xs text-text-muted">
        {checkedPeriod === null
          ? 'Run the pre-flight first — nothing is created until it passes.'
          : !checkedThisPeriod
            ? 'The period changed. Run the pre-flight again before generating.'
            : canGenerate
              ? 'The server will accept this period.'
              : 'The server refuses this period while a blocker stands.'}
      </p>
    </form>
  );
}
