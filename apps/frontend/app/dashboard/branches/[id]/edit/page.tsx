'use client';

import { use } from 'react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import BranchForm from '@/components/branches/BranchForm';

export default function EditBranchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <BranchForm mode="edit" branchId={id} />
    </ProtectedRoute>
  );
}
