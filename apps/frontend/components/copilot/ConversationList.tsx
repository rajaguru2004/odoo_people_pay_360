'use client';

import { useTranslations } from 'next-intl';
import { MessageSquarePlus, Trash2 } from 'lucide-react';
import { ConversationSummary } from '@/types/copilot';
import { ConversationListSkeleton } from './Skeleton';

interface Props {
  conversations: ConversationSummary[];
  activeId: string | null;
  loading?: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export default function ConversationList({
  conversations,
  activeId,
  loading,
  onSelect,
  onNew,
  onDelete,
}: Props) {
  const t = useTranslations('copilot');
  return (
    <div className="flex h-full flex-col">
      <button
        onClick={onNew}
        className="mb-3 inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        <MessageSquarePlus size={16} />
        {t('newChat')}
      </button>

      <div className="flex-1 space-y-1 overflow-y-auto">
        {loading && conversations.length === 0 && <ConversationListSkeleton />}
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 ${
              activeId === c.id ? 'bg-brand-primary/10' : 'hover:bg-slate-100'
            }`}
            onClick={() => onSelect(c.id)}
          >
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
              {c.title || t('untitled')}
            </p>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c.id);
              }}
              className="invisible shrink-0 text-slate-400 hover:text-red-600 group-hover:visible"
              aria-label="delete conversation"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {!loading && conversations.length === 0 && (
          <p className="px-2 py-1 text-xs text-slate-400">{t('noConversations')}</p>
        )}
      </div>
    </div>
  );
}
