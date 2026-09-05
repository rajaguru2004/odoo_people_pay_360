'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, Building2, Check } from 'lucide-react';
import { useBranchStore } from '@/store/branchStore';
import { useBranches } from '@/hooks/useBranches';
import { usePermission } from '@/hooks/usePermission';

// NOTE: chrome strings ("All Branches") are literal pending i18n keys under the
// `topHeader` namespace; branch names themselves are admin-entered data.
interface BranchOption {
  id: string;
  code: string;
  name: string;
}

interface DropdownRect {
  top: number;
  left: number;
  width: number;
  openUpward: boolean;
}

export default function BranchPicker({ className = '' }: { className?: string }) {
  const { canSwitchBranch, user } = usePermission();
  const { selectedBranchId, setSelectedBranch } = useBranchStore();
  const isGlobal = !!user?.isGlobalBranchAccess;
  const canSwitch = canSwitchBranch();

  // Options come ONLY from what the server will actually accept.
  //
  // A global user may pick any active branch; a scoped user only their granted
  // set. Do NOT fall back to the full branch list when the envelope is empty:
  // an empty envelope means "no branch access", not "all branches", and
  // offering those branches just makes every request 403 with
  // "You do not have access to the selected branch".
  //
  // An ADMIN should never be in that state — prisma/seed.ts and
  // prisma/backfill-branches.ts both assert `role: ADMIN => isGlobalBranchAccess`.
  // If the picker is missing for an admin, that flag is the thing to fix, not
  // this component.
  const grants: BranchOption[] = useMemo(
    () => user?.accessibleBranches ?? [],
    [user?.accessibleBranches],
  );
  // Scoped users already have their list, so skip the (forbidden for some)
  // /branches call for them.
  const { data } = useBranches(canSwitch && isGlobal);
  const allBranches: BranchOption[] = useMemo(
    () => (data?.data ?? []).map((b) => ({ id: b.id, code: b.code, name: b.name })),
    [data],
  );
  const options: BranchOption[] = useMemo(
    () => (isGlobal ? allBranches : grants),
    [isGlobal, allBranches, grants],
  );

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [rect, setRect] = useState<DropdownRect | null>(null);
  const [mounted, setMounted] = useState(false);

  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  // A concrete branch is always selected — "All Branches" is intentionally not
  // offered (an admin manages one branch at a time).
  const selectedLabel = useMemo(() => {
    const b = options.find((o) => o.id === selectedBranchId);
    return b?.name ?? options[0]?.name ?? 'Select branch';
  }, [selectedBranchId, options]);

  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter(
      (o) => o.name.toLowerCase().includes(q) || o.code.toLowerCase().includes(q),
    );
  }, [search, options]);

  const calcRect = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const dropdownH = 320;
    const spaceBelow = window.innerHeight - r.bottom;
    const openUpward = spaceBelow < dropdownH && r.top > dropdownH;
    setRect({
      top: openUpward ? r.top - dropdownH - 4 : r.bottom + 4,
      left: r.left,
      width: Math.max(r.width, 240),
      openUpward,
    });
  }, []);

  const handleOpen = () => {
    calcRect();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const update = () => calcRect();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, calcRect]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setOpen(false);
      setSearch('');
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  // Always keep a concrete branch selected (no "All Branches"). If nothing is
  // selected yet — or the persisted selection is no longer valid — default to
  // the first available branch.
  useEffect(() => {
    if (!canSwitch || options.length === 0) return;
    const valid = !!selectedBranchId && options.some((o) => o.id === selectedBranchId);
    if (!valid) setSelectedBranch(options[0].id);
  }, [canSwitch, options, selectedBranchId, setSelectedBranch]);

  // Hidden entirely for users who cannot switch branches (pinned server-side).
  if (!canSwitch) return null;

  // Nothing meaningful to pick.
  if (options.length === 0) return null;

  const handleSelect = (id: string | null) => {
    setSelectedBranch(id);
    setOpen(false);
    setSearch('');
  };

  const showSearch = options.length > 8;

  const dropdownPanel = open && rect && (
    <div
      ref={dropdownRef}
      style={{
        position: 'fixed',
        top: rect.top,
        left: rect.left,
        width: rect.width,
        maxHeight: 320,
        zIndex: 9999,
      }}
      className="bg-surface-overlay border border-surface-border rounded-xl shadow-2xl flex flex-col"
    >
      {showSearch && (
        <div className="p-2 border-b border-surface-border-light flex-shrink-0">
          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-page rounded-lg border border-surface-border">
            <Search size={13} className="text-text-muted flex-shrink-0" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search branches…"
              className="flex-1 bg-transparent text-sm outline-none text-text-body placeholder-text-muted"
            />
          </div>
        </div>
      )}

      <div className="overflow-y-auto flex-1 py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-sm text-text-muted text-center">No branches found</div>
        ) : (
          filtered.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => handleSelect(o.id)}
              className={`w-full flex items-center justify-between text-start px-3 py-2 text-sm transition-colors ${
                selectedBranchId === o.id
                  ? 'bg-brand-primary-light text-brand-primary font-medium'
                  : 'text-text-body hover:bg-surface-page'
              }`}
            >
              <span className="truncate">
                <span className="text-text-muted me-1.5">{o.code}</span>
                {o.name}
              </span>
              {selectedBranchId === o.id && <Check size={14} className="flex-shrink-0" />}
            </button>
          ))
        )}
      </div>
    </div>
  );

  return (
    <div className={`relative ${className}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        title={selectedLabel}
        className="flex items-center gap-2 h-9 rounded-lg border border-surface-border bg-surface-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary hover:border-brand-primary transition-colors text-text-body max-w-[200px]"
      >
        <Building2 size={15} className="text-text-muted flex-shrink-0" />
        <span className="truncate font-medium">{selectedLabel}</span>
        <ChevronDown
          size={14}
          className={`text-text-muted flex-shrink-0 ms-auto transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {mounted && createPortal(dropdownPanel, document.body)}
    </div>
  );
}
