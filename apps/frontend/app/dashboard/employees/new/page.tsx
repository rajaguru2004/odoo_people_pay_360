'use client';

import React from 'react';
import EmployeeOnboardingStepper from '@/components/employees/EmployeeOnboardingStepper';
import ProtectedRoute from '@/components/auth/ProtectedRoute';

export default function NewEmployeePage() {
  return (
    <ProtectedRoute requiredPermission="CREATE_EMPLOYEE">
      <EmployeeOnboardingStepper />
    </ProtectedRoute>
  );
}
