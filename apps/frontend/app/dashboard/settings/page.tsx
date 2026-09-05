'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  BookOpen,
  Clock,
  GitBranch,
  Palette,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useSystemSettings, useUpdateSettings } from '@/hooks/useSettings';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { apiErrorMessage } from '@/utils/apiError';
import { cn } from '@/utils/cn';
import type { UserRole } from '@/types/auth';
import type { PublicBranding } from '@/types/settings';
import { AttendanceSection } from '@/components/settings/AttendanceSection';
import { BrandingSection, BRANDING_KEYS } from '@/components/settings/BrandingSection';
import { LibrarySection } from '@/components/settings/LibrarySection';
import { OvertimePolicySection } from '@/components/settings/OvertimePolicySection';
import { PeopleSection } from '@/components/settings/PeopleSection';
import { PreferencesSection } from '@/components/settings/PreferencesSection';
import { SupervisorHierarchySection } from '@/components/settings/SupervisorHierarchySection';

type TabId =
  | 'preferences'
  | 'branding'
  | 'attendance'
  | 'people'
  | 'overtime'
  | 'supervisors'
  | 'libraries';

interface Tab {
  id: TabId;
  label: string;
  icon: React.ElementType;
  /** Who is offered the tab. Every one here has a route the role may call. */
  roles: UserRole[];
}

/**
 * The tabs, filtered by role.
 *
 * The rail offers Settings to every role, but `GET /system-settings` and its
 * PATCH are ADMIN only. A role is given a tab only when the server will answer
 * the requests behind it — an HR manager may assign supervisors and read the
 * overtime policies, so those two tabs are theirs; nobody but an administrator
 * gets a tab whose only endpoint would 403. Everyone gets Preferences, which
 * reads the unauthenticated branding endpoint.
 *
 * This is an affordance and not the boundary. Every route behind these tabs has
 * a `RolesGuard` of its own.
 */
const TABS: Tab[] = [
  {
    id: 'preferences',
    label: 'Preferences',
    icon: SettingsIcon,
    roles: ['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER', 'EMPLOYEE'],
  },
  { id: 'branding', label: 'Branding', icon: Palette, roles: ['ADMIN'] },
  { id: 'attendance', label: 'Attendance', icon: Clock, roles: ['ADMIN'] },
  { id: 'people', label: 'People', icon: SlidersHorizontal, roles: ['ADMIN'] },
  { id: 'overtime', label: 'Overtime policies', icon: Clock, roles: ['ADMIN', 'HR_MANAGER'] },
  { id: 'supervisors', label: 'Supervisors', icon: GitBranch, roles: ['ADMIN', 'HR_MANAGER'] },
  { id: 'libraries', label: 'Libraries', icon: BookOpen, roles: ['ADMIN'] },
];

/** The settings keys the shell reads, so a branding save updates it in place. */
const BRANDING_STORE_KEYS = new Set<string>(BRANDING_KEYS);

