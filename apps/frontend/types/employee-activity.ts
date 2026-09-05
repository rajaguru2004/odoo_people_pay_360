export interface EmployeeActivity {
  id: string;
  employeeId: string;
  activityType: string;
  action: string;
  description: string;
  oldValue?: any;
  newValue?: any;
  metadata?: any;
  performedBy?: string;
  createdAt: string;
  performer?: {
    id: string;
    email: string;
    employee?: {
      fullName: string;
      avatarUrl?: string;
    };
  };
}

export interface EmployeeActivityResponse {
  success: boolean;
  data: EmployeeActivity[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface ActivityStatsResponse {
  success: boolean;
  data: {
    type: string;
    count: number;
  }[];
}
