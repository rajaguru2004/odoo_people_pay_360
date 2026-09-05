import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  OrganizationHubSummary,
  TrendMonths,
} from '@/types/organizationHub';

class OrganizationService {
  /**
   * One aggregate for the whole hub.
   *
   * The page would otherwise fan out to six list endpoints and count rows off
   * them, which under-reports every queue longer than a page.
   */
  hubSummary(months: TrendMonths = 6): Promise<ApiResponse<OrganizationHubSummary>> {
    return axiosInstance.get('/organization/hub-summary', { params: { months } });
  }
}

export default new OrganizationService();
