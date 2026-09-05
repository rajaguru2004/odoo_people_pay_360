import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  CreateTravelRequestData,
  OnTripRow,
  QueryTravelParams,
  TravelRequest,
} from '@/types/travel';

class TravelService {
  async getAll(
    params: QueryTravelParams = {},
  ): Promise<ApiResponse<TravelRequest[]>> {
    return axiosInstance.get('/travel-requests', { params });
  }

  async getMyRequests(): Promise<ApiResponse<TravelRequest[]>> {
    return axiosInstance.get('/travel-requests/my-requests');
  }

  /** Trip detail, including every reimbursement claim the trip spawned. */
  async getById(id: string): Promise<ApiResponse<TravelRequest>> {
    return axiosInstance.get(`/travel-requests/${id}`);
  }

  /** Who is away in a window — read-only; a trip is not leave. */
  async getOnTrip(from: string, to: string): Promise<ApiResponse<OnTripRow[]>> {
    return axiosInstance.get('/travel-requests/on-trip', { params: { from, to } });
  }

  /**
   * Raise a trip. On final approval the server spawns the per-diem claim, the
   * advance, and the visa alert — the client does not orchestrate any of that.
   */
  async create(
    data: CreateTravelRequestData,
    employeeId?: string,
  ): Promise<ApiResponse<TravelRequest>> {
    return axiosInstance.post('/travel-requests', data, {
      params: employeeId ? { employeeId } : {},
    });
  }

  async approve(id: string, remarks?: string): Promise<ApiResponse<TravelRequest>> {
    return axiosInstance.post(`/travel-requests/${id}/approve`, { remarks });
  }

  async reject(id: string, remarks?: string): Promise<ApiResponse<TravelRequest>> {
    return axiosInstance.post(`/travel-requests/${id}/reject`, { remarks });
  }

  /** Withdraws unspent claims too; never anything already in payroll. */
  async cancel(id: string): Promise<ApiResponse<TravelRequest>> {
    return axiosInstance.delete(`/travel-requests/${id}`);
  }
}

export default new TravelService();
