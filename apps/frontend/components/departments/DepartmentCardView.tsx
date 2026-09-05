'use client';

import DepartmentCard from './DepartmentCard';
import type { Department } from '@/types/department';

/** The card grid. Its own component so the page picks a view, not a layout. */
export default function DepartmentCardView({ departments }: { departments: Department[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {departments.map((department) => (
        <DepartmentCard key={department.id} department={department} />
      ))}
    </div>
  );
}
