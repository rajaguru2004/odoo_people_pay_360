export type ReimbursementStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'PAID'
  | 'CANCELLED';

export interface ReimbursementAttachment {
  id: string;
  reimbursementId: string;
  fileName: string;
  fileUrl: string;
  fileSize: number | null;
  mimeType: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
  uploader?: {
    id: string;
    email: string;
    employee?: { fullName: string; avatarUrl?: string | null } | null;
  } | null;
}

export interface Reimbursement {
  id: string;
  employeeId: string;
  type: string;
  amount: string | number;
  expenseDate: string;
  description?: string | null;
  status: ReimbursementStatus;
  approverId?: string | null;
  approvedAt?: string | null;
  approverRemarks?: string | null;
  rejectedReason?: string | null;
  payrollItemId?: string | null;
  paidAt?: string | null;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    email: string;
    departmentId?: string;
    department?: { id: string; name: string } | null;
  };
  approver?: {
    id: string;
    email: string;
    employee?: { fullName: string } | null;
  } | null;
  attachments?: ReimbursementAttachment[];
}

export interface CreateReimbursementData {
  type: string;
  amount: number;
  expenseDate: string;
  description?: string;
}
