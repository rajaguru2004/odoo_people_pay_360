'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FilePlus2, Pencil } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { useEmployeeAttendance } from '@/hooks/useAttendance';
import { useContracts } from '@/hooks/useContracts';
import { useEmployee } from '@/hooks/useEmployees';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useVisas } from '@/hooks/useVisas';
import { useAuthStore } from '@/store/authStore';
import { expiryLabel, expiryTone } from '@/utils/contractExpiry';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency, fullName, initials } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';
import type { Employee, EmployeeStatus } from '@/types/employee';

const STATUS_TONE: Record<EmployeeStatus, 'success' | 'info' | 'warning' | 'error'> = {
  ACTIVE: 'success',
  ON_LEAVE: 'info',
  SUSPENDED: 'warning',
  TERMINATED: 'error',
};

const SECTIONS = [
  { key: 'profile', label: 'Profile' },
  { key: 'employment', label: 'Employment' },
  { key: 'contracts', label: 'Contracts' },
  { key: 'permits', label: 'Permits' },
  { key: 'attendance', label: 'Attendance' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

/** One labelled fact. An unset value prints an em dash rather than a blank gap. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-text-body">{children || '—'}</dd>
    </div>
  );
}

function FactGrid({ children }: { children: ReactNode }) {
  return <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{children}</dl>;
}

/** The days a work permit or a contract has left, coloured by how soon that is. */
function Countdown({ days }: { days: number | null }) {
  const tone = expiryTone(days);
  const className =
    tone === 'error'
      ? 'font-semibold text-status-error'
      : tone === 'warning'
        ? 'font-semibold text-status-warning'
        : 'text-text-body';
  return <span className={className}>{expiryLabel(days)}</span>;
}

function ProfileSection({ employee }: { employee: Employee }) {
  return (
    <Card>
      <CardHeader title="Profile" subtitle="Who this person is on paper." />
      <CardBody>
        <FactGrid>
          <Fact label="Employee code">{employee.employeeCode}</Fact>
          <Fact label="Work email">{employee.workEmail}</Fact>
          <Fact label="Personal email">{employee.personalEmail}</Fact>
          <Fact label="Phone">{employee.phone}</Fact>
          <Fact label="Date of birth">{formatDateOnly(employee.dateOfBirth)}</Fact>
          <Fact label="Gender">{employee.gender}</Fact>
          <Fact label="Nationality">{employee.nationality}</Fact>
          <Fact label="National ID">{employee.nationalId}</Fact>
          <Fact label="Timezone">{employee.timezone}</Fact>
          <Fact label="Address">{employee.address}</Fact>
        </FactGrid>
      </CardBody>
    </Card>
  );
}

function EmploymentSection({ employee }: { employee: Employee }) {
  return (
    <Card>
      <CardHeader title="Employment" subtitle="Where they sit, and who signs their work off." />
      <CardBody>
        <FactGrid>
          <Fact label="Branch">{employee.branch?.name}</Fact>
          <Fact label="Department">{employee.department?.name}</Fact>
          <Fact label="Position">{employee.position}</Fact>
          <Fact label="Line manager">
            {employee.manager ? (
              <Link
                href={`/dashboard/employees/${employee.manager.id}`}
                className="text-brand-primary hover:underline"
              >
                {fullName(employee.manager)}
              </Link>
            ) : null}
          </Fact>
          {/* Separate from the line manager on purpose: the supervisor is who
              signs the timesheet off, and on a matrixed team that is somebody
              else entirely. */}
          <Fact label="Supervisor">
            {employee.supervisor ? (
              <Link
                href={`/dashboard/employees/${employee.supervisor.id}`}
                className="text-brand-primary hover:underline"
              >
                {fullName(employee.supervisor)}
              </Link>
            ) : null}
          </Fact>
          <Fact label="Hire date">{formatDateOnly(employee.hireDate)}</Fact>
          <Fact label="Exit date">{formatDateOnly(employee.exitDate)}</Fact>
          <Fact label="Status">
            <Badge tone={STATUS_TONE[employee.status]}>{employee.status.replace(/_/g, ' ')}</Badge>
          </Fact>
        </FactGrid>
      </CardBody>
    </Card>
  );
}

function ContractsSection({ employeeId }: { employeeId: string }) {
  const { data, isLoading, isError } = useContracts({ employeeId, limit: 50 });
  const contracts = data?.data ?? [];

  return (
    <Card>
      <CardHeader title="Contracts" subtitle="Every term this person has worked under." />
      {isLoading && <p className="px-5 pb-5 text-sm text-text-muted">Loading contracts…</p>}
      {isError && (
        <p className="px-5 pb-5 text-sm text-status-error">Could not load contracts.</p>
      )}
      {!isLoading && !isError && contracts.length === 0 && (
        <p className="px-5 pb-5 text-sm text-text-muted">No contract on file.</p>
      )}
      {contracts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-y border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th scope="col" className="px-5 py-3 text-start font-medium">Number</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">Type</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">Term</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">Salary</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border-light">
              {contracts.map((contract) => (
                <tr key={contract.id} className="hover:bg-surface-border-light/60">
                  <td className="px-5 py-3">
                    <Link
                      href={`/dashboard/contracts/${contract.id}`}
                      className="font-medium text-brand-primary hover:underline"
                    >
                      {contract.contractNumber}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-text-body">
                    {contract.contractType.replace(/_/g, ' ')}
                  </td>
                  <td className="px-5 py-3 text-text-body">
                    {formatDateOnly(contract.startDate)} –{' '}
                    {contract.endDate ? formatDateOnly(contract.endDate) : 'open ended'}
                  </td>
                  {/* The salary arrives as a decimal STRING; formatCurrency reads
                      the currency for its decimal count, so OMR keeps three. */}
                  <td className="px-5 py-3 tabular-nums text-text-body">
                    {formatCurrency(contract.salary, contract.currency)}
                  </td>
                  <td className="px-5 py-3 text-text-body">{contract.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PermitsSection({ employeeId }: { employeeId: string }) {
  const { data, isLoading, isError } = useVisas({ employeeId, limit: 50, currentOnly: false });
  const permits = data?.data ?? [];

  return (
    <Card>
      <CardHeader
        title="Permits"
        subtitle="Residency and work documents, newest first."
        action={
          <Link
            href="/dashboard/visa-reports"
            className="text-xs font-semibold text-brand-primary hover:underline"
          >
            Visa reports
          </Link>
        }
      />
      {isLoading && <p className="px-5 pb-5 text-sm text-text-muted">Loading permits…</p>}
      {isError && (
        // Never "no permit on file": a request that did not answer says nothing
        // about what the employee holds.
        <p className="px-5 pb-5 text-sm text-status-error">Could not load permits.</p>
      )}
      {!isLoading && !isError && permits.length === 0 && (
        <p className="px-5 pb-5 text-sm text-text-muted">No permit on file.</p>
      )}
      {permits.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="border-y border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th scope="col" className="px-5 py-3 text-start font-medium">Number</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">Category</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">Country</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">Expires</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">Remaining</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border-light">
              {permits.map((permit) => (
                <tr key={permit.id} className="hover:bg-surface-border-light/60">
                  <td className="px-5 py-3 font-medium text-text-heading">
                    {permit.documentNumber}
                  </td>
                  <td className="px-5 py-3 text-text-body">
                    {permit.category.replace(/_/g, ' ')}
                  </td>
                  <td className="px-5 py-3 text-text-body">{permit.country}</td>
                  <td className="px-5 py-3 text-text-body">{formatDateOnly(permit.expiryDate)}</td>
                  <td className="px-5 py-3">
                    {permit.status === 'ACTIVE' ? (
                      <Countdown days={permit.daysUntilExpiry} />
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-text-body">{permit.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const ATTENDANCE_WINDOW_DAYS = 30;

function AttendanceSection({ employeeId }: { employeeId: string }) {
  // A fixed window rather than "everything": the record page wants a shape, and
  // the full log lives on its own screen.
  const range = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - (ATTENDANCE_WINDOW_DAYS - 1) * 86_400_000);
    return {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    };
  }, []);

  const { data, isLoading, isError } = useEmployeeAttendance(employeeId, range);
  const rows = data?.data ?? [];

  const totals = rows.reduce(
    (acc, row) => {
      if (row.status === 'PRESENT' || row.status === 'LATE' || row.status === 'HALF_DAY') {
        acc.worked += 1;
      }
      if (row.isLate) acc.late += 1;
      if (row.status === 'ABSENT') acc.absent += 1;
      if (row.status === 'ON_LEAVE') acc.onLeave += 1;
      acc.hours += Number(row.workHours ?? 0);
      return acc;
    },
    { worked: 0, late: 0, absent: 0, onLeave: 0, hours: 0 },
  );

  return (
    <Card>
      <CardHeader
        title="Attendance"
        subtitle={`The last ${ATTENDANCE_WINDOW_DAYS} days, ${formatDateOnly(range.startDate)} to ${formatDateOnly(range.endDate)}.`}
        action={
          <Link
            href="/dashboard/attendance/history"
            className="text-xs font-semibold text-brand-primary hover:underline"
          >
            Full log
          </Link>
        }
      />
      <CardBody>
        {isLoading && <p className="text-sm text-text-muted">Loading attendance…</p>}
        {isError && (
          <p className="text-sm text-status-error">Could not load attendance for this window.</p>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <p className="text-sm text-text-muted">Nothing recorded in this window.</p>
        )}
        {rows.length > 0 && (
          <FactGrid>
            <Fact label="Days worked">
              <span className="tabular-nums">{totals.worked}</span>
            </Fact>
            <Fact label="Late arrivals">
              <span className="tabular-nums">{totals.late}</span>
            </Fact>
            <Fact label="Absent">
              <span className="tabular-nums">{totals.absent}</span>
            </Fact>
            <Fact label="On leave">
              <span className="tabular-nums">{totals.onLeave}</span>
            </Fact>
            <Fact label="Hours recorded">
              <span className="tabular-nums">{totals.hours.toFixed(1)}</span>
            </Fact>
          </FactGrid>
        )}
      </CardBody>
    </Card>
  );
}

function EmployeeRecord({ id }: { id: string }) {
  const [section, setSection] = useState<SectionKey>('profile');
  const role = useAuthStore((s) => s.user?.role);
  const { data, isLoading, isError } = useEmployee(id);
  const employee = data?.data;

  usePageHeader(
    employee ? fullName(employee) : 'Employee record',
    employee?.position ?? employee?.employeeCode,
  );

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading the record…</Card>;
  }

  if (isError || !employee) {
    return (
      <Card className="p-6 text-sm text-status-error">
        Could not load this employee record.
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex min-w-0 items-center gap-4">
          <span
            aria-hidden
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-primary text-base font-semibold text-text-on-brand"
          >
            {initials(employee)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text-heading">
              {employee.employeeCode}
            </p>
            <p className="truncate text-sm text-text-muted">
              {[employee.position, employee.department?.name, employee.branch?.name]
                .filter(Boolean)
                .join(' · ') || 'No placement recorded'}
            </p>
          </div>
          <Badge tone={STATUS_TONE[employee.status]}>{employee.status.replace(/_/g, ' ')}</Badge>
        </div>

        {hasPermission(role, 'EDIT_EMPLOYEE') && (
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/dashboard/contracts/new?employeeId=${employee.id}`}>
              <Button variant="outline" size="sm">
                <FilePlus2 className="h-4 w-4" aria-hidden />
                New contract
              </Button>
            </Link>
            <Link href={`/dashboard/employees/${employee.id}/edit`}>
              <Button size="sm">
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Button>
            </Link>
          </div>
        )}
      </Card>

      <div role="tablist" aria-label="Employee record sections" className="flex flex-wrap gap-2">
        {SECTIONS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`tab-${tab.key}`}
            aria-selected={section === tab.key}
            aria-controls={`panel-${tab.key}`}
            onClick={() => setSection(tab.key)}
            className={`rounded-[var(--radius-button)] px-3.5 py-1.5 text-sm font-medium transition-colors ${
              section === tab.key
                ? 'bg-brand-primary text-text-on-brand'
                : 'border border-surface-border text-text-body hover:bg-surface-border-light'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* One panel at a time, and only that panel's query runs: mounting all
          five would fire four requests nobody has asked to see. */}
      <div role="tabpanel" id={`panel-${section}`} aria-labelledby={`tab-${section}`}>
        {section === 'profile' && <ProfileSection employee={employee} />}
        {section === 'employment' && <EmploymentSection employee={employee} />}
        {section === 'contracts' && <ContractsSection employeeId={employee.id} />}
        {section === 'permits' && <PermitsSection employeeId={employee.id} />}
        {section === 'attendance' && <AttendanceSection employeeId={employee.id} />}
      </div>
    </div>
  );
}

export default function EmployeeRecordPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    // An employee is entitled to their own record and to nobody else's. Passing
    // the id from the URL lets the guard answer before the record loads, which
    // is what stops a frame of somebody else's data being painted.
    <ProtectedRoute requiredPermission="VIEW_EMPLOYEES" selfEmployeeId={id}>
      <EmployeeRecord id={id} />
    </ProtectedRoute>
  );
}
