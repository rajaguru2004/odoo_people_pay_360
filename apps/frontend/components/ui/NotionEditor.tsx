'use client';

import React, { useEffect, useRef } from 'react';
import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
import {
  Bold, Italic, Strikethrough, Code, Heading1, Heading2, List, ListChecks, Quote,
} from 'lucide-react';
import './NotionEditor.css';

interface NotionEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  minHeight?: number;
  editable?: boolean;
  className?: string;
}

function ToolbarButton({
  onClick, active, label, children,
}: {
  onClick: () => void;
  active: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={active ? 'is-active' : ''}
    >
      {children}
    </button>
  );
}

export default function NotionEditor({
  value,
  onChange,
  placeholder = "Write a description…  Type '#' for a heading, '-' for a list, '[]' for a checkbox",
  minHeight = 260,
  editable = true,
  className = '',
}: NotionEditorProps) {
  // Track the last markdown we emitted so external value syncs don't clobber the cursor.
  const lastEmitted = useRef<string>(value || '');

  const editor = useEditor({
    immediatelyRender: false, // required for Next.js SSR
    editable,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder }),
      Markdown.configure({
        html: false,
        tightLists: true,
        bulletListMarker: '-',
        linkify: false,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: value || '',
    editorProps: {
      attributes: {
        class: 'notion-editor-content',
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md: string = ed.storage.markdown.getMarkdown();
      lastEmitted.current = md;
      onChange(md);
    },
  });

  // Sync external value changes (e.g. reset, load) without disrupting typing.
  useEffect(() => {
    if (!editor) return;
    if (value !== lastEmitted.current) {
      lastEmitted.current = value || '';
      editor.commands.setContent(value || '', false);
    }
  }, [value, editor]);

  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editable, editor]);

  if (!editor) {
    return (
      <div
        className={`notion-editor rounded-[--radius-button] border border-surface-border bg-surface-page ${className}`}
        style={{ minHeight }}
      />
    );
  }

  return (
    <div
      className={`notion-editor rounded-[--radius-button] border border-surface-border bg-surface-page px-3 py-2 focus-within:ring-2 focus-within:ring-brand-primary/30 ${className}`}
      style={{ ['--notion-editor-min-height' as any]: `${minHeight}px` }}
    >
      <BubbleMenu editor={editor} tippyOptions={{ duration: 120 }} className="notion-bubble">
        <ToolbarButton label="Bold" active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}>
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Italic" active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}>
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Strikethrough" active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}>
          <Strikethrough className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Inline code" active={editor.isActive('code')}
          onClick={() => editor.chain().focus().toggleCode().run()}>
          <Code className="h-3.5 w-3.5" />
        </ToolbarButton>
        <span className="notion-bubble-sep" />
        <ToolbarButton label="Heading 1" active={editor.isActive('heading', { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
          <Heading1 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Heading 2" active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
          <Heading2 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <span className="notion-bubble-sep" />
        <ToolbarButton label="Bullet list" active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Checklist" active={editor.isActive('taskList')}
          onClick={() => editor.chain().focus().toggleTaskList().run()}>
          <ListChecks className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Quote" active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          <Quote className="h-3.5 w-3.5" />
        </ToolbarButton>
      </BubbleMenu>

      <EditorContent editor={editor} />
    </div>
  );
}