export default function SettingsPage() {
  const { user, hasHydrated } = useAuthStore();
  const setBranding = useBrandingStore((state) => state.setBranding);

  const [activeTab, setActiveTab] = useState<TabId>('preferences');
  /**
   * Only what has been EDITED, never a copy of the whole map.
   *
   * Seeding a full draft from the query would mean a background refetch either
   * clobbers an unsaved edit or is silently ignored; holding just the changes
   * lets the two be merged at render and makes the dirty set fall out for free.
   */
  const [draft, setDraft] = useState<Record<string, string>>({});

  const settings = useSystemSettings();
  const updateSettings = useUpdateSettings();

  const isAdmin = user?.role === 'ADMIN';
  const stored = useMemo(() => settings.data?.data ?? {}, [settings.data]);
  const values = useMemo(() => ({ ...stored, ...draft }), [stored, draft]);

  const dirtyKeys = useMemo(
    () => Object.keys(draft).filter((key) => draft[key] !== stored[key]),
    [draft, stored],
  );

  const tabs = useMemo(
    () => (user ? TABS.filter((tab) => tab.roles.includes(user.role)) : []),
    [user],
  );

  const change = (key: string, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    if (dirtyKeys.length === 0) return;
    const payload = Object.fromEntries(dirtyKeys.map((key) => [key, values[key]]));

    try {
      await updateSettings.mutateAsync(payload);

      // The shell reads branding from its own store rather than from this
      // query, so a saved colour or company name would otherwise not appear
      // until the next full load.
      const brandingPatch = Object.fromEntries(
        Object.entries(payload).filter(([key]) => BRANDING_STORE_KEYS.has(key)),
      ) as Partial<PublicBranding>;
      if (Object.keys(brandingPatch).length > 0) setBranding(brandingPatch);

      setDraft({});
      toast.success('Settings saved');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not save those settings'));
    }
  };

  usePageHeader(
    'Settings',
    isAdmin ? 'Company configuration' : 'Your account and the company profile',
  );

  // Nothing is decided from the session until storage has been read — see the
  // note on `hasHydrated` in the auth store.
  if (!hasHydrated || !user) return null;

  // A role whose only tab is Preferences gets the panel without the rail: a
  // one-item tab list is chrome with nothing to choose between.
  const showTabs = tabs.length > 1;
  const current = tabs.some((tab) => tab.id === activeTab) ? activeTab : 'preferences';

  return (
    <div className="space-y-4 sm:space-y-5" data-testid="settings-page">
      {settings.isError && isAdmin && (
        <p className="rounded-[var(--radius-card)] border border-status-error/30 bg-status-error-bg px-4 py-3 text-sm text-status-error">
          {apiErrorMessage(settings.error, 'Could not load the settings')}
        </p>
      )}

      <div className={cn('grid grid-cols-1 gap-4 lg:gap-6', showTabs && 'lg:grid-cols-5')}>
        {showTabs && (
          <nav aria-label="Settings sections" className="surface-panel p-2 lg:col-span-1">
            <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const selected = current === tab.id;
                return (
                  <li key={tab.id} className="shrink-0 lg:shrink">
                    <button
                      type="button"
                      aria-current={selected ? 'page' : undefined}
                      onClick={() => setActiveTab(tab.id)}
                      className={cn(
                        'flex w-full items-center gap-2 whitespace-nowrap rounded-[var(--radius-button)] px-3 py-2 text-start text-sm transition-colors',
                        selected
                          ? 'bg-status-info-bg font-semibold text-brand-primary'
                          : 'text-text-body hover:bg-surface-border-light',
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      {tab.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        <div className={cn('min-w-0', showTabs && 'lg:col-span-4')}>
          {current === 'preferences' && <PreferencesSection />}

          {current === 'branding' && (
            <BrandingSection values={values} onChange={change} disabled={settings.isLoading} />
          )}

          {current === 'attendance' && (
            <AttendanceSection values={values} onChange={change} disabled={settings.isLoading} />
          )}

          {current === 'people' && (
            <PeopleSection values={values} onChange={change} disabled={settings.isLoading} />
          )}

          {current === 'overtime' && (
            <OvertimePolicySection
              settings={values}
              onChangeSetting={change}
              canEdit={isAdmin}
            />
          )}

          {current === 'supervisors' && (
            <SupervisorHierarchySection
              settings={values}
              onChangeSetting={change}
              canEdit={isAdmin}
            />
          )}

          {current === 'libraries' && <LibrarySection />}
        </div>
      </div>

      {/*
        The save bar belongs to the settings MAP and appears wherever a key on it
        was edited — the overtime and supervisor tabs each own a switch that
        lives there too. The library editor, the policy drawer and the supervisor
        assignments write through their own endpoints and never make it dirty.
      */}
      {dirtyKeys.length > 0 && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-surface-border bg-surface-card px-4 py-3 shadow-lg">
          <p className="text-sm text-text-body">
            {dirtyKeys.length} unsaved change{dirtyKeys.length === 1 ? '' : 's'}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setDraft({})}>
              Discard
            </Button>
            <Button onClick={save} isLoading={updateSettings.isPending}>
              Save changes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
