import { describe, expect, it } from 'vitest';
import { departmentPickerOptions } from './departmentOptions';
import { Department } from '@/types/department';

/**
 * The regression these pin: the picker was filtered to top-level departments to
 * match a service rule that refused a parented department as a "team". A tenant
 * with six sub-departments under Human Resources then saw five of its eleven,
 * with no hint the rest existed. Sub-departments hold staff — they belong here.
 */

const dept = (over: Partial<Department> & { id: string; name: string }): Department =>
  ({
    code: over.id.toUpperCase(),
    isActive: true,
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as Department;

const HR = dept({ id: 'd-hr', name: 'Human Resources' });
const QA = dept({ id: 'd-qa', name: 'QA TESTING' });
const APPDEV = dept({
  id: 'd-app',
  name: 'Application Development',
  parentId: 'd-hr',
  parent: { id: 'd-hr', code: 'D-HR', name: 'Human Resources' },
});
const FSD = dept({
  id: 'd-fsd',
  name: 'Full Stack Development',
  parentId: 'd-hr',
  parent: { id: 'd-hr', code: 'D-HR', name: 'Human Resources' },
});

describe('departmentPickerOptions', () => {
  it('offers sub-departments, not just top-level ones', () => {
    const values = departmentPickerOptions([HR, QA, APPDEV, FSD]).map((o) => o.value);

    expect(values).toEqual(expect.arrayContaining(['d-hr', 'd-qa', 'd-app', 'd-fsd']));
    expect(values).toHaveLength(4);
  });

  it('labels a sub-department with its own name, not its parent path', () => {
    const options = departmentPickerOptions([HR, APPDEV]);

    expect(options).toContainEqual({
      value: 'd-app',
      label: 'Application Development',
    });
    expect(options).toContainEqual({ value: 'd-hr', label: 'Human Resources' });
  });

  it('lists each child directly under its parent', () => {
    // Server order is by code, which interleaves parents and children. Grouping
    // is what makes eleven rows readable in a flat select.
    const options = departmentPickerOptions([APPDEV, QA, FSD, HR]);

    expect(options.map((o) => o.value)).toEqual(['d-qa', 'd-hr', 'd-app', 'd-fsd']);
  });

  it('does not need the parent relation to be included', () => {
    const bare = dept({ id: 'd-app', name: 'Application Development', parentId: 'd-hr' });

    expect(departmentPickerOptions([HR, bare])).toContainEqual({
      value: 'd-app',
      label: 'Application Development',
    });
  });

  it('still offers a child whose parent is not in the list', () => {
    // Branch scoping can return a child without its parent. Dropping it would
    // hide a department the caller is entitled to use.
    const orphan = dept({ id: 'd-x', name: 'Offshore QA', parentId: 'd-missing' });

    expect(departmentPickerOptions([QA, orphan])).toContainEqual({
      value: 'd-x',
      label: 'Offshore QA',
    });
  });
});
