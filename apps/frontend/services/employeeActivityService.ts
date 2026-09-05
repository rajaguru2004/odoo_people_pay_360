import axios from '@/lib/axios';
import { EmployeeActivityResponse, ActivityStatsResponse } from '@/types/employee-activity';

export const employeeActivityService = {
  /**
   * Get employee activities
   */
  async getActivities(
    employeeId: string,
    params?: {
      type?: string;
      page?: number;
      limit?: number;
    }
  ): Promise<EmployeeActivityResponse> {
    console.log('📡 API Call: GET /employees/' + employeeId + '/activities');
    console.log('   Params:', params);

    // axios interceptor already returns response.data
    // so we don't need to access .data again
    const data = await axios.get(`/employees/${employeeId}/activities`, { params });

    console.log('📥 API Response:', data);
    return data as unknown as EmployeeActivityResponse;
  },

  /**
   * Get activity statistics
   */
  async getStats(employeeId: string): Promise<ActivityStatsResponse> {
    // axios interceptor already returns response.data
    const data = await axios.get(`/employees/${employeeId}/activities/stats`);
    return data as unknown as ActivityStatsResponse;
  },
};
