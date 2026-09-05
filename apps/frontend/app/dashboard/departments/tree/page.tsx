'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Building2, Users, ChevronDown, Eye, Edit, UserCircle } from 'lucide-react';
import { ChevronRightIcon } from '@/components/common/icons/directional';
import { motion, AnimatePresence } from 'framer-motion';
import departmentService from '@/services/departmentService';
import teamService from '@/services/teamService';
import { Department } from '@/types/department';
import { Team } from '@/types/team';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';

interface TreeNodeProps {
  department: Department;
  level: number;
  allTeams: Team[];
}

function TreeNode({ department, level, allTeams }: TreeNodeProps) {
  const router = useRouter();
  const t = useTranslations('departmentsTreePage');
  const [isExpanded, setIsExpanded] = useState(level < 2); // Auto-expand first 2 levels
  const hasChildren = department.children && department.children.length > 0;
  const hasTeams = department._count?.teams ? department._count.teams > 0 : false;
  const hasExpandable = hasChildren || hasTeams;
  
  // Filter teams for this department from preloaded data
  const departmentTeams = allTeams.filter(team => team.departmentId === department.id);

  const handleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  return (
    <div className="relative">
      {/* Department Node */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: level * 0.1 }}
        className="group"
        style={{ marginLeft: `${level * 40}px` }}
      >
        <div data-testid={`tree-node-${department.code}`} data-tree-level={level} className="flex items-center gap-3 p-4 bg-surface-card border border-surface-border rounded-[--radius-card] hover:border-brand-primary hover:shadow-md transition-all mb-3">
          {/* Expand/Collapse Button for Children or Teams */}
          {hasExpandable ? (
            <button
              data-testid="tree-node-expand"
              onClick={handleExpand}
              className="w-8 h-8 rounded-[--radius-button] bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand hover:shadow-lg transition-all flex items-center justify-center flex-shrink-0 cursor-pointer"
            >
              {isExpanded ? <ChevronDown size={18} /> : <ChevronRightIcon size={18} />}
            </button>
          ) : (
            <div className="w-8 h-8 rounded-[--radius-button] bg-slate-100 flex items-center justify-center flex-shrink-0" /* neutral */>
              <div className="w-2 h-2 rounded-full bg-slate-400"></div> {/* neutral */}
            </div>
          )}

          {/* Department Icon */}
          <div className={`w-12 h-12 rounded-[--radius-card] flex items-center justify-center ${
            level === 0 
              ? 'bg-gradient-to-br from-brand-primary to-brand-primary-light' 
              : level === 1
              ? 'bg-gradient-to-br from-brand-accent to-brand-accent-dark'
              : 'bg-gradient-to-br from-brand-primary-light/50 to-brand-primary'
          }`}>
            <Building2 className="text-text-on-brand" size={24} />
          </div>

          {/* Department Info */}
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-brand-primary">{department.name}</h3>
              <span className="px-2 py-1 bg-slate-100 text-slate-600 text-xs rounded-[--radius-badge]" /* neutral */>
                {department.code}
              </span>
            </div>
            <div className="flex items-center gap-4 mt-1">
              <div className="flex items-center gap-1 text-sm text-text-muted">
                <Users size={14} />
                <span>{t('employeesCount', { count: department._count?.employees || 0 })}</span>
              </div>
              {hasTeams && department._count?.teams && (
                <div className="flex items-center gap-1 text-sm text-text-muted">
                  <UserCircle size={14} />
                  <span>{t('teamCount', { count: department._count.teams })}</span>
                </div>
              )}
              {department.manager && (
                <div className="text-sm text-text-muted">
                  {t('deptHeadLabel')}<span className="font-medium text-brand-primary">{department.manager.fullName}</span>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => router.push(`/dashboard/departments/${department.id}`)}
              className="p-2 bg-brand-primary-light/20 text-brand-primary rounded-[--radius-button] hover:bg-brand-primary-light/40 transition-colors cursor-pointer"
              title={t('viewDetailsTitle')}
            >
              <Eye size={16} />
            </button>
            <button
              onClick={() => router.push(`/dashboard/departments/${department.id}/edit`)}
              className="p-2 bg-status-warning-bg/30 text-status-warning rounded-[--radius-button] hover:bg-status-warning-bg/50 transition-colors cursor-pointer"
              title={t('editTitle')}
            >
              <Edit size={16} />
            </button>
          </div>
        </div>
      </motion.div>

      {/* Teams */}
      <AnimatePresence>
        {isExpanded && departmentTeams.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            style={{ marginLeft: `${(level + 1) * 40}px` }}
            className="space-y-2 mb-3"
          >
            {departmentTeams.map((team) => (
              <motion.div
                key={team.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-center gap-3 p-3 bg-brand-accent/5 border border-brand-accent/20 rounded-[--radius-card] hover:border-brand-accent/40 hover:shadow-sm transition-all"
              >
                {/* Team Icon */}
                <div className="w-10 h-10 rounded-[--radius-card] bg-gradient-to-br from-brand-accent to-brand-accent-dark flex items-center justify-center flex-shrink-0">
                  <UserCircle className="text-text-on-accent" size={20} />
                </div>

                {/* Team Info */}
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold text-text-heading">{team.name}</h4>
                    <span className="px-2 py-0.5 bg-brand-accent/15 text-brand-accent text-xs rounded-[--radius-badge]">
                      {team.code}
                    </span>
                    <span className={`px-2 py-0.5 text-xs rounded-[--radius-badge] ${
                      team.type === 'PERMANENT' 
                        ? 'bg-status-success-bg text-status-success'
                        : team.type === 'PROJECT'
                        ? 'bg-brand-primary-light/20 text-brand-primary'
                        : 'bg-brand-accent/15 text-brand-accent'
                    }`}>
                      {team.type === 'PERMANENT' ? t('typePermanent') : team.type === 'PROJECT' ? t('typeProject') : t('typeCrossFunctional')}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <div className="flex items-center gap-1 text-sm text-brand-accent">
                      <Users size={12} />
                      <span>{t('membersCount', { count: team._count?.members || 0 })}</span>
                    </div>
                    {team.teamLead && (
                      <div className="text-sm text-text-muted">
                        {t('teamLeadLabel')}<span className="font-medium text-text-body">{team.teamLead.fullName}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Team Actions */}
                <button
                  onClick={() => router.push(`/dashboard/teams/${team.id}`)}
                  className="p-2 bg-brand-accent/10 text-brand-accent rounded-[--radius-button] hover:bg-brand-accent/20 transition-colors cursor-pointer"
                  title={t('viewTeamDetailsTitle')}
                >
                  <Eye size={14} />
                </button>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Children Departments */}
      <AnimatePresence>
        {isExpanded && hasChildren && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
          >
            {department.children!.map((child) => (
              <TreeNode key={child.id} department={child} level={level + 1} allTeams={allTeams} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function OrganizationTreePage() {
  const router = useRouter();
  const t = useTranslations('departmentsTreePage');
  const tc = useTranslations('common');
  const [tree, setTree] = useState<Department[]>([]);
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      // Load both tree and all teams in parallel
      const [treeResponse, teamsResponse] = await Promise.all([
        departmentService.getOrganizationTree(),
        teamService.getAll()
      ]);
      setTree(treeResponse.data);
      setAllTeams(teamsResponse.data || []);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const countTotalDepartments = (depts: Department[]): number => {
    return depts.reduce((total, dept) => {
      return total + 1 + (dept.children ? countTotalDepartments(dept.children) : 0);
    }, 0);
  };

  const countTotalEmployees = (depts: Department[]): number => {
    return depts.reduce((total, dept) => {
      return total + (dept._count?.employees || 0) + (dept.children ? countTotalEmployees(dept.children) : 0);
    }, 0);
  };

  // The one heading for this route, rendered by TopHeader. Declared above the
  // loading early-return so the hook order never changes between renders.
  usePageHeader(
    t('title'),
    t('subtitle', { depts: countTotalDepartments(tree), employees: countTotalEmployees(tree) }),
  );

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 bg-slate-200 rounded w-64">{/* neutral */}</div>
        <div className="space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-20 bg-slate-100 rounded-xl" style={{ marginLeft: `${i * 40}px` }}>{/* neutral */}</div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Heading lives in TopHeader via usePageHeader — only the actions stay here. */}
      <PageActionRow
        action={
          <>
            <button
              onClick={() => router.push('/dashboard/departments')}
              className="px-4 py-2 border border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-page transition-colors cursor-pointer"
            >
              {t('gridView')}
            </button>
            <button
              onClick={() => router.push('/dashboard/departments/new')}
              className="px-4 py-2 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand rounded-[--radius-button] hover:shadow-lg transition-all cursor-pointer"
            >
              {t('addDepartments')}
            </button>
          </>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-[--radius-card] bg-brand-primary-light/20 flex items-center justify-center">
              <Building2 className="text-brand-primary" size={24} />
            </div>
            <div>
              <p className="text-sm text-text-muted">{t('generalDepartment')}</p>
              <p className="text-2xl font-bold text-text-heading">{countTotalDepartments(tree)}</p>
            </div>
          </div>
        </div>

        <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-[--radius-card] bg-status-success-bg flex items-center justify-center">
              <Users className="text-status-success" size={24} />
            </div>
            <div>
              <p className="text-sm text-text-muted">{t('generalStaff')}</p>
              <p className="text-2xl font-bold text-text-heading">{countTotalEmployees(tree)}</p>
            </div>
          </div>
        </div>

        <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-[--radius-card] bg-brand-accent/10 flex items-center justify-center">
              <Building2 className="text-brand-accent" size={24} />
            </div>
            <div>
              <p className="text-sm text-text-muted">{t('highLevelDepartments')}</p>
              <p className="text-2xl font-bold text-text-heading">{tree.length}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Organization Tree */}
      <div className="bg-surface-page rounded-[--radius-card] p-6 border border-surface-border">
        {tree.length === 0 ? (
          <div className="text-center py-12">
            <Building2 className="mx-auto text-text-muted mb-4" size={64} />
            <p className="text-text-muted">{t('noDepartmentsYet')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tree.map((dept) => (
              <TreeNode key={dept.id} department={dept} level={0} allTeams={allTeams} />
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
        <h3 className="font-bold text-brand-primary mb-4">{t('noteHeading')}</h3>
        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold text-text-heading mb-2">{t('departmentsByLevel')}</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-[--radius-card] bg-gradient-to-br from-brand-primary to-brand-primary-light"></div>
                <span className="text-sm text-text-muted">{t('level1')}</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-[--radius-card] bg-gradient-to-br from-brand-accent to-brand-accent-dark"></div>
                <span className="text-sm text-text-muted">{t('level2')}</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-[--radius-card] bg-gradient-to-br from-brand-primary-light to-brand-primary"></div>
                <span className="text-sm text-text-muted">{t('level3Plus')}</span>
              </div>
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold text-text-heading mb-2">{t('teamsColon')}</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-[--radius-card] bg-gradient-to-br from-brand-accent to-brand-accent-dark flex items-center justify-center">
                  <UserCircle className="text-text-on-accent" size={20} />
                </div>
                <span className="text-sm text-text-muted">{t('teamsBelongToDepts')}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="px-2 py-1 bg-status-success-bg text-status-success text-xs rounded-[--radius-badge]">{t('permanentLegend')}</span>
                <span className="text-sm text-text-muted">{t('fixedTeam')}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="px-2 py-1 bg-brand-primary-light/20 text-brand-primary text-xs rounded-[--radius-badge]">{t('projectLegend')}</span>
                <span className="text-sm text-text-muted">{t('projectTeam')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
