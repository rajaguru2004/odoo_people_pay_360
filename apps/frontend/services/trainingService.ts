import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  Course,
  CreateCourseData,
  CreateSessionData,
  RecordAttendanceData,
  TrainingNomination,
  TrainingSession,
  TrainingStats,
} from '@/types/training';

class TrainingService {
  stats(): Promise<ApiResponse<TrainingStats>> {
    return axiosInstance.get('/training/stats');
  }

  // ── The catalogue ──────────────────────────────────────────────────────────

  listCourses(activeOnly = false): Promise<ApiResponse<Course[]>> {
    return axiosInstance.get('/training/courses', { params: { activeOnly } });
  }

  createCourse(payload: CreateCourseData): Promise<ApiResponse<Course>> {
    return axiosInstance.post('/training/courses', payload);
  }

  updateCourse(
    id: string,
    payload: Partial<CreateCourseData>,
  ): Promise<ApiResponse<Course>> {
    return axiosInstance.patch(`/training/courses/${id}`, payload);
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  listSessions(
    params: { status?: string; from?: string; to?: string } = {},
  ): Promise<ApiResponse<TrainingSession[]>> {
    return axiosInstance.get('/training/sessions', { params });
  }

  createSession(
    payload: CreateSessionData,
  ): Promise<ApiResponse<TrainingSession>> {
    return axiosInstance.post('/training/sessions', payload);
  }

  // ── Nominations ────────────────────────────────────────────────────────────

  listNominations(
    params: { sessionId?: string; status?: string } = {},
  ): Promise<ApiResponse<TrainingNomination[]>> {
    return axiosInstance.get('/training/nominations', { params });
  }

  mine(): Promise<ApiResponse<TrainingNomination[]>> {
    return axiosInstance.get('/training/my-training');
  }

  nominate(payload: {
    sessionId: string;
    employeeId: string;
    justification?: string;
  }): Promise<ApiResponse<TrainingNomination>> {
    return axiosInstance.post('/training/nominations', payload);
  }

  approve(
    id: string,
    remarks?: string,
  ): Promise<ApiResponse<TrainingNomination>> {
    return axiosInstance.post(`/training/nominations/${id}/approve`, { remarks });
  }

  reject(id: string, remarks?: string): Promise<ApiResponse<TrainingNomination>> {
    return axiosInstance.post(`/training/nominations/${id}/reject`, { remarks });
  }

  /** Certificate expiry is derived server-side from the course validity window. */
  recordAttendance(
    id: string,
    payload: RecordAttendanceData,
  ): Promise<ApiResponse<TrainingNomination>> {
    return axiosInstance.post(`/training/nominations/${id}/attendance`, payload);
  }

  cancel(id: string): Promise<ApiResponse<TrainingNomination>> {
    return axiosInstance.delete(`/training/nominations/${id}`);
  }
}

export default new TrainingService();
