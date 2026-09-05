export type ChangeRequestType = 'CHANGE_MANAGER' | 'CHANGE_PARENT' | 'RESTRUCTURE';
export type ChangeRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type ReviewAction = 'APPROVE' | 'REJECT';

export interface DepartmentChangeRequest {
  id: string;
  departmentId: string;
  requestType: ChangeRequestType;
  requestedBy: string;
  
  oldManagerId?: string;
  oldParentId?: string;
  oldData?: any;
  
  newManagerId?: string;
  newParentId?: string;
  newData?: any;
  
  reason: string;
  status: ChangeRequestStatus;
  
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  
  effectiveDate: string;
  createdAt: string;
  updatedAt: string;
  
  // Relations
  department?: any;
  requester?: any;
  reviewer?: any;
  oldManager?: any;
  newManager?: any;
  oldParent?: any;
  newParent?: any;
  
  // Impact analysis
  impact?: {
    affectedEmployees: number;
    affectedTeams: number;
    pendingApprovals: {
      leaves: number;
      overtime: number;
    };
    estimatedTransitionDays: number;
  };
}

export interface CreateChangeRequestDto {
  requestType: ChangeRequestType;
  newManagerId?: string;
  newParentId?: string;
  reason: string;
  effectiveDate: string;
}

export interface ReviewChangeRequestDto {
  action: ReviewAction;
  reviewNote?: string;
}

export interface ManagerTransition {
  id: string;
  departmentId: string;
  changeRequestId?: string;
  
  oldManagerId?: string;
  newManagerId: string;
  
  status: 'INITIATED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  
  handoverTasks: HandoverTask[];
  completedTasks: HandoverTask[];
  progressPercentage: number;
  
  startDate: string;
  targetEndDate: string;
  actualEndDate?: string;
  
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HandoverTask {
  id: number;
  title: string;
  completed: boolean;
  completedAt?: string;
  completedBy?: string;
}

export interface DepartmentHistory {
  id: string;
  departmentId: string;
  changeType: 'CREATED' | 'UPDATED' | 'MANAGER_CHANGED' | 'PARENT_CHANGED' | 'DELETED' | 'ACTIVATED' | 'DEACTIVATED';
  changedBy: string;
  
  oldValue?: any;
  newValue?: any;
  changeReason?: string;
  
  ipAddress?: string;
  userAgent?: string;
  
  createdAt: string;
  
  // Relations
  department?: any;
  user?: any;
}
