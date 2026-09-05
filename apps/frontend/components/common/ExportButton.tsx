'use client';

import { useState } from 'react';
import { Download, Loader2, CheckCircle } from 'lucide-react';

interface ExportButtonProps {
  onExport: () => Promise<void>;
  label?: string;
  /** Lets each screen give its export control a stable selector. */
  testId?: string;
  className?: string;
  disabled?: boolean;
}

export default function ExportButton({ 
  onExport, 
  label = 'Export', 
  testId,
  className = '',
  disabled = false 
}: ExportButtonProps) {
  const [exporting, setExporting] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleExport = async () => {
    try {
      setExporting(true);
      await onExport();
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      setExporting(false);
    }
  };

  return (
    <button
      data-testid={testId}
      onClick={handleExport}
      disabled={disabled || exporting}
      className={`
        flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all
        ${success 
          ? 'bg-status-success text-white border-2 border-status-success' 
          : 'border-2 border-surface-border text-text-body hover:bg-status-success-bg hover:border-status-success/30 hover:text-status-success'
        }
        disabled:opacity-50 disabled:cursor-not-allowed
        ${className}
      `}
    >
      {exporting ? (
        <>
          <Loader2 className="animate-spin" size={18} />
          <span className="hidden sm:inline">Exporting...</span> </> ) : success ? ( <> <CheckCircle size={18} /> <span className="hidden sm:inline">Done!</span> </> ) : ( <> <Download size={18} /> <span className="hidden sm:inline">{label}</span>
        </>
      )}
    </button>
  );
}
