'use client';

import { LayoutGrid, List } from 'lucide-react';
import { ViewSwitcher } from '@/components/common/ViewSwitcher';

export type DepartmentViewType = 'cards' | 'table';

const OPTIONS = [
  { id: 'cards' as const, label: 'Cards', icon: LayoutGrid },
  { id: 'table' as const, label: 'Table', icon: List },
];

export default function DepartmentViewSwitcher({
  view,
  onChange,
}: {
  view: DepartmentViewType;
  onChange: (view: DepartmentViewType) => void;
}) {
  return (
    <ViewSwitcher
      options={OPTIONS}
      value={view}
      onChange={onChange}
      label="Department view"
      testIdPrefix="department-view"
    />
  );
}
