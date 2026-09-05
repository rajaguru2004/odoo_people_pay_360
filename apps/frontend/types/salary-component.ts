export type ComponentType = 
  | 'ALLOWANCE'
  | 'BONUS'
  | 'DEDUCTION'
  | 'INSURANCE'
  | 'TAX'
  | 'OVERTIME'
  | 'COMMISSION'
  | 'OTHER';

export interface SalaryComponent {
  id: string;
  name: string;
  code: string;
  type: ComponentType;
  amount?: number;
  percentage?: number;
  isActive: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSalaryComponentData {
  name: string;
  code: string;
  type: ComponentType;
  amount?: number;
  percentage?: number;
  description?: string;
}

export interface UpdateSalaryComponentData extends Partial<CreateSalaryComponentData> {
  isActive?: boolean;
}

export interface SalaryCalculation {
  baseSalary: number;
  components: Array<{
    component: SalaryComponent;
    calculatedAmount: number;
  }>;
  totalSalary: number;
}
