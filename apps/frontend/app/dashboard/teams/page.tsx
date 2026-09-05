'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Users, Plus, Search, X } from 'lucide-react';
import teamService from '@/services/teamService';
import departmentService from '@/services/departmentService';
import { Team } from '@/types/team';
import { Department } from '@/types/department';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';

export default function TeamsPage() {
  const router = useRouter();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Manage Teams', 'Working group and task assignment');

  const [teams, setTeams] = useState<Team[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [teamsRes, deptsRes] = await Promise.all([
        teamService.getAll(),
        departmentService.getAll()
      ]);
      setTeams(teamsRes.data);
      setDepartments(deptsRes.data);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const filteredTeams = teams.filter(team => {
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      const matchesSearch = 
        team.name.toLowerCase().includes(search) ||
        team.code.toLowerCase().includes(search) ||
        team.description?.toLowerCase().includes(search);
      if (!matchesSearch) return false;
    }

    if (departmentFilter !== 'all' && team.departmentId !== departmentFilter) return false;
    if (typeFilter !== 'all' && team.type !== typeFilter) return false;

    return true;
  });

  const getTeamTypeLabel = (type: string) => {
    const labels = {
      PERMANENT: 'Permanent',
      PROJECT: 'Project',
      CROSS_FUNCTIONAL: 'Inter-department'
    };
    return labels[type as keyof typeof labels] || type;
  };

  const getTeamTypeBadge = (type: string) => {
    const styles = {
      PERMANENT: 'bg-brand-primary-light/20 text-brand-primary border-brand-primary/20',
      PROJECT: 'bg-status-info-bg text-status-info border-status-info/20',
      CROSS_FUNCTIONAL: 'bg-brand-accent/10 text-brand-accent border-brand-accent/20'
    };
    return styles[type as keyof typeof styles] || 'bg-surface-page text-text-muted border-surface-border';
  };

  const activeFilterCount = 
    (departmentFilter !== 'all' ? 1 : 0) +
    (typeFilter !== 'all' ? 1 : 0);

  const clearFilters = () => {
    setDepartmentFilter('all');
    setTypeFilter('all');
    setSearchTerm('');
  };

  return (
    <>
      <div className="space-y-4">
        {/* Heading lives in TopHeader via usePageHeader — only the action stays here. */}
        <PageActionRow
          action={
            <button
              data-testid="team-create"
              onClick={() => router.push('/dashboard/teams/new')}
              className="flex items-center gap-2 px-5 py-2.5 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark hover:shadow-2xl hover:scale-105 transition-all font-semibold shadow-lg shadow-brand-primary/20 cursor-pointer"
            >
              <Plus size={20} />
              Create Team
            </button>
          }
        />

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-brand-primary-light/10 rounded-[--radius-card] p-5 border border-brand-primary/20 hover:shadow-xl hover:scale-105 transition-all duration-300">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-3 rounded-[--radius-button] bg-brand-primary text-text-on-brand shadow-md">
                <Users size={24} />
              </div>
            </div>
            <p className="text-3xl font-bold text-text-heading">{teams.length}</p>
            <p className="text-xs text-text-muted font-semibold uppercase tracking-wide">Total Teams</p>
          </div>

          <div className="bg-brand-primary-light/10 rounded-[--radius-card] p-5 border border-brand-primary/20 hover:shadow-xl hover:scale-105 transition-all duration-300">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-3 rounded-[--radius-button] bg-brand-primary/80 text-text-on-brand shadow-md">
                <Users size={24} />
              </div>
            </div>
            <p className="text-3xl font-bold text-text-heading">
              {teams.filter(t => t.type === 'PERMANENT').length}
            </p>
            <p className="text-xs text-text-muted font-semibold uppercase tracking-wide">Permanent</p>
          </div>

          <div className="bg-status-info-bg/30 rounded-[--radius-card] p-5 border border-status-info/20 hover:shadow-xl hover:scale-105 transition-all duration-300">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-3 rounded-[--radius-button] bg-status-info text-text-on-brand shadow-md">
                <Users size={24} />
              </div>
            </div>
            <p className="text-3xl font-bold text-text-heading">
              {teams.filter(t => t.type === 'PROJECT').length}
            </p>
            <p className="text-xs text-text-muted font-semibold uppercase tracking-wide">Project</p>
          </div>

          <div className="bg-brand-accent/10 rounded-[--radius-card] p-5 border border-brand-accent/20 hover:shadow-xl hover:scale-105 transition-all duration-300">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-3 rounded-[--radius-button] bg-brand-accent text-text-on-brand shadow-md">
                <Users size={24} />
              </div>
            </div>
            <p className="text-3xl font-bold text-text-heading">
              {teams.reduce((sum, t) => sum + (t._count?.members || 0), 0)}
            </p>
            <p className="text-xs text-text-muted font-semibold uppercase tracking-wide">Total Members</p>
          </div>
        </div>

        {/* Toolbar */}
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-5 space-y-4 shadow-lg">
          {/* Search */}
          <div className="relative group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted group-focus-within:text-brand-primary transition-colors" size={20} />
            <input
              data-testid="team-search"
              type="text"
              placeholder="Search for team..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-12 pr-10 py-3 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary text-sm font-medium transition-all bg-surface-card text-text-body"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-body hover:bg-surface-page rounded-full transition-all"
              >
                <X size={16} />
              </button>
            )}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">Filters:</span>
            
            <select
              data-testid="team-filter-dept"
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className={`px-4 py-2 rounded-[--radius-button] text-sm font-medium transition-all bg-surface-card ${
                departmentFilter !== 'all'
                  ? 'bg-brand-primary-light/20 text-brand-primary border border-brand-primary/30'
                  : 'bg-surface-page text-text-body border border-surface-border'
              }`}
            >
              <option value="all">All Departments</option>
              {departments.map(dept => (
                <option key={dept.id} value={dept.id}>{dept.name}</option>
              ))}
            </select>

            <select
              data-testid="team-filter-type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className={`px-4 py-2 rounded-[--radius-button] text-sm font-medium transition-all bg-surface-card ${
                typeFilter !== 'all'
                  ? 'bg-brand-primary-light/20 text-brand-primary border border-brand-primary/30'
                  : 'bg-surface-page text-text-body border border-surface-border'
              }`}
            >
              <option value="all">All Types</option>
              <option value="PERMANENT">Permanent</option>
              <option value="PROJECT">Project</option>
              <option value="CROSS_FUNCTIONAL">Inter-department</option>
            </select>

            {activeFilterCount > 0 && (
              <button
                onClick={clearFilters}
                className="px-4 py-2 bg-status-error-bg text-status-error rounded-[--radius-button] text-sm font-medium hover:bg-status-error-bg/70 transition-colors cursor-pointer"
              >
                Clear ({activeFilterCount})
              </button>
            )}

            <div className="ml-auto text-sm text-text-muted font-medium">
              {filteredTeams.length} / {teams.length} teams
            </div>
          </div>
        </div>

        {/* Teams Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {loading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-surface-card rounded-[--radius-card] border border-surface-border p-5 animate-pulse">
                <div className="h-6 bg-surface-page rounded w-3/4 mb-3"></div>
                <div className="h-4 bg-surface-page rounded w-1/2 mb-4"></div>
                <div className="h-4 bg-surface-page rounded w-full mb-2"></div>
                <div className="h-4 bg-surface-page rounded w-2/3"></div>
              </div>
            ))
          ) : filteredTeams.length === 0 ? (
            <div data-testid="team-empty" className="col-span-full text-center py-12">
              <Users size={48} className="mx-auto text-text-muted/40 mb-3" />
              <p className="text-text-muted font-medium">No teams found</p>
            </div>
          ) : (
            filteredTeams.map(team => (
              <div
                key={team.id}
                data-testid={`team-row-${team.code}`}
                onClick={() => router.push(`/dashboard/teams/${team.id}`)}
                className="bg-surface-card rounded-[--radius-card] border border-surface-border p-5 hover:shadow-xl hover:scale-105 transition-all cursor-pointer flex flex-col h-full"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <h3 className="font-bold text-lg text-text-heading mb-1">{team.name}</h3>
                    <p className="text-sm text-text-muted font-medium">{team.code}</p>
                  </div>
                  <span className={`px-3 py-1 rounded-[--radius-button] text-xs font-semibold border ${getTeamTypeBadge(team.type)}`}>
                    {getTeamTypeLabel(team.type)}
                  </span>
                </div>

                {team.description && (
                  <p className="text-sm text-text-body mb-3 line-clamp-2">{team.description}</p>
                )}

                <div className="space-y-2 text-sm mt-auto pt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted">Department:</span>
                    <span className="font-semibold text-text-body">{team.department?.name || 'N/A'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted">Team Lead:</span>
                    <span className="font-semibold text-text-body">{team.teamLead?.fullName || 'Not yet'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted">Member:</span>
                    <span className="font-semibold text-brand-primary">{team._count?.members || 0} People</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
