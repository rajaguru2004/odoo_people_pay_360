import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  Course,
  CreateCourseData,
  CreateSessionData,
  RecordAttendanceData,
  TrainingNeed,
  TrainingNomination,
  TrainingSession,
} from '@/types/training';

class TrainingService {
  // ── Catalogue ──────────────────────────────────────────────────────────────

  async listCourses(activeOnly = false): Promise<ApiResponse<Course[]>> {
    return axiosInstance.get('/training/courses', { params: { activeOnly } });
  }

  async createCourse(data: CreateCourseData): Promise<ApiResponse<Course>> {
    return axiosInstance.post('/training/courses', data);
  }

  async updateCourse(
    id: string,
    data: Partial<CreateCourseData> & { isActive?: boolean },
  ): Promise<ApiResponse<Course>> {
    return axiosInstance.patch(`/training/courses/${id}`, data);
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  async listSessions(params: {
    status?: string;
    from?: string;
    to?: string;
  } = {}): Promise<ApiResponse<TrainingSession[]>> {
    return axiosInstance.get('/training/sessions', { params });
  }

  async createSession(
    data: CreateSessionData,
  ): Promise<ApiResponse<TrainingSession>> {
    return axiosInstance.post('/training/sessions', data);
  }

  // ── Nominations ────────────────────────────────────────────────────────────

  async listNominations(params: {
    sessionId?: string;
    status?: string;
  } = {}): Promise<ApiResponse<TrainingNomination[]>> {
    return axiosInstance.get('/training/nominations', { params });
  }

  async getMyTraining(): Promise<ApiResponse<TrainingNomination[]>> {
    return axiosInstance.get('/training/my-training');
  }

  async nominate(data: {
    sessionId: string;
    employeeId: string;
    source?: 'MANUAL' | 'APPRAISAL';
    appraisalResultId?: string;
    justification?: string;
  }): Promise<ApiResponse<TrainingNomination>> {
    return axiosInstance.post('/training/nominations', data);
  }

  async approve(id: string, remarks?: string): Promise<ApiResponse<TrainingNomination>> {
    return axiosInstance.post(`/training/nominations/${id}/approve`, { remarks });
  }

  async reject(id: string, remarks?: string): Promise<ApiResponse<TrainingNomination>> {
    return axiosInstance.post(`/training/nominations/${id}/reject`, { remarks });
  }

  /** Certificate expiry is derived server-side from the course validity window. */
  async recordAttendance(
    id: string,
    data: RecordAttendanceData,
  ): Promise<ApiResponse<TrainingNomination>> {
    return axiosInstance.post(`/training/nominations/${id}/attendance`, data);
  }

  async cancel(id: string): Promise<ApiResponse<TrainingNomination>> {
    return axiosInstance.delete(`/training/nominations/${id}`);
  }

  // ── The differentiator ─────────────────────────────────────────────────────

  /**
   * Training needs derived from a completed AI appraisal run. Suggestions only —
   * acting on one is a separate, human decision.
   */
  async needsFromRun(
    runId: string,
    all = false,
  ): Promise<ApiResponse<TrainingNeed[]>> {
    return axiosInstance.get(`/training/needs/from-run/${runId}`, {
      params: all ? { all: true } : {},
    });
  }
}

export default new TrainingService();
