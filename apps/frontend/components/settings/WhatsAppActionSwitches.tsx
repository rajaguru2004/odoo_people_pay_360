'use client';

import { useEffect, useMemo, useState } from 'react';
import { KeyRound, ListChecks, Loader2, Pencil, Users } from 'lucide-react';
import { toast } from 'sonner';
import whatsappService from '@/services/whatsappService';
import { WhatsAppActionRow } from '@/types/whatsapp';

/**
 * Per-action on/off switches, driven entirely by the live registry.
 *
 * Nothing here hardcodes what the channel can do. A newly registered action
 * appears the moment it exists and a removed one disappears, which is the only
 * way an admin page over a catalogue this size stays honest.
 *
 * Rows the two kill switches already suppress are shown DISABLED rather than
 * hidden — mirroring what the server-side menu builder does — so the page never
 * claims staff can reach something they cannot, and an admin can see why.
 */
export default function WhatsAppActionSwitches({
  mutationsEnabled,
  approvalsEnabled,
  requirePinForSensitive,
}: {
  mutationsEnabled: boolean;
  approvalsEnabled: boolean;
  requirePinForSensitive: boolean;
}) {
  const [rows, setRows] = useState<WhatsAppActionRow[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await whatsappService.actions();
        setRows(res.data ?? []);
      } catch {
        setRows([]);
      }
    })();
  }, []);

  const grouped = useMemo(() => {
    const out = new Map<string, WhatsAppActionRow[]>();
    for (const r of rows ?? []) {
      // Token-gated approvals are never listed in a menu, so an on/off switch
      // for them would be meaningless — `approvalsEnabled` is their switch.
      if (r.needsActionToken) continue;
      const list = out.get(r.groupLabel) ?? [];
      list.push(r);
      out.set(r.groupLabel, list);
    }
    for (const list of out.values()) list.sort((a, b) => a.order - b.order);
    return [...out.entries()];
  }, [rows]);

  async function persist(next: WhatsAppActionRow[]) {
    setRows(next);
    setSaving(true);
    try {
      await whatsappService.setActionsDisabled(next.filter((r) => !r.enabled).map((r) => r.key));
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Could not save that change');
      // Put the UI back where the server still is.
      const res = await whatsappService.actions().catch(() => null);
      if (res) setRows(res.data ?? []);
    } finally {
      setSaving(false);
    }
  }

  const toggle = (key: string) =>
    persist((rows ?? []).map((r) => (r.key === key ? { ...r, enabled: !r.enabled } : r)));

  const setAll = (enabled: boolean) => persist((rows ?? []).map((r) => ({ ...r, enabled })));

  if (!rows) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
        Loading what staff can do…
      </div>
    );
  }
  if (!rows.length) return null;

  const listable = rows.filter((r) => !r.needsActionToken);
  const on = listable.filter((r) => r.enabled).length;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
            <ListChecks className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-800">What staff can do here</h3>
            <p className="text-xs text-slate-500">
              {on} of {listable.length} on{saving ? ' · saving…' : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setAll(true)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            All on
          </button>
          <button
            type="button"
            onClick={() => setAll(false)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            All off
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {grouped.map(([group, items]) => (
          <div key={group}>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {group}
            </p>
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-100">
              {items.map((r) => {
                const suppressed = r.writes && !mutationsEnabled;
                return (
                  <div key={r.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p
                        className={`truncate text-sm ${suppressed ? 'text-slate-400' : 'text-slate-700'}`}
                      >
                        {r.label}
                      </p>
                      <div className="mt-0.5 flex flex-wrap gap-1.5">
                        {r.writes && (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                            <Pencil className="h-2.5 w-2.5" /> Makes a change
                          </span>
                        )}
                        {r.sensitive && requirePinForSensitive && (
                          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                            <KeyRound className="h-2.5 w-2.5" /> Needs PIN
                          </span>
                        )}
                        {!r.roles.includes('EMPLOYEE') && (
                          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                            <Users className="h-2.5 w-2.5" /> Managers only
                          </span>
                        )}
                      </div>
                      {suppressed && (
                        <p className="mt-1 text-[11px] text-slate-400">
                          Turn on “Allow requests and changes” to use this.
                        </p>
                      )}
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={r.enabled}
                      onClick={() => toggle(r.key)}
                      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                        r.enabled ? 'bg-brand-primary' : 'bg-slate-200'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                          r.enabled ? 'left-[1.15rem]' : 'left-0.5'
                        }`}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {!approvalsEnabled && (
        <p className="mt-3 text-xs text-slate-400">
          Approve and reject are governed by “Allow approvals from WhatsApp” above — they arrive
          as buttons on a notification and never appear in the menu.
        </p>
      )}
    </div>
  );
}
