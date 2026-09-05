'use client';

import { useEffect, useState, useCallback } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import { useRouter, useParams } from 'next/navigation';
import { ArrowLeft, Users, UserPlus, Trash2, Mail, Calendar, Percent } from 'lucide-react';
import teamService from '@/services/teamService';
import employeeService from '@/services/employeeService';
import { Team, AddTeamMemberData } from '@/types/team';
import { Employee } from '@/types/employee';

export default function TeamDetailPage() {
  const router = useRouter();
  const params = useParams();
  const teamId = params.id as string;

  const [team, setTeam] = useState<Team | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddMember, setShowAddMember] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [memberRole, setMemberRole] = useState<'LEAD' | 'SENIOR' | 'MEMBER' | 'CONTRIBUTOR'>('MEMBER');
  const [allocation, setAllocation] = useState(100);

  useEffect(() => {
    fetchTeamDetails();
  }, [teamId]);

  const fetchTeamDetails = useCallback(async () => {
    try {
      setLoading(true);
      const [teamRes, employeesRes] = await Promise.all([
        teamService.getById(teamId),
        employeeService.getAll()
      ]);
      setTeam(teamRes.data);
      setEmployees(employeesRes.data);
    } catch (error) {
      console.error('Failed to fetch team details:', error);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  const handleAddMember = async () => {
    if (!selectedEmployee) return;

    try {
      const data: AddTeamMemberData = {
        employeeId: selectedEmployee,
        role: memberRole,
        allocationPercentage: allocation,
        startDate: new Date().toISOString().split('T')[0]
      };

      await teamService.addMember(teamId, data);
      setShowAddMember(false);
      setSelectedEmployee('');
      setMemberRole('MEMBER');
      setAllocation(100);
      fetchTeamDetails();
    } catch (error) {
      console.error('Failed to add member:', error);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!confirm('Are you sure you want to remove this member from the team?')) return;

    try {
      await teamService.removeMember(teamId, memberId);
      fetchTeamDetails();
    } catch (error) {
      console.error('Failed to remove member:', error);
    }
  };

  const getRoleBadge = (role: string) => {
    const styles = {
      LEAD: 'bg-brand-accent/10 text-brand-accent border-brand-accent/20',
      SENIOR: 'bg-brand-primary-light/10 text-brand-primary border-brand-primary/20',
      MEMBER: 'bg-status-success-bg/40 text-status-success border-status-success/20',
      CONTRIBUTOR: 'bg-surface-page text-text-muted border-surface-border'
    };
    return styles[role as keyof typeof styles] || 'bg-surface-page text-text-muted border-surface-border';
  };

  const getRoleLabel = (role: string) => {
    const labels = {
      LEAD: 'Lead',
      SENIOR: 'Senior',
      MEMBER: 'Member',
      CONTRIBUTOR: 'Contributor'
    };
    return labels[role as keyof typeof labels] || role;
  };

  const getTypeLabel = (type: string) => {
    const labels = {
      PERMANENT: 'Permanent',
      PROJECT: 'Project',
      CROSS_FUNCTIONAL: 'Inter-department'
    };
    return labels[type as keyof typeof labels] || type;
  };

  const availableEmployees = employees.filter(emp => 
    emp.departmentId === team?.departmentId &&
    !team?.members?.some(m => m.employeeId === emp.id)
  );

  if (loading) {
    return (
      <>
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-surface-border-light rounded-[--radius-button] w-1/3"></div>
          <div className="h-64 bg-surface-border-light rounded-[--radius-card]"></div>
        </div>
      </>
    );
  }

  if (!team) {
    return (
      <>
        <div className="text-center py-12">
          <p className="text-text-muted">Team does not exist</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.back()}
              className="p-2 hover:bg-surface-page rounded-[--radius-button] transition-colors"
            >
              <ArrowLeft size={20} />
            </button>
            <div>
              <h1 data-testid="team-detail-name" className="text-3xl font-bold text-text-heading">{team.name}</h1>
              <p data-testid="team-detail-code" className="text-sm text-text-muted mt-1">{team.code}</p>
            </div>
          </div>
          <button
            data-testid="team-member-add"
            onClick={() => setShowAddMember(true)}
            className="flex items-center gap-2 px-4 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors"
          >
            <UserPlus size={18} />
            Add members
          </button>
        </div>

        {/* Team Info */}
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
          <h2 className="text-lg font-bold text-text-heading mb-4">Team information</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-text-muted mb-1">Departments</p>
              <p className="font-semibold text-text-heading">{team.department?.name || 'N/A'}</p>
            </div>
            <div>
              <p className="text-sm text-text-muted mb-1">Team type</p>
              <p className="font-semibold text-text-heading">{getTypeLabel(team.type)}</p>
            </div>
            <div>
              <p className="text-sm text-text-muted mb-1">Team Lead</p>
              <p className="font-semibold text-text-heading">{team.teamLead?.fullName || 'Not yet'}</p>
            </div>
            <div>
              <p className="text-sm text-text-muted mb-1">Number of members</p>
              <p className="font-semibold text-brand-primary">{team.members?.length || 0} People</p>
            </div>
          </div>
          {team.description && (
            <div className="mt-4 pt-4 border-t border-surface-border">
              <p className="text-sm text-text-muted mb-1">Describe</p>
              <p className="text-text-body">{team.description}</p>
            </div>
          )}
        </div>

        {/* Members List */}
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden">
          <div className="p-6 border-b border-surface-border">
            <h2 className="text-lg font-bold text-text-heading">Member ({team.members?.length || 0})</h2>
          </div>
          <div className="divide-y divide-surface-border">
            {team.members && team.members.length > 0 ? (
              team.members.map(member => (
                <div key={member.id} className="p-6 hover:bg-surface-page/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-full bg-brand-primary text-text-on-brand flex items-center justify-center font-bold">
                        {member.employee?.fullName.substring(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <h3 className="font-semibold text-text-heading">{member.employee?.fullName}</h3>
                        <p className="text-sm text-text-muted">{member.employee?.position}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <Mail size={14} className="text-text-muted opacity-80" />
                          <span className="text-sm text-text-body">{member.employee?.email}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <span className={`inline-block px-3 py-1 rounded-[--radius-badge] text-xs font-semibold border-2 ${getRoleBadge(member.role)}`}>
                          {getRoleLabel(member.role)}
                        </span>
                        <div className="flex items-center gap-2 mt-2 text-sm text-text-body">
                          <Percent size={14} />
                          <span>{member.allocationPercentage}% allocation</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-sm text-text-muted">
                          <Calendar size={14} />
                          <span>From {new Date(member.startDate).toLocaleDateString('en-IN', { timeZone: getCompanyTz() })}</span>
                        </div>
                      </div>
                      <button
                        data-testid={`team-member-remove-${member.employee?.employeeCode ?? member.id}`}
                        onClick={() => handleRemoveMember(member.id)}
                        className="p-2 text-status-error hover:bg-status-error-bg/40 rounded-[--radius-button] transition-colors"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="p-12 text-center">
                <Users size={48} className="mx-auto text-text-muted opacity-60 mb-3" />
                <p className="text-text-muted">There are no members yet</p>
              </div>
            )}
          </div>
        </div>

        {/* Add Member Modal */}
        {showAddMember && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50">
            <div className="bg-surface-card border border-surface-border rounded-[--radius-card] p-6 w-full max-w-md">
              <h3 className="text-lg font-bold text-text-heading mb-4">Add members</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Employee
                  </label>
                  <select
                    value={selectedEmployee}
                    onChange={(e) => setSelectedEmployee(e.target.value)}
                    className="w-full px-3 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary bg-surface-card text-text-body"
                  >
                    <option value="">Select employee</option>
                    {availableEmployees.map(emp => (
                      <option key={emp.id} value={emp.id}>
                        {emp.fullName} - {emp.position}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Role
                  </label>
                  <select
                    value={memberRole}
                    onChange={(e) => setMemberRole(e.target.value as any)}
                    className="w-full px-3 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary bg-surface-card text-text-body"
                  >
                    <option value="MEMBER">Member</option>
                    <option value="SENIOR">Senior</option>
                    <option value="LEAD">Lead</option>
                    <option value="CONTRIBUTOR">Contributor</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-body mb-2">
                    Allocation (%)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={allocation}
                    onChange={(e) => setAllocation(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary bg-surface-card text-text-body"
                  />
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => setShowAddMember(false)}
                  className="flex-1 px-4 py-2 border border-surface-border rounded-[--radius-button] hover:bg-surface-page transition-colors text-text-body"
                >
                  Cancel
                </button>
                <button
                  data-testid="team-member-add-submit"
                  onClick={handleAddMember}
                  disabled={!selectedEmployee}
                  className="flex-1 px-4 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  More
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
