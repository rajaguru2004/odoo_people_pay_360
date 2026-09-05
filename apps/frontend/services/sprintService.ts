import axiosInstance from '@/lib/axios';
import type { Sprint } from '@/types/project';

/**
 * What `complete()` and `cancel()` resolve with.
 *
 * `tasksReturnedToBacklog` is a SIBLING of `data`, like the letters `warning` —
 * `lib/axios.ts` resolves with the whole `response.data`, so it arrives intact
 * as long as the caller does not go looking for it inside the sprint.
 *
 * It is there because closing a sprint now moves rows the request never named
 * (R39, and R37 for cancel): the sprint's still-open tasks get `sprintId = null`
 * in the same transaction. A user who does not see that count has watched their
 * unfinished work disappear off a board with no explanation, which is the whole
 * reason the number is reported rather than merely done.
 */
export interface SprintCloseResult {
  success: boolean;
  /** The server's own English sentence. The UI translates instead — see ProjectSprints. */
  message?: string;
  data: Sprint;
  tasksReturnedToBacklog: number;
}

export interface CreateSprintData {
  projectId: string;
  name: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
}

class SprintService {
  async list(projectId: string, status?: string) {
    return axiosInstance.get('/sprints', { params: { projectId, status } });
  }
  async get(id: string) {
    return axiosInstance.get(`/sprints/${id}`);
  }
  async create(data: CreateSprintData) {
    return axiosInstance.post('/sprints', data);
  }
  /**
   * Fields only. `status` is deliberately NOT accepted here.
   *
   * A sprint's status is owned by the two lifecycle verbs below, which are the
   * only things that know the state machine — `start()` refuses a sprint that
   * is not PLANNING, `complete()` one that is not ACTIVE. `UpdateSprintDto` no
   * longer carries `status` at all, and `forbidNonWhitelisted` turns a
   * `PATCH /sprints/:id { status }` into a 400 "property status should not
   * exist". Leaving the field on this type would tell the next caller that a
   * generic PATCH is a legitimate way to move a sprint, which is exactly how
   * the old no-state-machine behaviour got driven.
   */
  async update(id: string, data: Partial<CreateSprintData>) {
    return axiosInstance.patch(`/sprints/${id}`, data);
  }
  async start(id: string) {
    return axiosInstance.patch(`/sprints/${id}/start`);
  }
  async complete(id: string): Promise<SprintCloseResult> {
    return axiosInstance.patch(`/sprints/${id}/complete`);
  }
  /**
   * PLANNING or ACTIVE -> CANCELLED, and CANCELLED is terminal exactly as
   * COMPLETED is. Gated by the same `SPRINT_MANAGE` permission as the other two
   * verbs.
   *
   * R37: `SprintStatus.CANCELLED` used to be reachable only through the generic
   * `PATCH /sprints/:id`, where it had no verb, no message and no side effects —
   * cancelling was indistinguishable from renaming, and a CANCELLED sprint could
   * be started again. It is a real operation now, and like `complete()` it hands
   * the sprint's open work back to the backlog.
   */
  async cancel(id: string): Promise<SprintCloseResult> {
    return axiosInstance.patch(`/sprints/${id}/cancel`);
  }
  async remove(id: string) {
    return axiosInstance.delete(`/sprints/${id}`);
  }
}

export default new SprintService();
