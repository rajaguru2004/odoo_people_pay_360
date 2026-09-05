export type LeaveType = string;
export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string;
  status: LeaveStatus;
  approverId?: string;
  approvedAt?: string;
  rejectedReason?: string;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    department?: {
      id: string;
      name: string;
      managerId?: string;
    };
  };
  approver?: {
    id: string;
    email: string;
  };
  attachments?: LeaveAttachment[];
  approvals?: LeaveApproval[];
}

export interface LeaveAttachment {
  id: string;
  leaveRequestId: string;
  fileName: string;
  fileUrl: string;
  fileSize?: number;
  mimeType?: string;
  uploadedBy?: string;
  uploadedAt: string;
  uploader?: {
    id: string;
    email: string;
    employee?: {
      fullName: string;
      avatarUrl?: string;
    };
  };
}

export interface LeaveApproval {
  id: string;
  leaveRequestId: string;
  approverId: string;
  tier: number;
  status: string;
  comment?: string;
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
  approver: {
    id: string;
    email: string;
    employee?: {
      fullName: string;
      avatarUrl?: string;
    };
  };
}

export interface CreateLeaveRequestData {
  employeeId?: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  reason: string;
}

export interface LeaveTypeBalance {
  id: string;
  employeeId: string;
  year: number;
  leaveTypeKey: string;
  allocated: number;
  used: number;
  carriedOver: number;
  remaining: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface LeaveBalance {
  id: string;
  employeeId: string;
  year: number;
  annualLeave: number;
  usedAnnual: number;
  sickLeave: number;
  usedSick: number;
  carriedOver: number;
  remainingAnnual?: number;
  remainingSick?: number;
  leaveTypeBalances?: LeaveTypeBalance[];
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    gender?: string | null;
    department?: {
      name: string;
    };
  };
}

