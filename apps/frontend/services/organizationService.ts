import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type { OrganizationHubSummary, TrendMonths } from '@/types/organizationHub';

/**
 * The Organization module's cross-cutting reads.
 *
 * The hub aggregate spans departments, branches, employees and change requests,
 * so it belongs to none of `branchService` / `departmentService` / and lives
 * here instead — the same reason it has its own module on the server.
 */
class OrganizationService {
  async getHubSummary(months: TrendMonths = 6): Promise<ApiResponse<OrganizationHubSummary>> {
    return axiosInstance.get('/organization/hub-summary', { params: { months } });
  }
}

const organizationService = new OrganizationService();
export default organizationService;
