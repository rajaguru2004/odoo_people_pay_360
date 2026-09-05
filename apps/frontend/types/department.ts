export interface Department {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  branch?: { id: string; code: string; name: string } | null;
  manager?: { id: string; employeeCode: string; firstName: string; lastName: string } | null;
  _count?: { employees: number };
  createdAt: string;
  updatedAt: string;
}
