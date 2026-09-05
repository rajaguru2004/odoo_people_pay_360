import { Department } from '@/types/department';

export interface DepartmentOption {
  value: string;
  label: string;
}

/**
 * Every department an employee can be filed under, parents and sub-departments
 * alike, each under its own name.
 *
 * This list used to be filtered down to top-level rows, to match a service rule
 * that refused any department with a parent as a "team". That rule is gone —
 * team membership is the `Team`/`TeamMember` model, and a child Department is a
 * sub-department that carries its own manager and headcount. Filtering here hid
 * most of the org: a tenant with six sub-departments under Human Resources saw
 * five of eleven departments and no explanation for the missing ones.
 *
 * Labels are the department's own name — a sub-department is not prefixed with
 * its parent. Ordering still follows the org chart (each child directly after
 * its parent, parents in server order by code) so related rows sit together
 * without the select spelling the hierarchy out.
 */
export function departmentPickerOptions(
  departments: Department[],
): DepartmentOption[] {
  const roots = departments.filter((d) => !d.parentId);
  const ordered: Department[] = [];
  for (const root of roots) {
    ordered.push(root);
    ordered.push(...departments.filter((d) => d.parentId === root.id));
  }
  // Anything whose parent is missing from this list — filtered out by branch
  // scope, say — would otherwise vanish from the picker entirely.
  const placed = new Set(ordered.map((d) => d.id));
  ordered.push(...departments.filter((d) => !placed.has(d.id)));

  return ordered.map((d) => ({ value: d.id, label: d.name }));
}
