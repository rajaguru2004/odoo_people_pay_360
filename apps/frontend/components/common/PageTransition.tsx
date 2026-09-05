'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';

interface PageTransitionProps {
  children: React.ReactNode;
  className?: string;
  /** Custom animation key. Defaults to current pathname. */
  transitionKey?: string;
}

export default function PageTransition({
  children,
  className = '',
  transitionKey,
}: PageTransitionProps) {
  const pathname = usePathname();
  const currentKey = transitionKey ?? pathname;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={currentKey}
        initial={{ opacity: 0, y: 16, scale: 0.995 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -10, scale: 0.995 }}
        transition={{
          duration: 0.8,
          ease: [0.16, 1, 0.3, 1], // Smooth, luxurious ease-out
        }}
        className={className}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
