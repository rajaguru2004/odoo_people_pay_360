import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** clsx for conditionals, tailwind-merge so a later class actually wins. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
