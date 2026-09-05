'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, Trash2, Save, ShieldCheck } from 'lucide-react';
import projectRoleService from '@/services/projectRoleService';
import { apiErrorMessage } from '@/utils/apiError';
import type {
  ProjectRole,
  ProjectPermission,
  PermissionCatalogItem,
} from '@/types/project';

const OWNER_SLUG = 'owner';
const PRESET_COLORS = ['#00358F', '#f66600', '#0EA5E9', '#64748B', '#7C3AED', '#059669'];

type Draft = Record<string, Set<ProjectPermission>>;

export default function ProjectRolesManager({ projectId }: { projectId: string }) {
  const t = useTranslations('projectRolesManager');
  const tc = useTranslations('common');
  const [roles, setRoles] = useState<ProjectRole[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalogItem[]>([]);
  const [draft, setDraft] = useState<Draft>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [rolesRes, catRes] = (await Promise.all([
        projectRoleService.listRoles(projectId),
        projectRoleService.getCatalog(),
      ])) as [any, any];
      const loaded: ProjectRole[] = rolesRes.data || [];
      setRoles(loaded);
      setCatalog(catRes.data || []);
      setDraft(buildDraft(loaded));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const map = new Map<string, PermissionCatalogItem[]>();
    for (const item of catalog) {
      if (!map.has(item.group)) map.set(item.group, []);
      map.get(item.group)!.push(item);
    }
    return Array.from(map.entries());
  }, [catalog]);

  const isOwner = (r: ProjectRole) => r.slug === OWNER_SLUG;

  const toggle = (roleId: string, perm: ProjectPermission) => {
    setDraft((prev) => {
      const next: Draft = { ...prev, [roleId]: new Set(prev[roleId]) };
      if (next[roleId].has(perm)) next[roleId].delete(perm);
      else next[roleId].add(perm);
      return next;
    });
  };

  const dirtyRoleIds = useMemo(() => {
    return roles
      .filter((r) => !isOwner(r))
      .filter((r) => !sameSet(draft[r.id], r.permissions))
      .map((r) => r.id);
  }, [roles, draft]);

  /**
   * R67 — a resolved promise is not a saved change.
   *
   * `ProjectRolesService.update()` force-restores all twelve permissions when
   * `slug === 'owner'` and still answers `200 { success: true }` with the full
   * set echoed back (R11). This screen used to await the PATCH, treat any
   * resolution as success and re-read: the tick fell silently back off, the
   * dirty marker cleared — which is the only "saved" signal the screen has —
   * and nothing was said. "200 OK" and "your change was applied" were being
   * treated as the same fact, and R11 proves they are not.
   *
   * So the response is compared against the intent. When the server tells us
   * what the role now holds and it is not what we sent, that is a failure and
   * it is reported as one. When the response carries no permissions to compare
   * (an endpoint that answers `{ data: {} }`), nothing is claimed either way —
   * inventing a failure from a silent response would be the same mistake in the
   * other direction.
   */
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const results = await Promise.all(
        dirtyRoleIds.map(async (roleId) => {
          const intended = Array.from(draft[roleId]);
          const res: any = await projectRoleService.updateRole(projectId, roleId, {
            permissions: intended,
          });
          const returned = res?.data?.permissions;
          return { roleId, intended, returned };
        }),
      );

      const discarded = results.filter(
        (r) => Array.isArray(r.returned) && !sameSet(new Set(r.intended), r.returned),
      );

      await load();

      if (discarded.length > 0) {
        const names = discarded
          .map((r) => roles.find((x) => x.id === r.roleId)?.name ?? r.roleId)
          .join(', ');
        setError(t('saveDiscardedError', { names, count: discarded.length }));
      }
    } catch (e: any) {
      setError(apiErrorMessage(e, t('saveFailedFallback')));
    } finally {
      setSaving(false);
    }
  };

  const removeRole = async (role: ProjectRole) => {
    if (!confirm(t('deleteConfirmMessage', { name: role.name }))) return;
    setError(null);
    try {
      await projectRoleService.deleteRole(projectId, role.id);
      await load();
    } catch (e: any) {
      setError(apiErrorMessage(e, t('deleteFailedFallback')));
    }
  };

  if (loading) {
    return (
      <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-8 text-center text-text-muted">
        <Loader2 className="mx-auto h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-text-heading">
            <ShieldCheck className="h-4 w-4 text-brand-primary" /> {t('heading')}
          </h3>
          <p className="mt-1 text-sm text-text-muted">
            {t('subtext')}
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          data-testid="role-create"
          className="flex shrink-0 items-center gap-2 rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body hover:bg-surface-page"
        >
          <Plus className="h-4 w-4" /> {t('newRoleBtn')}
        </button>
      </div>

      {error && (
        <div data-testid="role-error" className="mt-3 rounded-[--radius-button] bg-status-error-bg px-3 py-2 text-sm text-status-error">
          {error}
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        <table data-testid="role-matrix" className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-surface-border">
              <th className="px-3 py-2 text-start font-medium text-text-muted">{t('colPermission')}</th>
              {roles.map((r) => (
                <th key={r.id} data-testid={`role-header-${r.slug}`} className="px-3 py-2 text-center font-medium">
                  <div className="flex flex-col items-center gap-1">
                    <span className="inline-flex items-center gap-1.5 text-text-body">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: r.color || '#64748B' }} />
                      {r.name}
                    </span>
                    {r.isSystem ? (
                      <span className="rounded-full bg-brand-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-brand-primary">
                        {t('presetBadge')}
                      </span>
                    ) : (
                      <button onClick={() => removeRole(r)} data-testid={`role-delete-${r.slug}`} className="text-status-error hover:opacity-70" title={t('deleteRoleTooltip')}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, items]) => (
              <React.Fragment key={group}>
                <tr className="bg-surface-page/60">
                  <td colSpan={roles.length + 1} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
                    {group}
                  </td>
                </tr>
                {items.map((item) => (
                  <tr key={item.key} data-testid={`role-permission-row-${item.key}`} className="border-b border-surface-border-light last:border-0">
                    <td className="px-3 py-2 text-text-body">{item.label}</td>
                    {roles.map((r) => {
                      const owner = isOwner(r);
                      const checked = owner || (draft[r.id]?.has(item.key) ?? false);
                      return (
                        <td key={r.id} className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={owner}
                            onChange={() => toggle(r.id, item.key)}
                            data-testid={`role-matrix-cell-${r.slug}-${item.key}`}
                            className="h-4 w-4 cursor-pointer accent-[--color-brand-primary] disabled:cursor-not-allowed disabled:opacity-50"
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-end gap-3">
        {dirtyRoleIds.length > 0 && (
          <span data-testid="role-dirty-count" className="text-xs text-text-muted">{t('dirtyRolesCount', { count: dirtyRoleIds.length })}</span>
        )}
        <button
          onClick={save}
          disabled={saving || dirtyRoleIds.length === 0}
          data-testid="role-save"
          className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {t('saveChangesBtn')}
        </button>
      </div>

      {showCreate && (
        <CreateRoleModal
          projectId={projectId}
          roles={roles}
          onClose={() => setShowCreate(false)}
          onCreated={async () => { setShowCreate(false); await load(); }}
        />
      )}
    </div>
  );
}

function CreateRoleModal({
  projectId,
  roles,
  onClose,
  onCreated,
}: {
  projectId: string;
  roles: ProjectRole[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations('projectRolesManager');
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[4]);
  const [copyFromRoleId, setCopyFromRoleId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await projectRoleService.createRole(projectId, {
        name: name.trim(),
        color,
        copyFromRoleId: copyFromRoleId || undefined,
      });
      onCreated();
    } catch (e: any) {
      setError(apiErrorMessage(e, t('createFailedFallback')));
      setSaving(false);
    }
  };

  const inputCls = 'w-full rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div data-testid="role-create-modal" className="w-full max-w-md rounded-[--radius-card] bg-surface-overlay p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h4 className="font-semibold text-text-heading">{t('newRoleBtn')}</h4>
        {error && (
          <div data-testid="role-create-error" className="mt-3 rounded-[--radius-button] bg-status-error-bg px-3 py-2 text-sm text-status-error">{error}</div>
        )}
        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-xs text-text-muted">{t('roleNameLabel')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} data-testid="role-create-name" placeholder={t('roleNamePlaceholder')} className={inputCls} autoFocus />
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">{t('colorLabel')}</label>
            <div className="flex gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  data-testid={`role-create-color-${c.replace('#', '')}`}
                  className={`h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-surface-overlay ${color === c ? 'ring-brand-primary' : 'ring-transparent'}`}
                  style={{ backgroundColor: c }}
                  aria-label={t('colorSwatchLabel', { hex: c })}
                />
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">{t('copyPermissionsLabel')}</label>
            <select value={copyFromRoleId} onChange={(e) => setCopyFromRoleId(e.target.value)} data-testid="role-create-copy-from" className={inputCls}>
              <option value="">{t('startWithNoPermissionsOption')}</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} data-testid="role-create-cancel" className="rounded-[--radius-button] border border-surface-border px-4 py-2 text-sm text-text-body hover:bg-surface-page">{tc('cancel')}</button>
          <button onClick={submit} disabled={!name.trim() || saving} data-testid="role-create-submit"
            className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-60">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t('createBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}

function buildDraft(roles: ProjectRole[]): Draft {
  const d: Draft = {};
  for (const r of roles) d[r.id] = new Set(r.permissions);
  return d;
}

function sameSet(set: Set<ProjectPermission> | undefined, arr: ProjectPermission[]) {
  if (!set) return false;
  if (set.size !== arr.length) return false;
  return arr.every((p) => set.has(p));
}
