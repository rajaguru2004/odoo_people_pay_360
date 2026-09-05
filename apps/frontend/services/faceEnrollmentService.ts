import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  CreateFaceEnrollmentPayload,
  FaceEnrollment,
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

  create(
    payload: CreateFaceEnrollmentPayload,
  ): Promise<ApiResponse<FaceEnrollment>> {
    return axiosInstance.post('/face-enrollments', payload);
  }

  remove(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/face-enrollments/${id}`);
  }
}

export default new FaceEnrollmentService();
