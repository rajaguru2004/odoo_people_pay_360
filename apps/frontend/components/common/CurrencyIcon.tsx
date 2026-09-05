import React from 'react';
import { IndianRupee, DollarSign, Euro, PoundSterling, Banknote, LucideProps } from 'lucide-react';
import { getCurrencyCode } from '@/utils/formatters';

export interface CurrencyIconProps extends LucideProps {
  currency?: string;
  variant?: 'dynamic' | 'standard';
}

export const CurrencyIcon: React.FC<CurrencyIconProps> = ({
  currency,
  variant = 'dynamic',
  ...props
}) => {
  if (variant === 'standard') {
    return <Banknote {...props} />;
  }

  // No hardcoded fallback currency. The previous `|| 'INR'` meant an
  // unconfigured tenant — or any render before system settings finish loading —
  // showed the Indian rupee regardless of where the deployment is. A generic
  // banknote is correct for "currency not known yet"; only an explicitly
  // configured currency earns its own glyph.
  const code = (currency || getCurrencyCode() || '').toUpperCase();

  switch (code) {
    case 'INR':
      return <IndianRupee {...props} />;
    case 'USD':
      return <DollarSign {...props} />;
    case 'EUR':
      return <Euro {...props} />;
    case 'GBP':
      return <PoundSterling {...props} />;
    // OMR, AED, SAR and the rest have no dedicated lucide glyph — the generic
    // note is the honest render, not a substitute symbol.
    default:
      return <Banknote {...props} />;
  }
};

export default CurrencyIcon;
