export interface Team {
  id: string;
  name: string;
  code: string;
  description?: string;
  departmentId: string;
  teamLeadId?: string;
  type: 'PERMANENT' | 'PROJECT' | 'CROSS_FUNCTIONAL';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  department?: {
    id: string;
    code: string;
    name: string;
  };
  teamLead?: {
    id: string;
    employeeCode: string;
    fullName: string;
    position: string;
    email?: string;
  };
  members?: TeamMember[];
  _count?: {
    members: number;
  };
}

export interface TeamMember {
  id: string;
  teamId: string;
  employeeId: string;
  role: 'LEAD' | 'SENIOR' | 'MEMBER' | 'CONTRIBUTOR';
  allocationPercentage: number;
  startDate: string;
  endDate?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    position: string;
    email: string;
    avatarUrl?: string;
  };
  team?: Team;
}

export interface CreateTeamData {
  name: string;
  code: string;
  description?: string;
  departmentId: string;
  teamLeadId?: string;
  type?: 'PERMANENT' | 'PROJECT' | 'CROSS_FUNCTIONAL';
}

export interface UpdateTeamData {
  name?: string;
  code?: string;
  description?: string;
  departmentId?: string;
  teamLeadId?: string;
  type?: 'PERMANENT' | 'PROJECT' | 'CROSS_FUNCTIONAL';
}

export interface AddTeamMemberData {
  employeeId: string;
  role?: 'LEAD' | 'SENIOR' | 'MEMBER' | 'CONTRIBUTOR';
  allocationPercentage?: number;
  startDate?: string;
  endDate?: string;
}

export interface EmployeeTeam extends Team {
  membership: {
    role: string;
    allocationPercentage: number;
    startDate: string;
    endDate?: string;
  };
}
