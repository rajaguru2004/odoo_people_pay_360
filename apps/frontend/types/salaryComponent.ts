export type ComponentType = string;

export interface SalaryComponent {
  id: string;
  employeeId: string;
  componentType: ComponentType;
  amount: number;
  effectiveDate: string;
  isActive: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    department?: {
      name: string;
    };
  };
}

export interface CreateSalaryComponentData {
  employeeId: string;
  componentType: ComponentType;
  amount: number;
  effectiveDate?: string;
  note?: string;
}

export interface UpdateSalaryComponentData {
  componentType?: ComponentType;
  amount?: number;
  effectiveDate?: string;
  isActive?: boolean;
  note?: string;
}

export interface EmployeeSalaryStructure {
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
  };
  components: SalaryComponent[];
  totalSalary: number;
}
