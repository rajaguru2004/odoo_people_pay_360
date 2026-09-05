'use client';

import { LayoutGrid, List } from 'lucide-react';
import { ViewSwitcher } from '@/components/common/ViewSwitcher';

export type ContractViewType = 'table' | 'cards';

const OPTIONS = [
  { id: 'table' as const, label: 'Table', icon: List },
  { id: 'cards' as const, label: 'Cards', icon: LayoutGrid },
];

export default function ContractViewSwitcher({
  view,
  onChange,
}: {
  view: ContractViewType;
  onChange: (view: ContractViewType) => void;
}) {
  return (
    <ViewSwitcher
      options={OPTIONS}
      value={view}
      onChange={onChange}
      label="Contract view"
      testIdPrefix="contract-view"
    />
  );
}
