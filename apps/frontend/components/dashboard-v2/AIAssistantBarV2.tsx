'use client';

import React, { useState } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

export default function AIAssistantBarV2() {
  const [query, setQuery] = useState('');
  const t = useTranslations('dashboardV2.ai');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      window.dispatchEvent(new CustomEvent('open-chatbot', { detail: { query } }));
      setQuery('');
    }
  };

  return (
    <form 
      onSubmit={handleSubmit}
      className="relative flex items-center bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-100 rounded-xl p-2.5 shadow-sm hover:shadow transition-all duration-200 w-full"
    >
      {/* Icon with animated glow */}
      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center text-white shrink-0 shadow-md shadow-purple-500/20">
        <Sparkles size={14} className="animate-pulse" />
      </div>

      {/* Label and Input */}
      <div className="flex-1 ml-3 flex items-center gap-2">
        <span className="text-[10px] font-black uppercase text-purple-700 tracking-wider select-none hidden sm:inline">
          {t('label')}
        </span>
        <span className="text-slate-300 hidden sm:inline select-none">|</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('placeholder')}
          className="w-full bg-transparent border-none outline-none text-slate-700 placeholder-slate-400 font-medium text-xs py-0.5"
        />
      </div>

      {/* Submit button */}
      <button 
        type="submit"
        className="w-7 h-7 rounded-lg bg-white border border-purple-100 text-purple-600 hover:bg-purple-600 hover:text-white flex items-center justify-center shadow-sm hover:shadow active:scale-95 transition-all duration-200 cursor-pointer"
      >
        <ArrowRight size={13} strokeWidth={2.5} className="rtl:-scale-x-100" />
      </button>
    </form>
  );
}
