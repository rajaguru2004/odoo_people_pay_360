'use client';

import dynamic from 'next/dynamic';
import { Bot, User } from 'lucide-react';
import { ChatItem } from '@/types/copilot';

// Markdown preview uses `window`; client-side only.
const Markdown: any = dynamic(
  () => import('@uiw/react-md-editor').then((m) => (m.default as any).Markdown),
  { ssr: false },
);
import '@uiw/react-md-editor/markdown-editor.css';

function ThinkingLine({ status }: { status: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <span className="flex gap-1">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-primary/70 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-primary/70 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-primary/70" />
      </span>
      <span className="animate-pulse">{status}</span>
    </div>
  );
}

export default function MessageBubble({ item }: { item: ChatItem }) {
  const isUser = item.role === 'user';
  const showThinking = !isUser && item.streaming && !item.content && !!item.status;

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          isUser ? 'bg-brand-primary text-white' : 'bg-slate-100 text-slate-600'
        }`}
      >
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
          isUser
            ? 'bg-brand-primary text-white rounded-tr-sm'
            : item.error
            ? 'border border-red-200 bg-red-50 text-red-800 rounded-tl-sm'
            : 'border border-slate-200 bg-white text-slate-800 rounded-tl-sm'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{item.content}</p>
        ) : showThinking ? (
          <ThinkingLine status={item.status!} />
        ) : (
          <div data-color-mode="light" className="copilot-markdown">
            <Markdown source={item.content} style={{ background: 'transparent', fontSize: '0.875rem' }} />
            {item.streaming && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-brand-primary/60" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
