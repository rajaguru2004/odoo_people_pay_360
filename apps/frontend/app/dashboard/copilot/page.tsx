'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, Award } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';
import ConversationList from '@/components/copilot/ConversationList';
import CopilotChat from '@/components/copilot/CopilotChat';
import copilotService from '@/services/copilotService';
import { ConversationSummary } from '@/types/copilot';

export default function CopilotPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER'] as any}>
      <CopilotPageInner />
    </ProtectedRoute>
  );
}

function CopilotPageInner() {
  const t = useTranslations('copilot');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Bumped only on explicit new-chat / select — this is the chat's remount key,
  // so an auto-assigned conversation id never reloads the open transcript.
  const [sessionKey, setSessionKey] = useState(0);

  const openConversation = useCallback((id: string | null) => {
    setActiveId(id);
    setSessionKey((k) => k + 1);
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const res = await copilotService.getConversations();
      setConversations(res.data);
    } catch {
      // list failures are non-fatal for the chat itself
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const handleDelete = async (id: string) => {
    try {
      await copilotService.deleteConversation(id);
      if (activeId === id) openConversation(null);
      void refreshList();
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to delete conversation');
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      {/* Cross-link only — the title/subtitle live in the sticky TopHeader,
          declared via usePageHeader above. */}
      <div className="mb-4">
        <PageActionRow
          action={
            <Link
              href="/dashboard/appraisal"
              className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-slate-900 to-indigo-900 px-4 py-2.5 text-sm font-semibold text-white shadow-md transition hover:shadow-lg"
            >
              <Award size={16} className="text-amber-300" />
              AI Appraisal & Rankings
              <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          }
        />
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <aside className="hidden w-64 shrink-0 rounded-2xl border border-slate-200 bg-white p-3 md:block">
          <ConversationList
            conversations={conversations}
            activeId={activeId}
            loading={loadingList}
            onSelect={openConversation}
            onNew={() => openConversation(null)}
            onDelete={handleDelete}
          />
        </aside>

        <main className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/50">
          <CopilotChat
            key={sessionKey}
            initialConversationId={activeId}
            onConversationChanged={(id) => {
              // Sidebar highlight + list refresh only — no remount (key unchanged).
              setActiveId(id);
              void refreshList();
            }}
            onTitle={(id, title) =>
              setConversations((prev) => {
                const exists = prev.some((c) => c.id === id);
                return exists
                  ? prev.map((c) => (c.id === id ? { ...c, title } : c))
                  : [{ id, title, updatedAt: new Date().toISOString(), lastMessagePreview: null }, ...prev];
              })
            }
          />
        </main>
      </div>
    </div>
  );
}
