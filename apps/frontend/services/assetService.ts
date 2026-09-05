import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  AssetAssignment,
  AssetItem,
  AssetSummary,
  AssignAssetData,
  ClearanceStatus,
  CreateAssetData,
  QueryAssetsParams,
  ReturnAssetData,
} from '@/types/asset';

class AssetService {
  // ── The register ───────────────────────────────────────────────────────────

  list(params: QueryAssetsParams = {}): Promise<ApiResponse<AssetItem[]>> {
    return axiosInstance.get('/assets', { params });
  }

  get(id: string): Promise<ApiResponse<AssetItem>> {
    return axiosInstance.get(`/assets/${id}`);
  }

  summary(): Promise<ApiResponse<AssetSummary>> {
    return axiosInstance.get('/assets/summary');
  }

  create(payload: CreateAssetData): Promise<ApiResponse<AssetItem>> {
    return axiosInstance.post('/assets', payload);
  }

  update(
    id: string,
    payload: Partial<CreateAssetData>,
  ): Promise<ApiResponse<AssetItem>> {
    return axiosInstance.patch(`/assets/${id}`, payload);
  }

  remove(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/assets/${id}`);
  }

  // ── Custody ────────────────────────────────────────────────────────────────

  assign(payload: AssignAssetData): Promise<ApiResponse<AssetAssignment>> {
    return axiosInstance.post('/assets/assignments', payload);
  }

  returnAsset(
    assignmentId: string,
    payload: ReturnAssetData = {},
  ): Promise<ApiResponse<AssetAssignment>> {
    return axiosInstance.post(
      `/assets/assignments/${assignmentId}/return`,
      payload,
    );
  }

  openAssignments(employeeId?: string): Promise<ApiResponse<AssetAssignment[]>> {
    return axiosInstance.get('/assets/assignments/open', {
      params: employeeId ? { employeeId } : {},
    });
  }

  // ── Self-service ───────────────────────────────────────────────────────────

  mine(openOnly = false): Promise<ApiResponse<AssetAssignment[]>> {
    return axiosInstance.get('/assets/my', { params: { openOnly } });
  }

  /** The digital receipt. Only the holder may call it. */
  acknowledge(
    assignmentId: string,
    note?: string,
  ): Promise<ApiResponse<AssetAssignment>> {
    return axiosInstance.post(
      `/assets/assignments/${assignmentId}/acknowledge`,
      { note },
    );
  }

  // ── Offboarding ────────────────────────────────────────────────────────────

  /** `cleared: false` is what blocks a termination from completing. */
  clearance(employeeId: string): Promise<ApiResponse<ClearanceStatus>> {
    return axiosInstance.get(`/assets/clearance/${employeeId}`);
  }

  /** Assets still held by people who have already left — a worklist. */
  outstanding(): Promise<ApiResponse<AssetAssignment[]>> {
    return axiosInstance.get('/assets/clearance/reports/outstanding');
  }
}

export default new AssetService();
