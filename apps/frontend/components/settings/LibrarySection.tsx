'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BookOpen, Check, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/common/EmptyState';
import {
  useCreateLibraryItem,
  useDeleteLibraryItem,
  useLibraryItems,
  useSeedLibraryDefaults,
  useUpdateLibraryItem,
} from '@/hooks/useLibraryItems';
import { apiErrorMessage } from '@/utils/apiError';
import { cn } from '@/utils/cn';
import type {
  GenderRestriction,
  LibraryItem,
  LibraryTypeValue,
  PayBasis,
  UpdateLibraryItemPayload,
} from '@/types/library';
import { Field, SettingInput } from './SettingsPrimitives';

/**
 * The pick lists, in the order an administrator meets them.
 *
 * The list mirrors the Prisma `LibraryType` enum. A value missing here is a
 * list with rows in the database and no way to reach them, which is how the
 * screens that read it end up with a dropdown nobody can populate.
 */
const LIBRARIES: { value: LibraryTypeValue; label: string; description: string }[] = [
  { value: 'POSITION', label: 'Positions', description: 'Job titles an employee can hold' },
  { value: 'CONTRACT_TYPE', label: 'Contract types', description: 'The forms of employment contract you issue' },
  { value: 'EMPLOYMENT_TYPE', label: 'Employment types', description: 'Classifications that decide how pay is calculated' },
  { value: 'WORK_MODE', label: 'Work modes', description: 'Full-time, part-time and anything between' },
  { value: 'LEAVE_TYPE', label: 'Leave types', description: 'What an employee can apply for, and what it costs their balance' },
  { value: 'DOCUMENT_TYPE', label: 'Document types', description: 'Categories in the employee document vault' },
  { value: 'VISA_TYPE', label: 'Visa types', description: 'Visa categories tracked against an employee' },
  { value: 'ASSET_CATEGORY', label: 'Asset categories', description: 'Headings in the asset register' },
  { value: 'COURSE_CATEGORY', label: 'Course categories', description: 'Headings in the training catalogue' },
  { value: 'GRIEVANCE_CATEGORY', label: 'Grievance categories', description: 'What an employee picks when raising a grievance' },
];

const GENDER_OPTIONS: { value: GenderRestriction | ''; label: string }[] = [
  { value: '', label: 'Everyone' },
  { value: 'MALE', label: 'Male' },
  { value: 'FEMALE', label: 'Female' },
];

const PAY_BASIS_OPTIONS: { value: PayBasis | ''; label: string }[] = [
  { value: '', label: 'Not set' },
  { value: 'MONTHLY', label: 'Monthly salary' },
  { value: 'DAILY', label: 'Daily wage' },
];

/** The editable metadata of one row, as the form holds it before it is a payload. */
interface ItemDraft {
  label: string;
  defaultDays: string;
  requiresNoticeDays: string;
  isPaid: boolean;
  affectsBalance: boolean;
  genderRestriction: GenderRestriction | '';
  payBasis: PayBasis | '';
}

const blankDraft = (): ItemDraft => ({
  label: '',
  defaultDays: '0',
  requiresNoticeDays: '0',
  isPaid: true,
  affectsBalance: true,
  genderRestriction: '',
  payBasis: '',
});

// The API leaves the leave-type flags off a row that is not a leave type, so
// absent reads as the column default (true) rather than as "unchecked".
const draftOf = (item: LibraryItem): ItemDraft => ({
  label: item.label,
  defaultDays: String(item.defaultDays ?? 0),
  requiresNoticeDays: String(item.requiresNoticeDays ?? 0),
  isPaid: item.isPaid !== false,
  affectsBalance: item.affectsBalance !== false,
  genderRestriction: (item.genderRestriction as GenderRestriction | null) ?? '',
  payBasis: item.payBasis ?? '',
});

/**
 * Only the metadata the selected library actually uses is sent.
 *
 * The API rejects `payBasis` on anything that is not an employment type, and
 * the leave fields written onto a position would be columns nothing reads while
 * implying to whoever set them that they had an effect.
 */
