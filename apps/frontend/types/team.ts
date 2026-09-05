import type { EmployeeRef, NamedRef } from './common';

export type TeamType = 'PERMANENT' | 'PROJECT' | 'CROSS_FUNCTIONAL';
export type TeamMemberRole = 'LEAD' | 'MEMBER' | 'CONTRIBUTOR';

export interface TeamMember {
  id: string;
  teamId: string;
  employeeId: string;
  role: TeamMemberRole;
  /** 0–100. A person at 100% on three teams is a staffing problem worth seeing. */
  allocation: number;
  startDate: string;
  endDate?: string | null;
  isActive: boolean;
  employee?: EmployeeRef & { status?: string };
  createdAt: string;
  updatedAt: string;
}

export interface Team {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  departmentId: string;
  teamLeadId?: string | null;
  type: TeamType;
  isActive: boolean;
  department?: NamedRef | null;
  teamLead?: EmployeeRef | null;
  members?: TeamMember[];
  _count?: { members: number };
  createdAt: string;
  updatedAt: string;
}

export interface CreateTeamPayload {
  code: string;
  name: string;
  description?: string;
  departmentId: string;
  teamLeadId?: string;
  type?: TeamType;
  isActive?: boolean;
}

export type UpdateTeamPayload = Partial<CreateTeamPayload>;

export interface AddTeamMemberPayload {
  employeeId: string;
  role?: TeamMemberRole;
  allocation?: number;
  startDate?: string;
}

export type UpdateTeamMemberPayload = Partial<
  Omit<AddTeamMemberPayload, 'employeeId'>
> & { endDate?: string | null; isActive?: boolean };
