'use client';

import { LayoutGrid, List } from 'lucide-react';
import { ViewSwitcher } from '@/components/common/ViewSwitcher';

export type EmployeeViewType = 'table' | 'cards';

/**
 * Table first, because the directory opens as a table and a switcher that
 * reordered its own options would move the control the reader is aiming at.
 */
const OPTIONS = [
  { id: 'table' as const, label: 'Table', icon: List },
  { id: 'cards' as const, label: 'Cards', icon: LayoutGrid },
];

export default function EmployeeViewSwitcher({
  view,
  onChange,
}: {
  view: EmployeeViewType;
  onChange: (view: EmployeeViewType) => void;
}) {
  return (
    <ViewSwitcher
      options={OPTIONS}
      value={view}
      onChange={onChange}
      label="Employee view"
      testIdPrefix="employee-view"
    />
  );
}
