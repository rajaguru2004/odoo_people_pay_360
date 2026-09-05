export interface PayrollBatch {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  members?: PayrollBatchMember[];
  _count?: {
    members: number;
  };
}

export interface PayrollBatchMember {
  id: string;
  batchId: string;
  employeeId: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    avatarUrl?: string;
    status: string;
    position: string;
    department: {
      id: string;
      name: string;
    };
  };
}

export interface CreateBatchData {
  name: string;
  description?: string;
  employeeIds: string[];
}

export interface UpdateBatchData {
  name?: string;
  description?: string;
  employeeIds?: string[];
}
