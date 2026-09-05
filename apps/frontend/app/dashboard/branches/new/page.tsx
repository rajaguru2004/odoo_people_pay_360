'use client';

import BranchForm from '@/components/branches/BranchForm';
import ProtectedRoute from '@/components/auth/ProtectedRoute';

export default function NewBranchPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <BranchForm mode="create" />
    </ProtectedRoute>
  );
}
