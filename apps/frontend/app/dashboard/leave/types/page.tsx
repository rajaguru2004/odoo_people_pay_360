'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Power, Save } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import {
  useCreateLibraryItem,
  useDeactivateLibraryItem,
  useLibraryItems,
  useUpdateLibraryItem,
} from '@/hooks/useLibraryItems';
import { apiErrorMessage } from '@/utils/apiError';
import type { LibraryItem } from '@/services/libraryItemService';

const BLANK = {
  label: '',
  defaultDays: 0,
  requiresNoticeDays: 0,
  affectsBalance: true,
  isPaid: true,
  genderRestriction: '' as '' | 'MALE' | 'FEMALE',
};

/**
 * The leave types a request may be filed against.
 *
 * `label` is the KEY, not a caption: every balance row and every filed request
 * stores this exact string. Renaming one therefore does NOT rename the history
 * behind it, and removing one is a deactivation rather than a delete — a hard
 * delete would leave a year of records naming a type that no longer exists.
 *
 * The four columns beside the name are the rules the request form enforces:
 * how many days a fresh year allocates, how much notice is needed, whether the
 * type costs entitlement at all, and who may take it.
 */
function LeaveTypesContent() {
  const { data, isLoading, isError, error } = useLibraryItems('LEAVE_TYPE');
  const createItem = useCreateLibraryItem();
  const updateItem = useUpdateLibraryItem();
  const deactivate = useDeactivateLibraryItem();

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(BLANK);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState(BLANK);

  const rows = data?.data ?? [];

  usePageHeader('Leave types', `${rows.filter((r) => r.isActive).length} available to file against`);

  const onCreate = async () => {
    if (draft.label.trim().length < 2) {
      toast.error('Give the type a name.');
      return;
    }
    try {
      await createItem.mutateAsync({
        libraryType: 'LEAVE_TYPE',
        label: draft.label.trim(),
        defaultDays: draft.defaultDays,
        requiresNoticeDays: draft.requiresNoticeDays,
        affectsBalance: draft.affectsBalance,
        isPaid: draft.isPaid,
        genderRestriction: draft.genderRestriction || null,
      });
      toast.success('Leave type added.');
      setCreating(false);
      setDraft(BLANK);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The leave type could not be added.'));
    }
  };

  const onSave = async (id: string) => {
    try {
      await updateItem.mutateAsync({
        id,
        payload: {
          label: edit.label.trim(),
          defaultDays: edit.defaultDays,
          requiresNoticeDays: edit.requiresNoticeDays,
          affectsBalance: edit.affectsBalance,
          isPaid: edit.isPaid,
          genderRestriction: edit.genderRestriction || null,
        },
      });
      toast.success('Leave type updated.');
      setEditingId(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The leave type could not be saved.'));
    }
  };

  const onDeactivate = async (item: LibraryItem) => {
    try {
      await deactivate.mutateAsync(item.id);
      toast.success(`${item.label} is no longer offered.`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The leave type could not be deactivated.'));
    }
  };

  const startEdit = (item: LibraryItem) => {
    setEditingId(item.id);
    setEdit({
      label: item.label,
      defaultDays: item.defaultDays ?? 0,
      requiresNoticeDays: item.requiresNoticeDays,
      affectsBalance: item.affectsBalance,
      isPaid: item.isPaid,
      genderRestriction: (item.genderRestriction ?? '') as '' | 'MALE' | 'FEMALE',
    });
  };

  return (
    <div className="max-w-5xl space-y-5">
      <Card>
        <CardHeader
          title="Types"
          subtitle="Renaming a type does not rename the requests already filed against it."
          action={
            <Button size="sm" onClick={() => setCreating((v) => !v)}>
              <Plus className="h-4 w-4" aria-hidden />
              New type
            </Button>
          }
        />

        {creating && (
          <CardBody className="grid gap-3 border-b border-surface-border-light sm:grid-cols-3">
            <Input
              label="Name"
              placeholder="Study Leave"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <Input
              type="number"
              min={0}
              label="Days a year"
              value={draft.defaultDays}
              onChange={(e) =>
                setDraft({ ...draft, defaultDays: Number(e.target.value) })
              }
            />
            <Input
              type="number"
              min={0}
              label="Notice days"
              value={draft.requiresNoticeDays}
              onChange={(e) =>
                setDraft({ ...draft, requiresNoticeDays: Number(e.target.value) })
              }
            />
            <Select
              label="Costs entitlement"
              value={draft.affectsBalance ? 'yes' : 'no'}
              onChange={(e) =>
                setDraft({ ...draft, affectsBalance: e.target.value === 'yes' })
              }
            >
              <option value="yes">Yes — deducts a balance</option>
              <option value="no">No — recorded only</option>
            </Select>
            <Select
              label="Paid"
              value={draft.isPaid ? 'yes' : 'no'}
              onChange={(e) => setDraft({ ...draft, isPaid: e.target.value === 'yes' })}
            >
              <option value="yes">Paid</option>
              <option value="no">Unpaid</option>
            </Select>
            <Select
              label="Restricted to"
              placeholder="Everybody"
              value={draft.genderRestriction}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  genderRestriction: e.target.value as '' | 'MALE' | 'FEMALE',
                })
              }
            >
              <option value="FEMALE">Female employees</option>
              <option value="MALE">Male employees</option>
            </Select>

            <div className="sm:col-span-3 flex items-center gap-2">
              <Button isLoading={createItem.isPending} onClick={() => void onCreate()}>
                Add the type
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </CardBody>
        )}

        {isError ? (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(error, 'The leave types could not be loaded.')}
          </p>
        ) : isLoading ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-border/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No leave types yet"
            description="Nothing can be filed until at least one exists."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-sm">
              <thead>
                <tr className="border-b border-surface-border-light">
                  <Th>Type</Th>
                  <Th align="end">Days a year</Th>
                  <Th align="end">Notice</Th>
                  <Th>Entitlement</Th>
                  <Th>Restricted to</Th>
                  <Th align="end">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => {
                  const isEditing = editingId === item.id;
                  return (
                    <tr
                      key={item.id}
                      className="border-b border-surface-border-light last:border-0"
                    >
                      <td className="px-4 py-3">
                        {isEditing ? (
                          <input
                            value={edit.label}
                            onChange={(e) => setEdit({ ...edit, label: e.target.value })}
                            aria-label="Type name"
                            className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-2 py-1 text-sm"
                          />
                        ) : (
                          <span className="font-medium text-text-heading">{item.label}</span>
                        )}
                        {!item.isActive && (
                          <Badge tone="neutral">no longer offered</Badge>
                        )}
                      </td>

                      <td className="px-4 py-3 text-end tabular-nums text-text-body">
                        {isEditing ? (
                          <input
                            type="number"
                            min={0}
                            value={edit.defaultDays}
                            onChange={(e) =>
                              setEdit({ ...edit, defaultDays: Number(e.target.value) })
                            }
                            aria-label="Days a year"
                            className="w-20 rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-2 py-1 text-end text-sm tabular-nums"
                          />
                        ) : (
                          (item.defaultDays ?? '—')
                        )}
                      </td>

                      <td className="px-4 py-3 text-end tabular-nums text-text-body">
                        {isEditing ? (
                          <input
                            type="number"
                            min={0}
                            value={edit.requiresNoticeDays}
                            onChange={(e) =>
                              setEdit({
                                ...edit,
                                requiresNoticeDays: Number(e.target.value),
                              })
                            }
                            aria-label="Notice days"
                            className="w-20 rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-2 py-1 text-end text-sm tabular-nums"
                          />
                        ) : item.requiresNoticeDays > 0 ? (
                          `${item.requiresNoticeDays}d`
                        ) : (
                          'none'
                        )}
                      </td>

                      <td className="px-4 py-3">
                        <Badge tone={item.affectsBalance ? 'info' : 'neutral'}>
                          {item.affectsBalance ? 'Deducts a balance' : 'Recorded only'}
                        </Badge>
                      </td>

                      <td className="px-4 py-3 text-text-body">
                        {item.genderRestriction
                          ? item.genderRestriction === 'FEMALE'
                            ? 'Female employees'
                            : 'Male employees'
                          : 'Everybody'}
                      </td>

                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {isEditing ? (
                            <>
                              <Button
                                size="sm"
                                isLoading={updateItem.isPending}
                                onClick={() => void onSave(item.id)}
                              >
                                <Save className="h-3.5 w-3.5" aria-hidden />
                                Save
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button size="sm" variant="outline" onClick={() => startEdit(item)}>
                                Edit
                              </Button>
                              {item.isActive && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  isLoading={deactivate.isPending}
                                  onClick={() => void onDeactivate(item)}
                                  title="Takes it out of the picker; existing requests keep resolving"
                                >
                                  <Power className="h-3.5 w-3.5" aria-hidden />
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Th({
  children,
  align = 'start',
}: {
  children: React.ReactNode;
  align?: 'start' | 'end';
}) {
  return (
    <th
      scope="col"
      className={
        align === 'end'
          ? 'px-4 py-3 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted'
          : 'px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wider text-text-muted'
      }
    >
      {children}
    </th>
  );
}

export default function LeaveTypesPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <LeaveTypesContent />
    </ProtectedRoute>
  );
}
