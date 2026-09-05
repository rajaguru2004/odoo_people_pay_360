import type { EmployeeRef, NamedRef, RequestStatus, UserRef } from './common';

export interface Department {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  isActive: boolean;
  branchId?: string | null;
  parentId?: string | null;
  managerId?: string | null;
  branch?: NamedRef | null;
  parent?: NamedRef | null;
  manager?: EmployeeRef | null;
  children?: Array<{ id: string; code: string; name: string; isActive: boolean }>;
  employees?: Array<
    EmployeeRef & { workEmail?: string | null; status: string }
  >;
  _count?: { employees: number; children: number; teams: number };
  createdAt: string;
  updatedAt: string;
}

/** A department with its subtree attached — what the org chart walks. */
export interface DepartmentNode {
  id: string;
  code: string;
  name: string;
  managerId: string | null;
  manager: { id: string; firstName: string; lastName: string } | null;
  branch: { id: string; name: string } | null;
  employees: number;
  teams: number;
  children: DepartmentNode[];
}

export interface DepartmentStatistics {
  total: number;
  withoutHead: number;
  rootCount: number;
  maxDepth: number;
  /** Direct reports, not department size — the bottleneck the number looks for. */
  spanOfControl: Array<{
    supervisorId: string | null;
    name: string;
    department: string | null;
    reports: number;
  }>;
}

export interface CreateDepartmentPayload {
  code: string;
  name: string;
  description?: string;
  branchId?: string;
  parentId?: string;
  managerId?: string;
  isActive?: boolean;
}

export interface UpdateDepartmentPayload
  extends Omit<Partial<CreateDepartmentPayload>, 'parentId'> {
  /** null moves the department to the top level; omitting it leaves the parent alone. */
  parentId?: string | null;
}

// ── Change requests ─────────────────────────────────────────────────────────

export type DepartmentChangeType =
  | 'MANAGER'
  | 'PARENT'
  | 'RENAME'
  | 'DEACTIVATE';

export interface DepartmentChangeRequest {
  id: string;
  departmentId: string;
  changeType: DepartmentChangeType;
  status: RequestStatus;

  /**
   * The `old*` fields are a SNAPSHOT taken when the request was raised, not a
   * live read. That is the point of them: the queue keeps showing the value as
   * it stood when somebody objected to it, even if the department has been
   * edited since.
   */
  oldManagerId?: string | null;
  newManagerId?: string | null;
  oldParentId?: string | null;
  newParentId?: string | null;
  oldName?: string | null;
  newName?: string | null;

  reason: string;
  effectiveDate: string;
  requestedById: string;
  reviewedById?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;

  department?: Pick<Department, 'id' | 'code' | 'name'>;
  requestedBy?: UserRef | null;
  reviewedBy?: UserRef | null;
  oldManager?: EmployeeRef | null;
  newManager?: EmployeeRef | null;
  oldParent?: NamedRef | null;
  newParent?: NamedRef | null;

  /** Computed live on the detail endpoint — what approving this would touch. */
  impact?: {
    affectedEmployees: number;
    affectedTeams: number;
    affectedChildDepartments: number;
    pendingCorrections: number;
  };

  createdAt: string;
  updatedAt: string;
}

export interface CreateChangeRequestPayload {
  departmentId: string;
  changeType: DepartmentChangeType;
  reason: string;
  effectiveDate: string;
  newManagerId?: string;
  newParentId?: string;
  newName?: string;
}
