'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, ShieldAlert, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import copilotService from '@/services/copilotService';
import { CopilotTurn, PendingAction } from '@/types/copilot';
import PreviewFields, { friendlyToolTitle } from './PreviewFields';

interface Props {
  action: PendingAction;
  disabled?: boolean;
  onResolve: (turn: CopilotTurn) => void;
}

export default function ConfirmActionCard({ action, disabled, onResolve }: Props) {
  const t = useTranslations('copilot');
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [resolved, setResolved] = useState(false);

  const expired = new Date(action.expiresAt) < new Date();

  const resolve = async (approve: boolean) => {
    setBusy(approve ? 'confirm' : 'reject');
    try {
      const res = await copilotService.confirmAction({ actionId: action.actionId, approve });
      setResolved(true);
      onResolve(res.data);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to resolve the action');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={`rounded-xl border p-4 space-y-3 ${
        action.destructive ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <div
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            action.destructive ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'
          }`}
        >
          {action.destructive ? <TriangleAlert size={16} /> : <ShieldAlert size={16} />}
        </div>
        <div>
          <p className="font-semibold text-slate-800">{friendlyToolTitle(action.tool)}</p>
          <p className={`text-xs ${action.destructive ? 'text-red-600' : 'text-amber-700'}`}>
            {action.destructive ? t('confirmDestructiveTitle') : t('confirmTitle')}
          </p>
        </div>
      </div>

      <PreviewFields preview={action.preview ?? action.args} />

      {resolved ? null : expired ? (
        <p className="text-sm text-slate-500">{t('actionExpired')}</p>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => resolve(true)}
            disabled={!!busy || disabled}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              action.destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-primary hover:bg-brand-primary-dark'
            }`}
          >
            {busy === 'confirm' && <Loader2 size={14} className="animate-spin" />}
            {t('confirm')}
          </button>
          <button
            onClick={() => resolve(false)}
            disabled={!!busy || disabled}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy === 'reject' && <Loader2 size={14} className="animate-spin" />}
            {t('reject')}
          </button>
        </div>
      )}
    </div>
  );
}
