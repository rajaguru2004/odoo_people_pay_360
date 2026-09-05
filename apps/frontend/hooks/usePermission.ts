import { useAuthStore } from '@/store/authStore';
import { hasPermission, hasAnyPermission, hasAllPermissions, PERMISSIONS } from '@/utils/permissions';
import { UserRole } from '@/types/auth';

export const usePermission = () => {
    const { user } = useAuthStore();

    const can = (permission: keyof typeof PERMISSIONS) => {
        if (!user) return false;
        return hasPermission(user.role, permission);
    };

    const canAny = (permissions: Array<keyof typeof PERMISSIONS>) => {
        if (!user) return false;
        return hasAnyPermission(user.role, permissions);
    };

    const canAll = (permissions: Array<keyof typeof PERMISSIONS>) => {
        if (!user) return false;
        return hasAllPermissions(user.role, permissions);
    };

    const isRole = (role: UserRole) => {
        return user?.role === role;
    };

    const isAdmin = () => {
        return user?.role === 'ADMIN';
    };

    const isHRManager = () => {
        return user?.role === 'HR_MANAGER';
    };

    const isManager = () => {
        return user?.role === 'MANAGER';
    };

    const isEmployee = () => {
        return user?.role === 'EMPLOYEE';
    };

    // Multi-branch: only ADMIN / HR_MANAGER may switch the active branch from
    // the top bar. Everyone else is pinned to their own branch server-side.
    const canSwitchBranch = () => {
        return user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';
    };

    return {
        can,
        canAny,
        canAll,
        isRole,
        isAdmin,
        isHRManager,
        isManager,
        isEmployee,
        canSwitchBranch,
        user
    };
};
