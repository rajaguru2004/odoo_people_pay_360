import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '@/test/utils';
import DepartmentTreeNode from './DepartmentTreeNode';
import type { DepartmentNode } from '@/types/department';

function node(
  code: string,
  name: string,
  employees: number,
  children: DepartmentNode[] = [],
): DepartmentNode {
  return {
    id: code.toLowerCase(),
    code,
    name,
    managerId: null,
    manager: null,
    branch: null,
    employees,
    teams: 0,
    children,
  };
}

/** The seeded shape: Maintenance sits two levels down, under Operations. */
const EXEC = node('EXEC', 'Executive', 1, [
  node('OPS', 'Operations', 4, [node('MAINT', 'Maintenance', 3)]),
  node('HR', 'Human Resources', 3),
]);

describe('DepartmentTreeNode', () => {
  it('carries its depth, so a flat render is distinguishable from a tree', () => {
    renderWithProviders(<DepartmentTreeNode node={EXEC} />);

    expect(screen.getByTestId('tree-node-EXEC')).toHaveAttribute('data-tree-level', '0');
    expect(screen.getByTestId('tree-node-OPS')).toHaveAttribute('data-tree-level', '1');
    expect(screen.getByTestId('tree-node-MAINT')).toHaveAttribute('data-tree-level', '2');
  });

  it('indents each level rather than stacking every node at the same inset', () => {
    renderWithProviders(<DepartmentTreeNode node={EXEC} />);

    // A logical inset, so the chart flips with dir="rtl" instead of needing a
    // second stylesheet.
    expect(screen.getByTestId('tree-node-EXEC').style.marginInlineStart).toBe('0px');
    expect(screen.getByTestId('tree-node-OPS').style.marginInlineStart).toBe('32px');
    expect(screen.getByTestId('tree-node-MAINT').style.marginInlineStart).toBe('64px');
  });

  it('opens the first two levels without a click', () => {
    renderWithProviders(<DepartmentTreeNode node={EXEC} />);

    expect(screen.getByTestId('tree-node-MAINT')).toBeInTheDocument();
  });

  it('collapses a node and takes its subtree with it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DepartmentTreeNode node={EXEC} />);

    await user.click(screen.getByRole('button', { name: 'Collapse Operations' }));
    expect(screen.queryByTestId('tree-node-MAINT')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand Operations' }));
    expect(screen.getByTestId('tree-node-MAINT')).toBeInTheDocument();
  });

  it('reports each unit its own headcount, not the subtree total', () => {
    renderWithProviders(<DepartmentTreeNode node={EXEC} />);

    // Executive holds one person even though eleven sit below it: a rolled-up
    // figure here would misread as the department being large.
    expect(screen.getByTestId('tree-node-EXEC')).toHaveTextContent('1 person');
    expect(screen.getByTestId('tree-node-OPS')).toHaveTextContent('4 people');
    expect(screen.getByTestId('tree-node-MAINT')).toHaveTextContent('3 people');
  });

  it('says so when a unit has nobody in charge of it', () => {
    renderWithProviders(<DepartmentTreeNode node={node('ADMIN', 'Administration', 2)} />);

    expect(screen.getByTestId('tree-node-ADMIN')).toHaveTextContent('Head: nobody');
  });
});
