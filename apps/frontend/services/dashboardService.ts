import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  DashboardOverview,
  DashboardOverviewQuery,
} from '@/types/dashboardOverview';

/**
 * The main dashboard's one endpoint.
 *
 * One method on purpose. `/dashboard` is the route every role opens, and the
 * server decides per caller which blocks come back — so the entitlement
 * decision has to be taken ONCE, for the whole page. Fanning out to a workforce
 * endpoint, an attendance endpoint and a payroll endpoint would put that
 * decision in three places and leave the reader with panels that half-loaded
 * and half-403'd, with nothing on screen saying which was which.
 *
 * The response's `sections` array is the contract for what arrived; consumers
 * read that, never a truthy figure. See `types/dashboardOverview.ts`.
 */
class DashboardService {
  overview(
    query: DashboardOverviewQuery = {},
  ): Promise<ApiResponse<DashboardOverview>> {
    return axiosInstance.get('/dashboard/overview', { params: query });
  }
}

const dashboardService = new DashboardService();
export default dashboardService;
