'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { onPermissionError } from '@/lib/permissionError';
import { Button } from './Button';

/**
 * One modal, mounted at the root, driven by the axios interceptor.
 *
 * A 403 can come from any request on any screen, so the alternative is every
 * screen handling it — which means most of them silently would not, and the
 * user would see a control that simply does nothing.
 */
export default function PermissionDeniedModal() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => onPermissionError((m) => setMessage(m || 'You do not have permission to do that.')), []);

  if (!message) return null;

  return (
    <AnimatePresence>
      {message && (
        <motion.div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="permission-denied-title"
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45 }}
        >
          <motion.div
            className="w-full max-w-sm rounded-[var(--radius-card)] bg-surface-overlay p-6 shadow-2xl"
            initial={{ scale: 0.99, opacity: 0, y: 3 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.99, opacity: 0, y: 3 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            <div className="mb-3 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-status-error-bg">
                <ShieldAlert className="h-5 w-5 text-status-error" aria-hidden />
              </span>
              <h2 id="permission-denied-title" className="text-lg font-semibold text-text-heading">
                Access denied
              </h2>
            </div>
            <p className="mb-5 text-sm text-text-body">{message}</p>
            <Button className="w-full" onClick={() => setMessage(null)}>
              Close
            </Button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
