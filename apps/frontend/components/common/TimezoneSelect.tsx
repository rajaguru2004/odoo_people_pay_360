'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search } from 'lucide-react';
import { getGroupedTimezones, utcOffsetLabel } from '@/utils/tzDate';

interface TimezoneSelectProps {
  value: string;
  onChange: (tz: string) => void;
  includeInherit?: boolean;
  /** Label for the "inherit" (empty value) option. Defaults to a generic
   *  string; pass the resolved company zone to show it explicitly. */
  inheritLabel?: string;
  className?: string;
}

// Computed once at module level — avoids recalculating 600+ zones per render.
const GROUPED = getGroupedTimezones();

interface DropdownRect {
  top: number;
  left: number;
  width: number;
  openUpward: boolean;
}

export default function TimezoneSelect({
  value,
  onChange,
  includeInherit = false,
  inheritLabel = 'Inherit company timezone',
  className = '',
}: TimezoneSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [rect, setRect] = useState<DropdownRect | null>(null);
  const [mounted, setMounted] = useState(false);

  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Only render portal after client mount (avoids SSR mismatch)
  useEffect(() => { setMounted(true); }, []);

  // Derive display label from value — never relies on DOM selection state
  const selectedLabel = useMemo(() => {
    if (!value) return includeInherit ? inheritLabel : 'Select timezone…';
    for (const { zones } of GROUPED) {
      const z = zones.find(z => z.value === value);
      if (z) return z.label;
    }
    return `(${utcOffsetLabel(value)}) ${value.replace(/_/g, ' ')}`;
  }, [value, includeInherit, inheritLabel]);

  // Filter zones by search query
  const filtered = useMemo(() => {
    if (!search.trim()) return GROUPED;
    const q = search.toLowerCase();
    return GROUPED
      .map(({ group, zones }) => ({
        group,
        zones: zones.filter(
          z => z.value.toLowerCase().includes(q) || z.label.toLowerCase().includes(q),
        ),
      }))
      .filter(({ zones }) => zones.length > 0);
  }, [search]);

  // Calculate dropdown position from button's bounding rect
  const calcRect = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const dropdownH = 340;
    const spaceBelow = window.innerHeight - r.bottom;
    const openUpward = spaceBelow < dropdownH && r.top > dropdownH;
    setRect({
      top: openUpward ? r.top - dropdownH - 4 : r.bottom + 4,
      left: r.left,
      width: Math.max(r.width, 300),
      openUpward,
    });
  }, []);

  const handleOpen = () => {
    calcRect();
    setOpen(true);
  };

  // Recalculate on scroll / resize while open
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

  // Close on outside click (checks both button and portal dropdown)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        btnRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) return;
      setOpen(false);
      setSearch('');
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus search and scroll to selected option when opened
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      searchRef.current?.focus();
      document.getElementById(`tz-opt-${value}`)?.scrollIntoView({ block: 'nearest' });
    }, 50);
    return () => clearTimeout(t);
  }, [open, value]);

  const handleSelect = (tz: string) => {
    onChange(tz);
    setOpen(false);
    setSearch('');
  };

  const dropdownPanel = open && rect && (
    <div
      ref={dropdownRef}
      style={{
        position: 'fixed',
        top: rect.top,
        left: rect.left,
        width: rect.width,
        maxHeight: 340,
        zIndex: 9999,
      }}
      className="bg-surface-overlay border border-surface-border rounded-xl shadow-2xl flex flex-col"
    >
      {/* Search bar */}
      <div className="p-2 border-b border-surface-border-light flex-shrink-0">
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-page rounded-lg border border-surface-border">
          <Search size={13} className="text-text-muted flex-shrink-0" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search timezones…"
            className="flex-1 bg-transparent text-sm outline-none text-text-body placeholder-text-muted"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="text-text-muted hover:text-text-body text-xs"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Options list */}
      <div className="overflow-y-auto flex-1">
        {/* Inherit option */}
        {includeInherit && !search && (
          <button
            type="button"
            onClick={() => handleSelect('')}
            className={`w-full text-left px-4 py-2 text-sm transition-colors ${
              !value
                ? 'bg-brand-primary-light text-brand-primary font-medium'
                : 'text-text-muted italic hover:bg-surface-page'
            }`}
          >
            {inheritLabel}
          </button>
        )}

        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-sm text-text-muted text-center">
            No timezones found for &quot;{search}&quot;
          </div>
        ) : (
          filtered.map(({ group, zones }) => (
            <div key={group}>
              <div className="px-4 py-1 text-[10px] font-bold text-text-muted uppercase tracking-widest bg-surface-page sticky top-0 border-b border-surface-border-light">
                {group}
              </div>
              {zones.map(({ value: zv, label }) => (
                <button
                  key={zv}
                  id={`tz-opt-${zv}`}
                  type="button"
                  onClick={() => handleSelect(zv)}
                  className={`w-full text-left px-4 py-1.5 text-sm transition-colors ${
                    value === zv
                      ? 'bg-brand-primary-light text-brand-primary font-medium'
                      : 'text-text-body hover:bg-surface-page'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );

  return (
    <div className={`relative ${className}`}>
      {/* Trigger button */}
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        className="w-full flex items-center justify-between h-9 rounded-lg border border-surface-border bg-surface-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary hover:border-surface-border transition-colors text-text-body"
      >
        <span
          className={`truncate ${value ? 'text-text-body' : 'text-text-muted italic'}`}
          title={selectedLabel}
        >
          {selectedLabel}
        </span>
        <ChevronDown
          size={14}
          className={`text-text-muted flex-shrink-0 ml-2 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Portal: renders directly on document.body to escape overflow:hidden parents */}
      {mounted && createPortal(dropdownPanel, document.body)}
    </div>
  );
}
