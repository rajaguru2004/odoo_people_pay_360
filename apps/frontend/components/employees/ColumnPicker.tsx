'use client';

import { useEffect, useRef, useState } from 'react';
import { Columns3, Check } from 'lucide-react';
import { TemplateField } from '@/types/profile-template';

/**
 * Chooses which template fields appear as extra columns on the employee list.
 *
 * The choice is per-user and per-browser (localStorage), not a template setting:
 * "which columns do I want to see" is a personal working preference, and putting
 * it on the template would mean one admin's view silently rearranging everyone
 * else's list.
 */

const STORAGE_KEY = 'employee-list-columns';

export function loadSelectedColumns(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    // Corrupt or unavailable storage must not take the page down.
    return [];
  }
}

function saveSelectedColumns(keys: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* private browsing — the choice just does not persist */
  }
}

interface ColumnPickerProps {
  candidates: TemplateField[];
  selected: string[];
  onChange: (keys: string[]) => void;
}

export default function ColumnPicker({
  candidates,
  selected,
  onChange,
}: ColumnPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (candidates.length === 0) return null;

  const toggle = (key: string) => {
    const next = selected.includes(key)
      ? selected.filter((k) => k !== key)
      : [...selected, key];
    saveSelectedColumns(next);
    onChange(next);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-2 text-sm border border-surface-border rounded-[--radius-button] text-text-heading hover:bg-surface-page transition-colors"
        title="Choose extra columns"
      >
        <Columns3 size={16} />
        <span className="hidden sm:inline">Columns</span>
        {selected.length > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-brand-primary/10 text-brand-primary">
            {selected.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute end-0 mt-2 w-64 max-h-80 overflow-y-auto bg-surface-card border border-surface-border rounded-xl shadow-lg z-20 p-1">
          <p className="px-3 py-2 text-xs text-text-muted">
            Extra columns from your employee template.
          </p>
          {candidates.map((f) => {
            const on = selected.includes(f.fieldKey);
            return (
              <button
                key={f.fieldKey}
                type="button"
                onClick={() => toggle(f.fieldKey)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-start rounded-lg hover:bg-surface-page transition-colors"
              >
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                    on
                      ? 'bg-brand-primary border-brand-primary text-white'
                      : 'border-surface-border'
                  }`}
                >
                  {on && <Check size={12} />}
                </span>
                <span className="flex-1 truncate">{f.label}</span>
                {f.origin === 'CUSTOM' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-primary/10 text-brand-primary">
                    custom
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
