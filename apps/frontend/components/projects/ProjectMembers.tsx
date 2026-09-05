'use client';

import React, { useEffect, useState } from 'react';
import { UserPlus, Trash2, Loader2, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import projectService from '@/services/projectService';
import projectRoleService from '@/services/projectRoleService';
import employeeService from '@/services/employeeService';
import { useProjectPermissions } from '@/hooks/useProjectPermissions';
import type { ProjectMember, ProjectRole } from '@/types/project';

export default function ProjectMembers({ projectId }: { projectId: string }) {
  const t = useTranslations('projectMembers');
  const tc = useTranslations('common');
  const { can } = useProjectPermissions(projectId);
  const canManage = can('MEMBER_MANAGE');
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [roles, setRoles] = useState<ProjectRole[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [selectedEmp, setSelectedEmp] = useState('');
  const [selectedRoleId, setSelectedRoleId] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [res, rolesRes, emp] = (await Promise.all([
        projectService.getMembers(projectId),
        projectRoleService.listRoles(projectId),
        employeeService.getDirectory(),
      ])) as [any, any, any];
      setMembers(res.data || []);
      const loadedRoles: ProjectRole[] = rolesRes.data || [];
      setRoles(loadedRoles);
      setEmployees(emp.data || []);
      // Default the add-role selector to the project's default role.
      if (!selectedRoleId) {
        const def = loadedRoles.find((r) => r.isDefault) ?? loadedRoles.find((r) => r.slug === 'member');
        if (def) setSelectedRoleId(def.id);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!selectedEmp || !selectedRoleId) return;
    setAdding(true);
    try {
      await projectService.addMember(projectId, [selectedEmp], selectedRoleId);
      setSelectedEmp('');
      await load();
    } finally {
      setAdding(false);
    }
  };

  const changeRole = async (memberId: string, roleId: string) => {
    // R70. `projectService.updateMemberRole(id, memberId, '')` builds `{}`,
    // which the server reads as "use the project default" — so "change this
    // member's role" becomes "reset them to Member", with a 200 back and
    // nothing said. The select can only emit '' if the role list is empty or a
    // browser restores a stale selection; either way, sending nothing is not
    // what the user asked for.
    if (!roleId) return;
    await projectService.updateMemberRole(projectId, memberId, roleId);
    await load();
  };

  /**
   * R69. The OWNER membership is not removable from here.
   *
   * `NewProjectModal` already excludes `role !== 'OWNER'` when it diffs the
   * member list, because dropping it leaves a project only a global admin can
   * edit. The same membership was removable one tab away: same row, same
   * consequence, two different rules.
   */
  const isOwnerMembership = (m: ProjectMember) =>
    String(m.role ?? '').toUpperCase() === 'OWNER' ||
    (m.projectRole?.slug ?? '').toLowerCase() === 'owner';

  /**
   * R68. Removal asks first, as `ProjectRolesManager.removeRole()` two tabs
   * over already does. `ProjectMember.employeeId` is `onDelete: Cascade`, so
   * there is no tombstone and nothing to restore from — a mis-click ends a
   * person's access to a PRIVATE project with no undo.
   */
  const remove = async (m: ProjectMember) => {
    if (isOwnerMembership(m)) return;
    const name = m.employee?.fullName ?? '';
    if (!confirm(t('removeConfirmMessage', { name }))) return;
    await projectService.removeMember(projectId, m.id);
    await load();
  };

  const memberEmpIds = new Set(members.map((m) => m.employeeId));
  const available = employees.filter((e) => !memberEmpIds.has(e.id));

  /**
   * R71. A project whose `GET /roles` comes back empty — created before the
   * presets were seeded, or a role list this caller may not read — used to
   * render the add panel anyway: an EMPTY `<select>` with no options and an Add
   * button disabled for ever, with nothing said. The user was left holding a
   * control that could not be operated and no reason why.
   *
   * There is nothing to pick, so nothing is offered. The state is named
   * instead, and it is named with the remedy, because "add a member" is not
   * answerable until the project has a role to give them. The per-member role
   * selects fall back to text for the same reason: a select with zero options
   * cannot show the role a member already holds, let alone change it.
   */
  const hasRoles = roles.length > 0;

  const selectCls = 'rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body';

  if (loading) return <div className="py-8 text-center text-text-muted"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      {canManage && !hasRoles && (
        <div
          data-testid="member-add-no-roles"
          className="flex items-start gap-3 rounded-[--radius-card] border border-status-warning/40 bg-status-warning-bg/50 p-4"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
          <div>
            <p className="text-sm font-medium text-text-heading">{t('noRolesHeading')}</p>
            <p className="mt-0.5 text-sm text-text-muted">{t('noRolesBody')}</p>
          </div>
        </div>
      )}

      {canManage && hasRoles && (
        <div className="flex flex-wrap items-end gap-3 rounded-[--radius-card] border border-surface-border bg-surface-card p-4">
          <div className="flex-1 min-w-[200px]">
            <label className="mb-1 block text-xs text-text-muted">{t('addMemberLabel')}</label>
            <select value={selectedEmp} onChange={(e) => setSelectedEmp(e.target.value)} data-testid="member-add-employee" className={`w-full ${selectCls}`}>
              <option value="">{t('selectEmployeePlaceholder')}</option>
              {available.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">{t('roleLabel')}</label>
            <select value={selectedRoleId} onChange={(e) => setSelectedRoleId(e.target.value)} data-testid="member-add-role" className={selectCls}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <button onClick={add} disabled={!selectedEmp || !selectedRoleId || adding} data-testid="member-add"
            className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-60">
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} {tc('add')}
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-[--radius-card] border border-surface-border bg-surface-card">
        <table data-testid="member-table" className="w-full text-sm">
          <thead>
            {/* neutral — table header */}
            <tr className="border-b border-surface-border text-start text-text-muted">
              <th className="px-4 py-3 font-medium">{t('colMember')}</th>
              <th className="px-4 py-3 font-medium">{t('roleLabel')}</th>
              {canManage && <th className="px-4 py-3 font-medium text-end">{t('colActions')}</th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const roleName = m.projectRole?.name ?? m.role;
              const roleColor = m.projectRole?.color ?? undefined;
              return (
                <tr key={m.id} data-testid={`member-row-${m.id}`} className="border-b border-surface-border-light last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-primary-light/50 text-xs font-semibold text-brand-primary">
                        {m.employee?.fullName?.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-text-body">{m.employee?.fullName}</p>
                        <p className="text-xs text-text-muted">{m.employee?.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {canManage && hasRoles ? (
                      <select value={m.roleId ?? ''} onChange={(e) => changeRole(m.id, e.target.value)} data-testid={`member-role-select-${m.id}`} className={selectCls}>
                        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    ) : (
                      <span className="inline-flex items-center gap-2 text-text-body">
                        {roleColor && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: roleColor }} />}
                        {roleName}
                      </span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-end">
                      {isOwnerMembership(m) ? (
                        <span
                          data-testid={`member-remove-owner-locked-${m.id}`}
                          className="text-xs text-text-muted"
                          title={t('ownerNotRemovableTooltip')}
                        >
                          —
                        </span>
                      ) : (
                        <button onClick={() => remove(m)} data-testid={`member-remove-${m.id}`} className="text-status-error hover:opacity-70">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr data-testid="member-empty"><td colSpan={3} className="px-4 py-8 text-center text-text-muted">{t('emptyNoMembers')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
