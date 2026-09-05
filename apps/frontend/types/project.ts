// Project Management types (Work Hive port)

export type ProjectStatus = 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export type ProjectPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type ProjectVisibility = 'PRIVATE' | 'INTERNAL' | 'PUBLIC';
export type ProjectMemberRole = 'OWNER' | 'MANAGER' | 'MEMBER' | 'VIEWER';
export type StatusCategory = 'TODO' | 'IN_PROGRESS' | 'DONE';
export type SprintStatus = 'PLANNING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type TaskType = 'TASK' | 'BUG' | 'EPIC' | 'STORY' | 'SUBTASK';

export interface EmployeeLite {
  id: string;
  fullName: string;
  employeeCode: string;
  email: string;
  avatarUrl?: string;
}

export interface ProjectTaskStatus {
  id: string;
  name: string;
  color: string;
  category: StatusCategory;
  position: number;
  isDefault: boolean;
  workflowId: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
  statuses?: ProjectTaskStatus[];
}

export type ProjectPermission =
  | 'PROJECT_EDIT'
  | 'PROJECT_ARCHIVE'
  | 'PROJECT_DELETE'
  | 'MEMBER_MANAGE'
  | 'ROLE_MANAGE'
  | 'TASK_CREATE'
  | 'TASK_ASSIGN'
  | 'TASK_EDIT'
  | 'TASK_DELETE'
  | 'TASK_STATUS_UPDATE'
  | 'SPRINT_MANAGE'
  | 'STATUS_MANAGE';

export interface ProjectRole {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description?: string | null;
  color?: string | null;
  isSystem: boolean;
  isDefault: boolean;
  permissions: ProjectPermission[];
  sortOrder: number;
}

export interface ProjectMember {
  id: string;
  projectId: string;
  employeeId: string;
  role: ProjectMemberRole;
  roleId?: string | null;
  projectRole?: Pick<
    ProjectRole,
    'id' | 'name' | 'slug' | 'color' | 'permissions' | 'isSystem' | 'isDefault'
  > | null;
  joinedAt: string;
  employee?: EmployeeLite;
}

export interface ProjectAccess {
  isGlobalAdmin: boolean;
  isOwner: boolean;
  roleSlug: string | null;
  permissions: ProjectPermission[];
}

export interface PermissionCatalogItem {
  key: ProjectPermission;
  group: string;
  label: string;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  projectId: string;
}

export interface Sprint {
  id: string;
  name: string;
  slug?: string;
  goal?: string;
  status: SprintStatus;
  isDefault: boolean;
  isArchived: boolean;
  startDate?: string;
  endDate?: string;
  projectId: string;
  _count?: { tasks: number };
}

export interface Project {
  id: string;
  projectCode: string;
  name: string;
  slug: string;
  taskPrefix?: string;
  description?: string;
  color: string;
  avatar?: string;
  status: ProjectStatus;
  priority: ProjectPriority;
  visibility: ProjectVisibility;
  startDate?: string;
  endDate?: string;
  workflowId?: string;
  departmentId?: string;
  teamId?: string;
  ownerId?: string;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  owner?: EmployeeLite;
  department?: { id: string; name: string; code: string };
  team?: { id: string; name: string; code: string };
  workflow?: Workflow;
  members?: ProjectMember[];
  _count?: { tasks: number; members: number; sprints: number };
}

export interface CreateProjectData {
  name: string;
  slug?: string;
  taskPrefix?: string;
  description?: string;
  color?: string;
  status?: ProjectStatus;
  priority?: ProjectPriority;
  visibility?: ProjectVisibility;
  startDate?: string;
  endDate?: string;
  workflowId?: string;
  departmentId?: string;
  teamId?: string;
  ownerId?: string;
  memberIds?: string[];
}

export type TaskPriorityValue = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ProjectTask {
  id: string;
  taskCode: string;
  title: string;
  description?: string;
  type: TaskType;
  priority: TaskPriorityValue;
  status: string;
  statusId?: string;
  projectId?: string;
  sprintId?: string;
  parentTaskId?: string;
  storyPoints?: number;
  dueDate?: string;
  startDate?: string;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  assignees?: EmployeeLite[];
  reporter?: EmployeeLite;
  workflowStatus?: { id: string; name: string; color: string; category: StatusCategory; position: number };
  project?: { id: string; name: string; slug: string; color: string; projectCode: string };
  labels?: { label: Label }[];
  _count?: { comments: number; attachments: number; workLogs: number; childTasks: number };
  locationName?: string;
  latitude?: number;
  longitude?: number;
}

export interface KanbanColumn extends ProjectTaskStatus {
  tasks: ProjectTask[];
}

export interface ProjectQueryParams {
  status?: string;
  priority?: string;
  departmentId?: string;
  search?: string;
  isArchived?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
