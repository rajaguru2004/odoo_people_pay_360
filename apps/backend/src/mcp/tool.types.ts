import { ZodRawShape } from 'zod';

export type Role = 'ADMIN' | 'HR_MANAGER' | 'MANAGER' | 'EMPLOYEE';

export const ALL_ROLES: Role[] = ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'];

export type ToolKind = 'read' | 'write' | 'destructive';

/** Principal shape returned by JwtStrategy.validate (src/auth/strategies/jwt.strategy.ts). */
export interface HrmPrincipal {
  id: string;
  email: string;
  role: Role;
  employeeId: string | null;
  departmentId: string | null;
  homeBranchId: string | null;
  accessibleBranchIds: string[] | 'ALL';
  isGlobalBranchAccess: boolean;
  isActive?: boolean;
}

export interface McpToolDef {
  /** snake_case, domain-prefixed, unique: e.g. 'leave_request_approve'. */
  name: string;
  /** One line, verb-first; mention units/date formats the args expect. */
  description: string;
  kind: ToolKind;
  /** ANY-match against user.role — same semantics as RolesGuard. */
  roles: Role[];
  /** zod raw shape; the executor injects a `confirm` param for write/destructive tools. */
  inputSchema: ZodRawShape;
  /** Force args[param] = user.employeeId when user.role is in forRoles (self-scoping). */
  selfScope?: { param: string; forRoles: Role[] };
  /** Optional richer preview for the confirm gate; default echoes the arguments. */
  preview?: (args: any, user: HrmPrincipal) => Promise<unknown>;
  execute: (args: any, user: HrmPrincipal) => Promise<unknown>;
  /** Matches the existing audit vocabulary, e.g. 'LeaveRequest'. */
  auditResourceType: string;
  /** Arg name carrying the target entity id, e.g. 'id'. */
  resourceIdArg?: string;
}

export interface DomainToolProvider {
  getTools(): McpToolDef[];
}

export const MCP_TOOL_PROVIDERS = Symbol('MCP_TOOL_PROVIDERS');

export type ToolOutcome = 'SUCCESS' | 'PREVIEW' | 'DENIED' | 'ERROR';

export interface ToolTextResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}
