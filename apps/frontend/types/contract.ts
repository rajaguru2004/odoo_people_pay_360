export type ContractType = 'PROBATION' | 'FIXED_TERM' | 'INDEFINITE';
export type ContractStatus = 'ACTIVE' | 'EXPIRED' | 'TERMINATED';
export type WorkType = 'FULL_TIME' | 'PART_TIME';

export interface Contract {
  id: string;
  employeeId: string;
  contractNumber: string;
  contractType: ContractType;
  workType: WorkType;
  workHoursPerWeek: number;
  startDate: string;
  endDate?: string;
  salary: number;
  status: ContractStatus;
  fileUrl?: string;
  terms?: string;
  notes?: string;
  terminatedReason?: string;
  createdAt: string;
  updatedAt: string;
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
    email?: string;
    phone?: string;
    position: string;
    department: {
      id: string;
      name: string;
    };
  };
}

export interface CreateContractData {
  employeeId: string;
  contractNumber?: string;
  contractType: ContractType;
  workType?: WorkType;
  workHoursPerWeek?: number;
  startDate: string;
  endDate?: string;
  salary: number;
  terms?: string;
  notes?: string;
}

export interface UpdateContractData extends Partial<CreateContractData> {
  status?: ContractStatus;
}

export interface ExpiringContract {
  contract: Contract;
  daysUntilExpiry: number;
}
