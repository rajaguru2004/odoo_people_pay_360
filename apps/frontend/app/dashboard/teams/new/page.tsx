'use client';

import ProtectedRoute from '@/components/auth/ProtectedRoute';
import TeamForm from '@/components/teams/TeamForm';
import { usePageHeader } from '@/hooks/usePageHeader';

function NewTeam() {
  usePageHeader('New team', 'Group people around a piece of work.');
  return <TeamForm />;
}

export default function NewTeamPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <NewTeam />
    </ProtectedRoute>
  );
}