function payloadOf(draft: ItemDraft, libraryType: LibraryTypeValue): UpdateLibraryItemPayload {
  const payload: UpdateLibraryItemPayload = { label: draft.label.trim() };

  if (libraryType === 'LEAVE_TYPE') {
    payload.defaultDays = Number(draft.defaultDays) || 0;
    payload.requiresNoticeDays = Number(draft.requiresNoticeDays) || 0;
    payload.isPaid = draft.isPaid;
    payload.affectsBalance = draft.affectsBalance;
    payload.genderRestriction = draft.genderRestriction || null;
  }

  if (libraryType === 'EMPLOYMENT_TYPE') {
    payload.payBasis = draft.payBasis || null;
  }

  return payload;
}

/** A segmented choice, for the two fields whose options are short enough to show. */
function OptionRow<T extends string>({
  legend,
  options,
  value,
  onChange,
  disabled,
}: {
  legend: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium text-text-body">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.value || 'none'}
            type="button"
            disabled={disabled}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-[var(--radius-button)] border px-2.5 py-1 text-xs font-medium transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-60',
              value === option.value
                ? 'border-brand-primary bg-status-info-bg text-brand-primary'
                : 'border-surface-border bg-surface-card text-text-body hover:bg-surface-border-light',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** A checkbox with its label, for the two leave flags. */
function CheckRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-text-body">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-surface-border accent-[var(--color-brand-primary)]"
      />
      {label}
    </label>
  );
}

