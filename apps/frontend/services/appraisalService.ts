import axiosInstance from '@/lib/axios';
import {
  AppraisalPeriodPreset,
  AppraisalResult,
  AppraisalRunDetail,
  AppraisalRunSummary,
} from '@/types/appraisal';

export interface CreateRunBody {
  preset: AppraisalPeriodPreset;
  startDate?: string;
  endDate?: string;
  departmentIds?: string[];
  employeeIds?: string[];
}

/**
 * The appraisal endpoints return raw payloads (no {success,data} envelope);
 * the axios interceptor already unwraps response.data.
 */
class AppraisalService {
  async createRun(body: CreateRunBody): Promise<AppraisalRunSummary> {
    return axiosInstance.post('/appraisal/runs', body) as unknown as Promise<AppraisalRunSummary>;
  }

  async listRuns(): Promise<AppraisalRunSummary[]> {
    return axiosInstance.get('/appraisal/runs') as unknown as Promise<AppraisalRunSummary[]>;
  }

  async getRun(id: string): Promise<AppraisalRunDetail> {
    return axiosInstance.get(`/appraisal/runs/${id}`) as unknown as Promise<AppraisalRunDetail>;
  }

  async getResult(runId: string, resultId: string): Promise<AppraisalResult> {
    return axiosInstance.get(
      `/appraisal/runs/${runId}/results/${resultId}`,
    ) as unknown as Promise<AppraisalResult>;
  }

  async cancelRun(id: string): Promise<{ cancelRequested: boolean }> {
    return axiosInstance.post(`/appraisal/runs/${id}/cancel`) as unknown as Promise<{
      cancelRequested: boolean;
    }>;
  }

  async deleteRun(id: string): Promise<{ deleted: boolean }> {
    return axiosInstance.delete(`/appraisal/runs/${id}`) as unknown as Promise<{
      deleted: boolean;
    }>;
  }
}

export default new AppraisalService();
