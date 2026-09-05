'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ComponentTypeBadge, {
  COMPONENT_TYPES,
  COMPONENT_TYPE_LABEL,
} from '@/components/payroll/ComponentTypeBadge';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { useDebounce } from '@/hooks/useDebounce';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useActivateSalaryComponent,
  useDeactivateSalaryComponent,
  useSalaryComponents,
} from '@/hooks/useSalaryComponents';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { hasPermission } from '@/utils/permissions';
import type { ApiResponse } from '@/types/api';
import type { SalaryComponentType } from '@/types/payroll';
import type {
  SalaryComponent,
  SalaryComponentListQuery,
} from '@/types/salaryStructure';

const PAGE_SIZE = 20;

/** `GET /salary-components` counts the structure lines behind each row. */
type CatalogueRow = SalaryComponent & {
  _count?: { structureLines?: number };
};

/** Tri-state, because "either" is a real answer and not the absence of one. */
type ActiveFilter = '' | 'true' | 'false';

/**
 * The salary rules.
 *
 * A component IS the rule in this design: `type` decides which bucket its
 * amount lands in, `isTaxable` and `isGratuityBase` decide how the rest of the
 * system treats it, and `sequence` decides where it prints. There is no
 * separate rule model, because the engine reads exactly these properties.
 *
 * There is NO delete anywhere on this screen, and none on the API either. A
 * component behind a payslip line has to keep resolving — an auditor asking
 * what an old payslip line was still has to find the row it came from — so
 * retirement is deactivation.
 */
