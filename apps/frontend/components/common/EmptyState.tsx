import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { motion } from 'framer-motion';

export function EmptyState({
  title = 'Nothing here yet',
  description,
  icon,
  action,
  headingLevel = 3,
}: {
  title?: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  /**
   * Where this sits in the document outline. The default suits an empty state
   * inside a card on a page that already has its heading; a screen whose whole
   * content IS the empty state (the permission-denied route) passes 1, so the
   * page is not left without a top-level heading.
   */
  headingLevel?: 1 | 2 | 3;
}) {
  const Heading = `h${headingLevel}` as 'h1' | 'h2' | 'h3';

  return (
    <motion.div
      className="flex flex-col items-center justify-center px-6 py-14 text-center"
      initial={{ opacity: 0, scale: 0.99 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5 }}
    >
      <motion.span
        className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-border-light text-text-muted"
        initial={{ scale: 0.95 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.5, delay: 0.08 }}
      >
        {icon ?? <Inbox className="h-6 w-6" aria-hidden />}
      </motion.span>
      <Heading className="text-base font-semibold text-text-heading">{title}</Heading>
      {description && <p className="mt-1 max-w-sm text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </motion.div>
  );
}
