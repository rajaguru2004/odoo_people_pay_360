'use client';

import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  type LucideProps,
} from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * Wraps a directional lucide icon so it mirrors under dir="rtl" via the same
 * CSS variant (`rtl:`) already used for the logical-property layout migration
 * — one mechanism for all of RTL, not a separate JS branch per icon.
 */
function mirror(Base: React.ComponentType<LucideProps>) {
  return function Mirrored({ className, ...props }: LucideProps) {
    return <Base className={cn('rtl:-scale-x-100', className)} {...props} />;
  };
}

export const ArrowLeftIcon = mirror(ArrowLeft);
export const ArrowRightIcon = mirror(ArrowRight);
export const ChevronLeftIcon = mirror(ChevronLeft);
export const ChevronRightIcon = mirror(ChevronRight);
export const ChevronsLeftIcon = mirror(ChevronsLeft);
export const ChevronsRightIcon = mirror(ChevronsRight);
