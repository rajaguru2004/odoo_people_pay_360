'use client';

import { LayoutGrid, List } from 'lucide-react';
import { ViewSwitcher } from '@/components/common/ViewSwitcher';

export type BranchViewType = 'cards' | 'table';

const OPTIONS = [
  { id: 'cards' as const, label: 'Cards', icon: LayoutGrid },
  { id: 'table' as const, label: 'Table', icon: List },
];

export default function BranchViewSwitcher({
  view,
  onChange,
}: {
  view: BranchViewType;
  onChange: (view: BranchViewType) => void;
}) {
  return (
    <ViewSwitcher
      options={OPTIONS}
      value={view}
      onChange={onChange}
      label="Branch view"
      testIdPrefix="branch-view"
    />
  );
}
