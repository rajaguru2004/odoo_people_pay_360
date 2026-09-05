'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import copilotService from '@/services/copilotService';
import { friendlyToolStatus, streamCopilotChat, THINKING_PHRASES } from '@/services/copilotStream';
import {
  ChatItem,
  ConversationDetail,
  CopilotStreamEvent,
  CopilotTurn,
  PendingAction,
} from '@/types/copilot';
import ConfirmActionCard from './ConfirmActionCard';
import MessageBubble from './MessageBubble';
import { ChatSkeleton } from './Skeleton';

interface Props {
  /** Conversation to open on mount. The chat then owns its id internally, so a
   *  new chat getting its server id never remounts / reloads the transcript. */
  initialConversationId: string | null;
  onConversationChanged: (id: string) => void;
  onTitle?: (id: string, title: string) => void;
}

let uid = 0;
const nextId = () => `local-${++uid}`;

export default function CopilotChat({
  initialConversationId,
  onConversationChanged,
  onTitle,
}: Props) {
  const t = useTranslations('copilot');
  const [items, setItems] = useState<ChatItem[]>([]);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // The live conversation id (starts from the prop; set once a new chat is created).
  const conversationIdRef = useRef<string | null>(initialConversationId);
  const boundIdRef = useRef<string | null>(initialConversationId);

  /** Adopt a server-assigned conversation id and notify the sidebar ONCE — the
   *  parent updates the list/highlight in place, it must not remount this chat. */
  const bindConversation = useCallback(
    (id: string) => {
      conversationIdRef.current = id;
      if (boundIdRef.current === id) return;
      boundIdRef.current = id;
      onConversationChanged(id);
    },
    [onConversationChanged],
  );

  const streamIdRef = useRef<string | null>(null);
  const modeRef = useRef<'thinking' | 'tool' | 'writing'>('thinking');

  const suggestions = [t('suggestion1'), t('suggestion2'), t('suggestion3'), t('suggestion4')];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, pending, busy]);

  // Rotate the "thinking" phrase while the model works and hasn't started writing.
  useEffect(() => {
    if (!busy) return;
    let i = 0;
    const timer = setInterval(() => {
      if (modeRef.current !== 'thinking') return;
      i = (i + 1) % THINKING_PHRASES.length;
      patchStream({ status: `${THINKING_PHRASES[i]}…` });
    }, 1900);
    return () => clearInterval(timer);
  }, [busy]);

  // Load the transcript ONCE on mount. The parent gives this component a fresh
  // `key` when the user picks a different conversation (or starts a new chat),
  // so mount-only loading is correct — and the auto id-assignment after the
  // first message no longer triggers a reload.
  useEffect(() => {
    let cancelled = false;
    const id = initialConversationId;
    if (!id) {
      setItems([]);
      setPending([]);
      return;
    }
    setLoadingConversation(true);
    copilotService
      .getConversation(id)
      .then((res) => {
        if (cancelled) return;
        setItems(rebuildItems(res.data));
        setPending(res.data.pendingActions ?? []);
      })
      .catch((e: any) => toast.error(e?.message ?? 'Failed to load conversation'))
      .finally(() => !cancelled && setLoadingConversation(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchStream = (patch: Partial<ChatItem>) => {
    const id = streamIdRef.current;
    if (!id) return;
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };
  const appendStreamText = (text: string) => {
    const id = streamIdRef.current;
    if (!id) return;
    setItems((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, content: (it.content || '') + text, status: undefined } : it,
      ),
    );
  };

  const handleEvent = useCallback(
    (ev: CopilotStreamEvent) => {
      switch (ev.type) {
        case 'status':
          modeRef.current = 'thinking';
          patchStream({ status: `${THINKING_PHRASES[0]}…` });
          break;
        case 'tool_call':
          if (ev.phase === 'started' && ev.tool) {
            modeRef.current = 'tool';
            patchStream({ status: friendlyToolStatus(ev.tool) });
          }
          break;
        case 'delta':
          modeRef.current = 'writing';
          if (ev.text) appendStreamText(ev.text);
          break;
        case 'pending_actions':
          modeRef.current = 'writing';
          patchStream({
            content: ev.message || t('needsConfirmation'),
            status: undefined,
            streaming: false,
          });
          setPending(ev.pendingActions ?? []);
          if (ev.conversationId) bindConversation(ev.conversationId);
          break;
        case 'final':
          // The final message is authoritative — replace any streamed partial.
          patchStream({ content: ev.message || '', status: undefined, streaming: false });
          if (ev.conversationId) bindConversation(ev.conversationId);
          break;
        case 'error':
          patchStream({ content: ev.message || t('genericError'), error: true, status: undefined, streaming: false });
          break;
        case 'title':
          // Live sidebar title update — no reload.
          if (ev.conversationId && ev.title) onTitle?.(ev.conversationId, ev.title);
          break;
      }
    },
    [bindConversation, onTitle, t],
  );

  const send = async (text?: string) => {
    const message = (text ?? input).trim();
    if (!message || busy || pending.length > 0) return;
    setInput('');
    const streamId = nextId();
    streamIdRef.current = streamId;
    modeRef.current = 'thinking';
    setItems((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: message },
      { id: streamId, role: 'assistant', content: '', streaming: true, status: `${THINKING_PHRASES[0]}…` },
    ]);
    setBusy(true);
    try {
      await streamCopilotChat(
        { message, conversationId: conversationIdRef.current ?? undefined },
        handleEvent,
      );
    } catch (e: any) {
      patchStream({
        content: e?.message ?? t('genericError'),
        error: true,
        status: undefined,
        streaming: false,
      });
    } finally {
      // Ensure the bubble is never left in a spinning state.
      patchStream({ streaming: false, status: undefined });
      streamIdRef.current = null;
      setBusy(false);
    }
  };

  const onResolve = (turn: CopilotTurn) => {
    setPending(turn.pendingActions ?? []);
    setItems((prev) => [
      ...prev,
      {
        id: nextId(),
        role: 'assistant',
        content: turn.message || (turn.type === 'pending_actions' ? t('needsConfirmation') : ''),
      },
    ]);
    bindConversation(turn.conversationId);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {items.length === 0 && !loadingConversation && (
          <div className="mx-auto mt-16 max-w-md text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-primary/10 text-brand-primary">
              <Sparkles size={22} />
            </div>
            <h2 className="text-lg font-semibold text-slate-800">{t('title')}</h2>
            <p className="mb-6 mt-1 text-sm text-slate-500">{t('intro')}</p>
            <div className="grid gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-left text-sm text-slate-700 hover:border-brand-primary/40 hover:bg-brand-primary/5"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {loadingConversation && items.length === 0 && <ChatSkeleton />}

        {items.map((item) => (
          <MessageBubble key={item.id} item={item} />
        ))}

        {pending.map((action) => (
          <div key={action.actionId} className="ml-11 max-w-[80%]">
            <ConfirmActionCard action={action} disabled={busy} onResolve={onResolve} />
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-slate-200 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={pending.length > 0 ? t('resolvePendingFirst') : t('inputPlaceholder')}
            disabled={busy || pending.length > 0}
            className="max-h-32 flex-1 resize-none rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-brand-primary disabled:bg-slate-50"
          />
          <button
            onClick={() => send()}
            disabled={busy || pending.length > 0 || !input.trim()}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-primary text-white hover:bg-brand-primary-dark disabled:opacity-40"
            aria-label="send"
          >
            <Send size={16} />
          </button>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-slate-400">{t('disclaimer')}</p>
      </div>
    </div>
  );
}

/** Rebuild chat bubbles from a persisted transcript (tool rows are folded away). */
function rebuildItems(detail: ConversationDetail): ChatItem[] {
  const out: ChatItem[] = [];
  for (const m of detail.messages) {
    if (m.role === 'user') {
      out.push({ id: m.id, role: 'user', content: m.content ?? '' });
    } else if (m.role === 'assistant' && m.content?.trim()) {
      out.push({ id: m.id, role: 'assistant', content: m.content });
    }
  }
  return out;
}
