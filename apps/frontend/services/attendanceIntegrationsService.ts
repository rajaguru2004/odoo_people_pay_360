import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  AttendanceIntegration,
  BulkMapResult,
  CandidateEmployee,
  MappedEmployee,
  MappingSuggestion,
  ProviderCatalogue,
  SyncRunRow,
  SyncRunSummary,
  TestIntegrationInput,
  TestIntegrationResult,
  UnmappedExternalEmployee,
  UpsertIntegrationInput,
} from '@/types/attendanceIntegrations';

/**
 * External attendance providers (Settings ▸ Integrations).
 *
 * Sync and preview call a third-party API day by day, so they get generous
 * timeouts — a 31-day backfill is 31 sequential upstream requests.
 */
class AttendanceIntegrationsService {
  getProviders(): Promise<ApiResponse<ProviderCatalogue>> {
    return axiosInstance.get('/attendance-integrations/providers');
  }

  getAll(): Promise<ApiResponse<AttendanceIntegration[]>> {
    return axiosInstance.get('/attendance-integrations');
  }

  getOne(id: string): Promise<ApiResponse<AttendanceIntegration>> {
    return axiosInstance.get(`/attendance-integrations/${id}`);
  }

  create(dto: UpsertIntegrationInput): Promise<ApiResponse<AttendanceIntegration>> {
    return axiosInstance.post('/attendance-integrations', dto);
  }

  update(
    id: string,
    dto: UpsertIntegrationInput,
  ): Promise<ApiResponse<AttendanceIntegration>> {
    return axiosInstance.patch(`/attendance-integrations/${id}`, dto);
  }

  remove(id: string): Promise<ApiResponse<null>> {
    return axiosInstance.delete(`/attendance-integrations/${id}`);
  }

  testConnection(
    id: string,
    input: TestIntegrationInput = {},
  ): Promise<ApiResponse<TestIntegrationResult>> {
    return axiosInstance.post(`/attendance-integrations/${id}/test`, input, {
      timeout: 30_000,
    });
  }

  preview(
    id: string,
    from: string,
    to: string,
  ): Promise<ApiResponse<SyncRunSummary>> {
    return axiosInstance.post(
      `/attendance-integrations/${id}/preview`,
      { from, to },
      { timeout: 120_000 },
    );
  }

  sync(id: string, from: string, to: string): Promise<ApiResponse<SyncRunSummary>> {
    return axiosInstance.post(
      `/attendance-integrations/${id}/sync`,
      { from, to },
      { timeout: 180_000 },
    );
  }

  getUnmapped(id: string): Promise<ApiResponse<UnmappedExternalEmployee[]>> {
    return axiosInstance.get(`/attendance-integrations/${id}/unmapped`);
  }

  getMapped(id: string): Promise<ApiResponse<MappedEmployee[]>> {
    return axiosInstance.get(`/attendance-integrations/${id}/mapped`);
  }

  /** Unlinked ACTIVE employees in the integration's branch — for the bind picker. */
  getCandidates(
    id: string,
    search?: string,
  ): Promise<ApiResponse<CandidateEmployee[]>> {
    return axiosInstance.get(`/attendance-integrations/${id}/candidates`, {
      params: search ? { search } : undefined,
    });
  }

  mapEmployee(
    id: string,
    externalId: string,
    employeeId?: string,
    unlink = false,
  ): Promise<ApiResponse<null>> {
    return axiosInstance.post(`/attendance-integrations/${id}/map`, {
      externalId,
      employeeId,
      unlink,
    });
  }

  /** Name-scored proposals for every unmapped external id. Never auto-applied. */
  getSuggestions(id: string): Promise<ApiResponse<MappingSuggestion[]>> {
    return axiosInstance.get(`/attendance-integrations/${id}/suggestions`, {
      timeout: 60_000,
    });
  }

  bulkMap(
    id: string,
    entries: { externalId: string; employeeId: string }[],
  ): Promise<ApiResponse<BulkMapResult>> {
    return axiosInstance.post(
      `/attendance-integrations/${id}/map/bulk`,
      { entries },
      { timeout: 120_000 },
    );
  }

  getRuns(id: string, limit = 20): Promise<ApiResponse<SyncRunRow[]>> {
    return axiosInstance.get(`/attendance-integrations/${id}/runs`, {
      params: { limit },
    });
  }

  getRun(id: string, runId: string): Promise<ApiResponse<any>> {
    return axiosInstance.get(`/attendance-integrations/${id}/runs/${runId}`);
  }
}

export default new AttendanceIntegrationsService();
