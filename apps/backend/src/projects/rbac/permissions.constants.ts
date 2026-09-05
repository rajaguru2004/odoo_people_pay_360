/**
 * Project-scoped RBAC — canonical permission catalog + preset role definitions.
 * Single source of truth for the backend; the frontend mirrors these keys.
 */

export const PROJECT_PERMISSIONS = {
  PROJECT_EDIT: 'PROJECT_EDIT',
  PROJECT_ARCHIVE: 'PROJECT_ARCHIVE',
  PROJECT_DELETE: 'PROJECT_DELETE',
  MEMBER_MANAGE: 'MEMBER_MANAGE',
  ROLE_MANAGE: 'ROLE_MANAGE',
  TASK_CREATE: 'TASK_CREATE',
  TASK_ASSIGN: 'TASK_ASSIGN',
  TASK_EDIT: 'TASK_EDIT',
  TASK_DELETE: 'TASK_DELETE',
  TASK_STATUS_UPDATE: 'TASK_STATUS_UPDATE',
  SPRINT_MANAGE: 'SPRINT_MANAGE',
  STATUS_MANAGE: 'STATUS_MANAGE',
} as const;

export type ProjectPermission =
  (typeof PROJECT_PERMISSIONS)[keyof typeof PROJECT_PERMISSIONS];

export const ALL_PROJECT_PERMISSIONS: ProjectPermission[] = Object.values(
  PROJECT_PERMISSIONS,
);

export interface PermissionMeta {
  key: ProjectPermission;
  group: string;
  label: string;
}

/** Grouped catalog served to the UI matrix. Order defines display order. */
export const PROJECT_PERMISSION_CATALOG: PermissionMeta[] = [
  { key: PROJECT_PERMISSIONS.PROJECT_EDIT, group: 'Project', label: 'Edit project' },
  { key: PROJECT_PERMISSIONS.PROJECT_ARCHIVE, group: 'Project', label: 'Archive / unarchive' },
  { key: PROJECT_PERMISSIONS.PROJECT_DELETE, group: 'Project', label: 'Delete project' },
  { key: PROJECT_PERMISSIONS.MEMBER_MANAGE, group: 'Members', label: 'Manage members' },
  { key: PROJECT_PERMISSIONS.ROLE_MANAGE, group: 'Roles', label: 'Manage roles & permissions' },
  { key: PROJECT_PERMISSIONS.TASK_CREATE, group: 'Tasks', label: 'Create tasks' },
  { key: PROJECT_PERMISSIONS.TASK_ASSIGN, group: 'Tasks', label: 'Assign tasks' },
  { key: PROJECT_PERMISSIONS.TASK_EDIT, group: 'Tasks', label: 'Edit tasks' },
  { key: PROJECT_PERMISSIONS.TASK_DELETE, group: 'Tasks', label: 'Delete / archive tasks' },
  { key: PROJECT_PERMISSIONS.TASK_STATUS_UPDATE, group: 'Tasks', label: 'Update task status' },
  { key: PROJECT_PERMISSIONS.SPRINT_MANAGE, group: 'Sprints', label: 'Manage sprints' },
  { key: PROJECT_PERMISSIONS.STATUS_MANAGE, group: 'Workflow', label: 'Manage status columns' },
];

export interface PresetRoleDefinition {
  name: string;
  slug: string;
  description: string;
  color: string;
  isDefault: boolean;
  sortOrder: number;
  permissions: ProjectPermission[];
}

const P = PROJECT_PERMISSIONS;

/** The 4 seeded presets. OWNER always resolves to all permissions at runtime. */
export const PRESET_ROLE_DEFINITIONS: PresetRoleDefinition[] = [
  {
    name: 'Owner',
    slug: 'owner',
    description: 'Full control over the project.',
    color: '#00358F',
    isDefault: false,
    sortOrder: 0,
    permissions: [...ALL_PROJECT_PERMISSIONS],
  },
  {
    name: 'Manager',
    slug: 'manager',
    description: 'Create and assign tasks, manage sprints and workflow.',
    color: '#f66600',
    isDefault: false,
    sortOrder: 1,
    permissions: [
      P.TASK_CREATE,
      P.TASK_ASSIGN,
      P.TASK_EDIT,
      P.TASK_DELETE,
      P.TASK_STATUS_UPDATE,
      P.SPRINT_MANAGE,
      P.STATUS_MANAGE,
    ],
  },
  {
    name: 'Member',
    slug: 'member',
    description: 'Work on tasks and update their status.',
    color: '#0EA5E9',
    isDefault: true,
    sortOrder: 2,
    permissions: [P.TASK_STATUS_UPDATE],
  },
  {
    name: 'Viewer',
    slug: 'viewer',
    description: 'Read-only access to the project.',
    color: '#64748B',
    isDefault: false,
    sortOrder: 3,
    permissions: [],
  },
];

export const OWNER_ROLE_SLUG = 'owner';

/** Global user roles that bypass all project-scoped permission checks. */
export const GLOBAL_ADMIN_ROLES = ['ADMIN', 'HR_MANAGER'];

/** Prisma-shaped create payload for seeding a project's preset roles. */
export function presetRolesCreateData() {
  return PRESET_ROLE_DEFINITIONS.map((r) => ({
    name: r.name,
    slug: r.slug,
    description: r.description,
    color: r.color,
    isSystem: true,
    isDefault: r.isDefault,
    permissions: r.permissions,
    sortOrder: r.sortOrder,
  }));
}
