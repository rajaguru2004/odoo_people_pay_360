import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type { ReviewPayload } from '@/types/common';
import type {
  AttendanceCorrection,
  CorrectionListQuery,
  CorrectionStats,
  CreateCorrectionPayload,
} from '@/types/attendance';

class AttendanceCorrectionService {
  /**
   * An EMPLOYEE caller only ever gets their own rows — the server narrows from
   * the principal rather than trusting a query parameter, so passing
   * `employeeId` here widens nothing.
   */
  list(
    query: CorrectionListQuery = {},
  ): Promise<ApiResponse<AttendanceCorrection[]>> {
    return axiosInstance.get('/attendance-corrections', { params: query });
  }

  stats(): Promise<ApiResponse<CorrectionStats>> {
    return axiosInstance.get('/attendance-corrections/stats');
  }

  get(id: string): Promise<ApiResponse<AttendanceCorrection>> {
    return axiosInstance.get(`/attendance-corrections/${id}`);
  }

  create(
    payload: CreateCorrectionPayload,
  ): Promise<ApiResponse<AttendanceCorrection>> {
    return axiosInstance.post('/attendance-corrections', payload);
  }

  /** Approving writes the requested times onto the attendance row and stamps it
   *  MANUAL, so a later import cannot silently undo the decision. */
  review(
    id: string,
    payload: ReviewPayload,
  ): Promise<ApiResponse<AttendanceCorrection>> {
    return axiosInstance.patch(`/attendance-corrections/${id}/review`, payload);
  }

  cancel(id: string): Promise<ApiResponse<AttendanceCorrection>> {
    return axiosInstance.patch(`/attendance-corrections/${id}/cancel`);
  }
}

export default new AttendanceCorrectionService();