/** The metadata fields a library adds beyond a label. */
function MetadataFields({
  libraryType,
  draft,
  onChange,
  disabled,
  idPrefix,
}: {
  libraryType: LibraryTypeValue;
  draft: ItemDraft;
  onChange: (patch: Partial<ItemDraft>) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  if (libraryType === 'EMPLOYMENT_TYPE') {
    return (
      <div className="rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-3">
        <OptionRow
          legend="Pay basis"
          options={PAY_BASIS_OPTIONS}
          value={draft.payBasis}
          onChange={(payBasis) => onChange({ payBasis })}
          disabled={disabled}
        />
        <p className="mt-2 text-xs text-text-muted">
          Locks the pay basis on the employee form for anyone with this employment
          type. <strong>Daily wage</strong> makes their base pay a per-day rate. Leave
          it unset to decide per employee.
        </p>
      </div>
    );
  }

  if (libraryType !== 'LEAVE_TYPE') return null;

  return (
    <div className="grid grid-cols-1 gap-3 rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-3 sm:grid-cols-2">
      <Field label="Days per year" hint="The entitlement allocated for this leave type each year.">
        {() => (
          <SettingInput
            id={`${idPrefix}-days`}
            type="number"
            min={0}
            value={draft.defaultDays}
            onChange={(defaultDays) => onChange({ defaultDays })}
            disabled={disabled}
          />
        )}
      </Field>

      <Field label="Notice required (days)" hint="How far in advance an application has to be made.">
        {() => (
          <SettingInput
            id={`${idPrefix}-notice`}
            type="number"
            min={0}
            value={draft.requiresNoticeDays}
            onChange={(requiresNoticeDays) => onChange({ requiresNoticeDays })}
            disabled={disabled}
          />
        )}
      </Field>

      <OptionRow
        legend="Who may apply"
        options={GENDER_OPTIONS}
        value={draft.genderRestriction}
        onChange={(genderRestriction) => onChange({ genderRestriction })}
        disabled={disabled}
      />

      <div className="flex flex-col justify-end gap-2">
        <CheckRow
          label="Paid leave"
          checked={draft.isPaid}
          onChange={(isPaid) => onChange({ isPaid })}
          disabled={disabled}
        />
        <CheckRow
          label="Draws down the balance"
          checked={draft.affectsBalance}
          onChange={(affectsBalance) => onChange({ affectsBalance })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

export function LibrarySection() {
  const [libraryType, setLibraryType] = useState<LibraryTypeValue>('POSITION');
  const [newDraft, setNewDraft] = useState<ItemDraft>(blankDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ItemDraft>(blankDraft);

  const { data, isLoading, isError, error } = useLibraryItems({ type: libraryType });
  const createItem = useCreateLibraryItem();
  const updateItem = useUpdateLibraryItem();
  const deleteItem = useDeleteLibraryItem();
  const seedDefaults = useSeedLibraryDefaults();

  const items = useMemo(() => data?.data ?? [], [data]);
  const active = LIBRARIES.find((entry) => entry.value === libraryType)!;
  const busy = createItem.isPending || updateItem.isPending || deleteItem.isPending;

  const selectLibrary = (value: LibraryTypeValue) => {
    setLibraryType(value);
    // The metadata fields differ per library, so a half-filled draft carried
    // across would be offering leave options on a list of job titles.
    setNewDraft(blankDraft());
    setEditingId(null);
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newDraft.label.trim()) return;
    try {
      await createItem.mutateAsync({
        ...payloadOf(newDraft, libraryType),
        libraryType,
        label: newDraft.label.trim(),
      });
      toast.success(`Added "${newDraft.label.trim()}"`);
      setNewDraft(blankDraft());
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not add that entry'));
    }
  };

  const saveEdit = async (id: string) => {
    if (!editDraft.label.trim()) return;
    try {
      await updateItem.mutateAsync({ id, payload: payloadOf(editDraft, libraryType) });
      toast.success('Entry updated');
      setEditingId(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not update that entry'));
    }
  };

  const toggleActive = async (item: LibraryItem) => {
    try {
      await updateItem.mutateAsync({ id: item.id, payload: { isActive: !item.isActive } });
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not change that entry'));
    }
  };

  const remove = async (item: LibraryItem) => {
    if (
      !window.confirm(
        `Delete "${item.label}"? Records already using it keep the value, but nobody can pick it again.`,
      )
    ) {
      return;
    }
    try {
      await deleteItem.mutateAsync(item.id);
      toast.success(`Deleted "${item.label}"`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not delete that entry'));
    }
  };

  const seed = async () => {
    try {
      await seedDefaults.mutateAsync();
      toast.success('Shipped defaults restored');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not restore the defaults'));
    }
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="surface-panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-status-info-bg text-status-info">
            <BookOpen className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-heading sm:text-base">Libraries</h3>
            <p className="mt-0.5 text-xs text-text-muted">
              The dropdown options the rest of the portal reads. Nothing else populates
              them.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={seed}
          isLoading={seedDefaults.isPending}
          className="shrink-0"
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          Restore defaults
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4 lg:gap-5">
        <nav aria-label="Library categories" className="surface-panel p-2 lg:col-span-1">
          <ul className="space-y-0.5">
            {LIBRARIES.map((entry) => (
              <li key={entry.value}>
                <button
                  type="button"
                  aria-current={libraryType === entry.value ? 'true' : undefined}
                  onClick={() => selectLibrary(entry.value)}
                  className={cn(
                    'w-full rounded-[var(--radius-button)] px-3 py-2 text-start text-sm transition-colors',
                    libraryType === entry.value
                      ? 'bg-status-info-bg font-semibold text-brand-primary'
                      : 'text-text-body hover:bg-surface-border-light',
                  )}
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="surface-panel lg:col-span-3">
          <div className="flex items-start justify-between gap-4 border-b border-surface-border-light px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-text-heading sm:text-base">
                {active.label}
              </h4>
              <p className="mt-0.5 text-xs text-text-muted">{active.description}</p>
            </div>
            <Badge>{items.length} option{items.length === 1 ? '' : 's'}</Badge>
          </div>

          <form onSubmit={add} className="space-y-3 border-b border-surface-border-light p-4 sm:p-5">
            <div className="flex flex-col gap-2 sm:flex-row">
              <label htmlFor="library-new-label" className="sr-only">
                New {active.label.toLowerCase()} entry
              </label>
              <input
                id="library-new-label"
                type="text"
                value={newDraft.label}
                onChange={(event) => setNewDraft((draft) => ({ ...draft, label: event.target.value }))}
                placeholder={`Add to ${active.label.toLowerCase()}…`}
                disabled={busy}
                className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/40 disabled:opacity-60"
              />
              <Button
                type="submit"
                disabled={!newDraft.label.trim()}
                isLoading={createItem.isPending}
                className="shrink-0"
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add
              </Button>
            </div>

            <MetadataFields
              libraryType={libraryType}
              draft={newDraft}
              onChange={(patch) => setNewDraft((draft) => ({ ...draft, ...patch }))}
              disabled={busy}
              idPrefix="library-new"
            />
          </form>

          {isLoading ? (
            <p className="px-4 py-10 text-center text-sm text-text-muted sm:px-5">
              Loading options…
            </p>
          ) : isError ? (
            <p className="px-4 py-10 text-center text-sm text-status-error sm:px-5">
              {apiErrorMessage(error, 'Could not load this library')}
            </p>
          ) : items.length === 0 ? (
            <EmptyState
              title="Nothing in this library yet"
              description="Add an entry above, or restore the shipped defaults."
              icon={<BookOpen className="h-6 w-6" aria-hidden />}
            />
          ) : (
            <ul className="divide-y divide-surface-border-light">
              {items.map((item) => (
                <li key={item.id} className="p-4 sm:px-5">
                  {editingId === item.id ? (
                    <div className="space-y-3">
                      <label htmlFor={`library-edit-${item.id}`} className="sr-only">
                        Rename {item.label}
                      </label>
                      <input
                        id={`library-edit-${item.id}`}
                        type="text"
                        value={editDraft.label}
                        onChange={(event) =>
                          setEditDraft((draft) => ({ ...draft, label: event.target.value }))
                        }
                        className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                      />

                      <MetadataFields
                        libraryType={libraryType}
                        draft={editDraft}
                        onChange={(patch) => setEditDraft((draft) => ({ ...draft, ...patch }))}
                        disabled={busy}
                        idPrefix={`library-edit-${item.id}`}
                      />

                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => saveEdit(item.id)}
                          isLoading={updateItem.isPending}
                          disabled={!editDraft.label.trim()}
                        >
                          <Check className="h-4 w-4" aria-hidden />
                          Save
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                          <X className="h-4 w-4" aria-hidden />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            'text-sm font-medium',
                            item.isActive ? 'text-text-heading' : 'text-text-muted line-through',
                          )}
                        >
                          {item.label}
                        </span>

                        {libraryType === 'LEAVE_TYPE' && (
                          <>
                            <Badge>{item.defaultDays ?? 0} days</Badge>
                            <Badge tone={item.isPaid ? 'success' : 'error'}>
                              {item.isPaid ? 'Paid' : 'Unpaid'}
                            </Badge>
                            {!item.affectsBalance && <Badge>Off balance</Badge>}
                            {item.genderRestriction && <Badge>{item.genderRestriction}</Badge>}
                          </>
                        )}

                        {libraryType === 'EMPLOYMENT_TYPE' && item.payBasis && (
                          <Badge tone="info">
                            {item.payBasis === 'DAILY' ? 'Daily wage' : 'Monthly salary'}
                          </Badge>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        {/* The badge IS the control. Its accessible name says
                            what pressing it does, which is not what the visible
                            word says — that reports the current state. */}
                        <button
                          type="button"
                          aria-label={`${item.isActive ? 'Disable' : 'Enable'} ${item.label}`}
                          onClick={() => toggleActive(item)}
                          disabled={busy}
                          className={cn(
                            'rounded-[var(--radius-badge)] px-2.5 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-60',
                            item.isActive
                              ? 'bg-status-success-bg text-status-success'
                              : 'bg-surface-border-light text-text-muted',
                          )}
                        >
                          {item.isActive ? 'Active' : 'Disabled'}
                        </button>

                        <button
                          type="button"
                          aria-label={`Edit ${item.label}`}
                          onClick={() => {
                            setEditingId(item.id);
                            setEditDraft(draftOf(item));
                          }}
                          className="rounded-[var(--radius-button)] p-1.5 text-text-muted transition-colors hover:bg-surface-border-light hover:text-brand-primary"
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </button>

                        <button
                          type="button"
                          aria-label={`Delete ${item.label}`}
                          onClick={() => remove(item)}
                          className="rounded-[var(--radius-button)] p-1.5 text-text-muted transition-colors hover:bg-status-error-bg hover:text-status-error"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
