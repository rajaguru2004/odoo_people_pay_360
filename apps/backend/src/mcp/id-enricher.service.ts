import { Injectable, Logger } from '@nestjs/common';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { PrismaService } from '../prisma/prisma.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Foreign-key field -> the sibling display fields we inject next to it. */
const EMPLOYEE_KEYS = new Set(['employeeId', 'managerId']);
const DEPARTMENT_KEYS = new Set(['departmentId', 'parentId']);
const BRANCH_KEYS = new Set(['branchId', 'homeBranchId']);

const MAX_IDS_PER_KIND = 200;
const MAX_DEPTH = 8;

/**
 * Makes MCP tool results human-readable: walks a result payload, collects the
 * foreign-key UUIDs (employee/department/branch), batch-resolves them
 * to names, and injects sibling display fields (`employeeName`,
 * `employeeCode`, `departmentName`, …) wherever the object doesn't already
 * carry them. The copilot (and any MCP client) then talks about
 * "Aarav Sharma (SMP-EMP-001), Engineering" instead of a raw UUID.
 *
 * Lookups run with the branch bypass — they only resolve display names for ids
 * the (already branch-scoped) tool chose to return.
 */
@Injectable()
export class IdEnricherService {
  private readonly logger = new Logger(IdEnricherService.name);

  async enrich(payload: unknown): Promise<unknown> {
    try {
      const ids = { employee: new Set<string>(), department: new Set<string>(), branch: new Set<string>() };
      collect(payload, ids, 0);

      if (!ids.employee.size && !ids.department.size && !ids.branch.size) {
        return payload;
      }

      const [employees, departments, branches] = await runWithBranchBypass(() =>
        Promise.all<any[]>([
          ids.employee.size
            ? this.prisma.employee.findMany({
                where: { id: { in: [...ids.employee].slice(0, MAX_IDS_PER_KIND) } },
                select: {
                  id: true,
                  fullName: true,
                  employeeCode: true,
                  position: true,
                  department: { select: { name: true } },
                },
              })
            : [],
          ids.department.size
            ? this.prisma.department.findMany({
                where: { id: { in: [...ids.department].slice(0, MAX_IDS_PER_KIND) } },
                select: { id: true, name: true },
              })
            : [],
          ids.branch.size
            ? this.prisma.branch.findMany({
                where: { id: { in: [...ids.branch].slice(0, MAX_IDS_PER_KIND) } },
                select: { id: true, name: true },
              })
            : [],
        ]),
      );

      const maps = {
        employee: new Map<string, any>(employees.map((e: any) => [e.id, e])),
        department: new Map<string, string>(departments.map((d: any) => [d.id, d.name])),
        branch: new Map<string, string>(branches.map((b: any) => [b.id, b.name])),
      };

      inject(payload, maps, 0);
      return payload;
    } catch (e) {
      // Enrichment is best-effort — never fail a tool call over display names.
      this.logger.warn(`id enrichment skipped: ${(e as Error).message}`);
      return payload;
    }
  }

  constructor(private readonly prisma: PrismaService) {}
}

function collect(
  node: unknown,
  out: { employee: Set<string>; department: Set<string>; branch: Set<string> },
  depth: number,
): void {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && UUID_RE.test(value)) {
      if (EMPLOYEE_KEYS.has(key)) out.employee.add(value);
      else if (DEPARTMENT_KEYS.has(key)) out.department.add(value);
      else if (BRANCH_KEYS.has(key)) out.branch.add(value);
    } else if (value && typeof value === 'object') {
      collect(value, out, depth + 1);
    }
  }
}

function inject(
  node: unknown,
  maps: {
    employee: Map<string, { fullName: string; employeeCode: string; position: string | null; department: { name: string } | null }>;
    department: Map<string, string>;
    branch: Map<string, string>;
  },
  depth: number,
): void {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) inject(item, maps, depth + 1);
    return;
  }
  const obj = node as Record<string, any>;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && UUID_RE.test(value)) {
      const base = key.endsWith('Id') ? key.slice(0, -2) : key;
      if (EMPLOYEE_KEYS.has(key)) {
        const emp = maps.employee.get(value);
        if (emp) {
          if (obj[`${base}Name`] === undefined) obj[`${base}Name`] = emp.fullName;
          if (obj[`${base}Code`] === undefined) obj[`${base}Code`] = emp.employeeCode;
          if (key === 'employeeId' && obj.departmentName === undefined && emp.department?.name) {
            obj.departmentName = emp.department.name;
          }
        }
      } else if (DEPARTMENT_KEYS.has(key)) {
        const name = maps.department.get(value);
        if (name && obj[`${base}Name`] === undefined) obj[`${base}Name`] = name;
      } else if (BRANCH_KEYS.has(key)) {
        const name = maps.branch.get(value);
        if (name && obj[`${base}Name`] === undefined) obj[`${base}Name`] = name;
      }
    } else if (value && typeof value === 'object') {
      inject(value, maps, depth + 1);
    }
  }
}
