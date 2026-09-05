import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  AssignSupervisorPayload,
  BulkAssignSupervisorPayload,
  SupervisedEmployee,
  SupervisedTeam,
} from '@/types/supervisor';

class SupervisorService {
  /** Everyone the signed-in caller supervises. Empty for a user with no employee record. */
  myTeam(): Promise<ApiResponse<SupervisedTeam>> {
    return axiosInstance.get('/supervisors/my-team');
  }

  /** Everyone a named supervisor signs for. */
  reports(supervisorId: string): Promise<ApiResponse<SupervisedTeam>> {
    return axiosInstance.get(`/supervisors/reports/${supervisorId}`);
  }

  /** One employee's supervisor, or null when they have none. */
  supervisorOf(employeeId: string): Promise<ApiResponse<SupervisedEmployee | null>> {
    return axiosInstance.get(`/supervisors/of/${employeeId}`);
  }

  assign(payload: AssignSupervisorPayload): Promise<ApiResponse<SupervisedEmployee>> {
    return axiosInstance.post('/supervisors/assign', payload);
  }

  bulkAssign(payload: BulkAssignSupervisorPayload): Promise<ApiResponse<SupervisedTeam>> {
    return axiosInstance.post('/supervisors/bulk-assign', payload);
  }

  /** Detaches an employee, dropping them back to having no supervisor at all. */
  unassign(employeeId: string): Promise<ApiResponse<SupervisedEmployee>> {
    return axiosInstance.delete(`/supervisors/assignment/${employeeId}`);
  }
}

export default new SupervisorService();
