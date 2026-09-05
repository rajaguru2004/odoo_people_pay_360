import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
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
  // ── Register ───────────────────────────────────────────────────────────────

  async getAll(params: QueryAssetsParams = {}): Promise<ApiResponse<AssetItem[]>> {
    return axiosInstance.get('/assets', { params });
  }

  async getById(id: string): Promise<ApiResponse<AssetItem>> {
    return axiosInstance.get(`/assets/${id}`);
  }

  async getSummary(): Promise<ApiResponse<AssetSummary>> {
    return axiosInstance.get('/assets/summary');
  }

  async create(data: CreateAssetData): Promise<ApiResponse<AssetItem>> {
    return axiosInstance.post('/assets', data);
  }

  async update(
    id: string,
    data: Partial<CreateAssetData>,
  ): Promise<ApiResponse<AssetItem>> {
    return axiosInstance.patch(`/assets/${id}`, data);
  }

  async delete(id: string): Promise<ApiResponse<null>> {
    return axiosInstance.delete(`/assets/${id}`);
  }

  // ── Custody ────────────────────────────────────────────────────────────────

  async assign(data: AssignAssetData): Promise<ApiResponse<AssetAssignment>> {
    return axiosInstance.post('/assets/assignments', data);
  }

  async returnAsset(
    assignmentId: string,
    data: ReturnAssetData = {},
  ): Promise<ApiResponse<AssetAssignment>> {
    return axiosInstance.post(`/assets/assignments/${assignmentId}/return`, data);
  }

  async getOpenAssignments(
    employeeId?: string,
  ): Promise<ApiResponse<AssetAssignment[]>> {
    return axiosInstance.get('/assets/assignments/open', {
      params: employeeId ? { employeeId } : {},
    });
  }

  // ── ESS ────────────────────────────────────────────────────────────────────

  async getMyAssets(openOnly = false): Promise<ApiResponse<AssetAssignment[]>> {
    return axiosInstance.get('/assets/my', { params: { openOnly } });
  }

  /** The employee's digital receipt. Only the holder may call this. */
  async acknowledge(
    assignmentId: string,
    note?: string,
  ): Promise<ApiResponse<AssetAssignment>> {
    return axiosInstance.post(`/assets/assignments/${assignmentId}/acknowledge`, {
      note,
    });
  }

  // ── Clearance ──────────────────────────────────────────────────────────────

  /**
   * Whether an employee can be offboarded. `cleared: false` blocks termination
   * approval, direct contract termination and employee soft-delete alike.
   */
  async getClearance(employeeId: string): Promise<ApiResponse<ClearanceStatus>> {
    return axiosInstance.get(`/assets/clearance/${employeeId}`);
  }

  /** Assets still held by people who have already left — an HR worklist. */
  async getOutstanding(): Promise<ApiResponse<AssetAssignment[]>> {
    return axiosInstance.get('/assets/clearance/reports/outstanding');
  }
}

export default new AssetService();
