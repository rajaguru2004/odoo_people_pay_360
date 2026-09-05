'use client';

import React, { useEffect, useState } from 'react';
import { MessageSquare, Send, Loader2, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import taskService from '@/services/taskService';
import { useAuthStore } from '@/store/authStore';
import { formatDateTime } from '@/utils/formatters';

export default function TaskComments({ taskId }: { taskId: string }) {
  const t = useTranslations('taskComments');
  const { user } = useAuthStore();
  const [comments, setComments] = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [text,     setText]     = useState('');
  const [posting,  setPosting]  = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = (await taskService.getComments(taskId)) as any;
      setComments(res.data || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [taskId]);

  const post = async () => {
    if (!text.trim()) return;
    setPosting(true);
    try {
      await taskService.addComment(taskId, text);
      setText('');
      await load();
    } finally { setPosting(false); }
  };

  const del = async (id: string) => { await taskService.deleteComment(id); await load(); };

  return (
    <div>
      {/* Section header */}
      <div className="mb-4 flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-brand-primary" />
        <h3 className="text-sm font-semibold text-text-heading">
          {t('heading')}
          {comments.length > 0 && (
            <span className="ms-1.5 text-text-muted">{t('countBadge', { count: comments.length })}</span>
          )}
        </h3>
      </div>

      {/* Comment list */}
      {loading ? (
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-text-muted" />
      ) : (
        <div className="mb-4 space-y-3">
          {comments.map((c) => {
            const name = c.user?.employee?.fullName || c.user?.email || t('fallbackUser');
            const mine = c.userId === user?.id || c.user?.id === user?.id;
            return (
              <div key={c.id} data-testid={`comment-row-${c.id}`} className="flex gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-primary/20 text-xs font-semibold text-brand-primary">
                  {name.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 rounded-[--radius-button] bg-surface-page px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-body">{name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted">
                        {formatDateTime(c.createdAt)}
                      </span>
                      {mine && (
                        <button onClick={() => del(c.id)} data-testid={`comment-delete-${c.id}`} className="text-text-muted hover:text-status-error">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-text-body">{c.comment}</p>
                </div>
              </div>
            );
          })}
          {comments.length === 0 && (
            <p data-testid="comment-empty" className="text-sm text-text-muted">{t('emptyNoComments')}</p>
          )}
        </div>
      )}

      {/* Comment input */}
      <div className="space-y-2">
        <textarea
          value={text}
          data-testid="comment-input"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post(); }}
          rows={3}
          placeholder={t('placeholder')}
          className="w-full resize-none rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2.5 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-text-muted">{t('helperCtrlEnter')}</p>
          <button
            onClick={post} disabled={posting || !text.trim()}
            data-testid="comment-submit"
            className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-60">
            {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {t('addCommentBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}
