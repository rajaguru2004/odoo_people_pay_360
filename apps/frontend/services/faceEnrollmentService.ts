import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  CreateFaceEnrollmentPayload,
  FaceEnrollment,
  FaceEnrollmentStatus,
  FaceVerifyResult,
  VerifyFacePayload,
} from '@/types/attendance';

/**
 * Biometric enrolment.
 *
 * The face descriptor travels one way only. It goes up when a template is
 * registered and never comes back down: responses carry the enrolment's
 * existence, quality and date, and nothing that could be matched against a
 * person offline.
 */
class FaceEnrollmentService {
  list(): Promise<ApiResponse<FaceEnrollment[]>> {
    return axiosInstance.get('/face-enrollments');
  }

  forEmployee(employeeId: string): Promise<ApiResponse<FaceEnrollment[]>> {
    return axiosInstance.get(`/face-enrollments/employee/${employeeId}`);
  }

  /** The signed-in employee's own enrolment status. Counts and dates only. */
  status(): Promise<ApiResponse<FaceEnrollmentStatus>> {
    return axiosInstance.get('/face-enrollments/status');
  }

  create(
    payload: CreateFaceEnrollmentPayload,
  ): Promise<ApiResponse<FaceEnrollment>> {
    return axiosInstance.post('/face-enrollments', payload);
  }

  /**
   * Match a freshly captured probe against the enrolled templates.
   *
   * The comparison happens on the server for the same reason the descriptor
   * never comes down: matching in the browser would mean downloading everyone
   * else's template to compare against.
   */
  verify(payload: VerifyFacePayload): Promise<ApiResponse<FaceVerifyResult>> {
    return axiosInstance.post('/face-enrollments/verify', payload);
  }

  remove(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/face-enrollments/${id}`);
  }
}

export default new FaceEnrollmentService();
