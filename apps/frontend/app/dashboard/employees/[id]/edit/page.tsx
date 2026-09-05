'use client';

import { use } from 'react';
import EmployeeForm from '@/components/employees/EmployeeForm';
import ProtectedRoute from '@/components/auth/ProtectedRoute';

export default function EditEmployeePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    return (
        <ProtectedRoute requiredPermission="EDIT_EMPLOYEE">
            <EmployeeForm mode="edit" employeeId={id} />
        </ProtectedRoute>
    );
}
