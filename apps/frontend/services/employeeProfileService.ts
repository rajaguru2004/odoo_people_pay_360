import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  EmployeeProfile,
  UpdateEmployeeProfilePayload,
} from '@/types/employeeProfile';

/**
 * A person's own record.
 *
 * Deliberately separate from `employeeService`, which is HR's door onto the
 * same rows: `PATCH /employees/:id` asserts facts about somebody and is refused
 * to everyone but ADMIN and HR, while `PATCH /employees/:id/profile` is a person
 * maintaining their own contact details and is open to them. Merging the two
 * services would hide which one a screen is actually allowed to call.
 */
class EmployeeProfileService {
  get(employeeId: string): Promise<ApiResponse<EmployeeProfile>> {
    return axiosInstance.get(`/employees/${employeeId}/profile`);
  }

  update(
    employeeId: string,
    payload: UpdateEmployeeProfilePayload,
  ): Promise<ApiResponse<EmployeeProfile>> {
    return axiosInstance.patch(`/employees/${employeeId}/profile`, payload);
  }
}

export default new EmployeeProfileService();