function SalaryComponentsList() {
  const role = useAuthStore((s) => s.user?.role);
  const canManage = hasPermission(role, 'MANAGE_SALARY_COMPONENTS');

  const [search, setSearch] = useState('');
  const [type, setType] = useState<'' | SalaryComponentType>('');
  const [active, setActive] = useState<ActiveFilter>('');
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounce(search, 300);

  const narrow = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const query = useMemo<SalaryComponentListQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
      ...(type ? { type } : {}),
      // Only sent when the reader has actually chosen a state. Defaulting it to
      // `true` would hide every retired rule while the filter still read
      // "either", and a rule nobody can see is a rule nobody can reactivate.
      ...(active ? { isActive: active === 'true' } : {}),
    }),
    [page, debouncedSearch, type, active],
  );

  const { data, isLoading, isError, error } = useSalaryComponents(query);
  const deactivate = useDeactivateSalaryComponent();
  const activate = useActivateSalaryComponent();

  const components = (data?.data ?? []) as CatalogueRow[];
  const total = data?.meta?.total;

  usePageHeader(
    'Salary rules',
    total === undefined ? undefined : `${total} component${total === 1 ? '' : 's'}`,
  );

  const filtered = Boolean(debouncedSearch.trim() || type || active);

  const retire = async (component: SalaryComponent) => {
    try {
      // The shared mutation helper is generic over its VARIABLES only, so its
      // result is typed `unknown`; the service it wraps resolves the envelope.
      const result = (await deactivate.mutateAsync(
        component.id,
      )) as ApiResponse<SalaryComponent>;
      // The server's own sentence names how many structures still use it, which
      // is the fact the clerk needs next.
      toast.success(result.message ?? 'Salary component deactivated');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not retire this component'));
    }
  };

  const restore = async (component: SalaryComponent) => {
    try {
      const result = (await activate.mutateAsync(
        component.id,
      )) as ApiResponse<SalaryComponent>;
      toast.success(result.message ?? 'Salary component reactivated');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not reactivate this component'));
    }
  };

  return (
    <div className="space-y-5">
      {canManage && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link href="/dashboard/payroll/structures">
            <Button variant="outline">Salary structures</Button>
          </Link>
          <Link href="/dashboard/payroll/salary-components/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              New component
            </Button>
          </Link>
        </div>
      )}

      <Card className="space-y-4 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="w-full lg:max-w-md">
            <Input
              value={search}
              onChange={(event) => narrow(() => setSearch(event.target.value))}
              aria-label="Search salary components"
              placeholder="Code or name"
              icon={<Search className="h-4 w-4" aria-hidden />}
            />
          </div>

          <div className="grid w-full gap-3 sm:grid-cols-2 lg:w-auto lg:min-w-[26rem]">
            <Select
              label="Type"
              placeholder="Every type"
              value={type}
              onChange={(event) =>
                narrow(() => setType(event.target.value as '' | SalaryComponentType))
              }
            >
              {COMPONENT_TYPES.map((option) => (
                <option key={option} value={option}>
                  {COMPONENT_TYPE_LABEL[option]}
                </option>
              ))}
            </Select>

            <Select
              label="State"
              placeholder="Active and retired"
              value={active}
              onChange={(event) =>
                narrow(() => setActive(event.target.value as ActiveFilter))
              }
            >
              <option value="true">Active only</option>
              <option value="false">Retired only</option>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-border-light pt-3">
          <p className="flex items-center gap-2 text-sm text-text-muted">
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            Showing{' '}
            <span className="font-medium tabular-nums text-text-body">
              {components.length}
            </span>{' '}
            of <span className="font-medium tabular-nums text-text-body">{total ?? '—'}</span>
          </p>
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                narrow(() => {
                  setSearch('');
                  setType('');
                  setActive('');
                })
              }
            >
              <X className="h-4 w-4" aria-hidden />
              Clear filters
            </Button>
          )}
        </div>
      </Card>

      {isLoading && (
        <Card className="p-6 text-sm text-text-muted">Loading the salary rules…</Card>
      )}

      {isError && (
        <Card className="p-6 text-sm text-status-error">
          {(error as { message?: string } | null)?.message ??
            'Could not load the salary rules.'}
        </Card>
      )}

      {!isLoading && !isError && components.length === 0 && (
        <Card>
          <EmptyState
            title={filtered ? 'No matches' : 'The catalogue is empty'}
            description={
              filtered
                ? 'Nothing matches that search. Try a different code, name, type or state.'
                : 'A salary structure is built from these, so nothing can be paid until at least one earning exists.'
            }
            action={
              !filtered && canManage ? (
                <Link href="/dashboard/payroll/salary-components/new">
                  <Button>
                    <Plus className="h-4 w-4" aria-hidden />
                    New component
                  </Button>
                </Link>
              ) : undefined
            }
          />
        </Card>
      )}

      {components.length > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Code</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Name</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Type</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Rule</th>
                  <th scope="col" className="px-5 py-3 text-end font-medium">Order</th>
                  <th scope="col" className="px-5 py-3 text-end font-medium">In use</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">State</th>
                  <th scope="col" className="px-5 py-3 text-end font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {components.map((component) => (
                  <tr key={component.id} className="hover:bg-surface-border-light/60">
                    <td className="px-5 py-3">
                      <Link
                        href={`/dashboard/payroll/salary-components/${component.id}`}
                        className="font-mono font-medium text-brand-primary hover:underline"
                      >
                        {component.code}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-text-body">{component.name}</td>
                    <td className="px-5 py-3">
                      <ComponentTypeBadge type={component.type} short />
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {component.isTaxable && <Badge tone="neutral">Taxable</Badge>}
                        {component.isGratuityBase && <Badge tone="neutral">Gratuity base</Badge>}
                        {!component.isTaxable && !component.isGratuityBase && (
                          <span className="text-text-muted">—</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-end tabular-nums text-text-body">
                      {component.sequence}
                    </td>
                    {/* A count from the database, not the length of anything
                        fetched — and an em dash when the endpoint did not send
                        one, because 0 would claim nothing uses it. */}
                    <td className="px-5 py-3 text-end tabular-nums text-text-body">
                      {component._count?.structureLines ?? '—'}
                    </td>
                    <td className="px-5 py-3">
                      {component.isActive ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="warning">Retired</Badge>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {canManage && (
                          <>
                            <Link
                              href={`/dashboard/payroll/salary-components/${component.id}`}
                            >
                              <Button variant="ghost" size="sm">
                                Edit
                              </Button>
                            </Link>
                            {/* Retirement, never deletion. */}
                            {component.isActive ? (
                              <Button
                                variant="outline"
                                size="sm"
                                isLoading={
                                  deactivate.isPending &&
                                  deactivate.variables === component.id
                                }
                                onClick={() => void retire(component)}
                              >
                                Deactivate
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                isLoading={
                                  activate.isPending && activate.variables === component.id
                                }
                                onClick={() => void restore(component)}
                              >
                                Activate
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination meta={data?.meta} onPageChange={setPage} />
        </Card>
      )}
    </div>
  );
}

export default function SalaryComponentsPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_PAYROLL">
      <SalaryComponentsList />
    </ProtectedRoute>
  );
}
