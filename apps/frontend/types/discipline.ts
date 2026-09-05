export type DisciplineType = 'WARNING' | 'FINE' | 'DEMOTION' | 'TERMINATION';

export interface Discipline {
  id: string;
  employeeId: string;
  reason: string;
  disciplineType: DisciplineType;
  amount: number;
  disciplineDate: string;
  createdBy: string;
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
  creator?: {
    id: string;
    email: string;
  };
}

export interface CreateDisciplineData {
  employeeId: string;
  reason: string;
  disciplineType: DisciplineType;
  amount: number;
  disciplineDate: string;
}

export interface DisciplineStats {
  totalDisciplines: number;
  totalFines: number;
  byType: {
    type: DisciplineType;
    count: number;
    amount: number;
  }[];
}
