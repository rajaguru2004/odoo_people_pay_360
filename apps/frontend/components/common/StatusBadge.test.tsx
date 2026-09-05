import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import StatusBadge, { type StatusTone } from './StatusBadge';

describe('StatusBadge', () => {
  it('paints from tokens, never from the palette', () => {
    // A hardcoded `bg-emerald-50` survives a theme-preset change and stops
    // being the customer's brand — which is what the two badges this replaces
    // both do today.
    const tones: StatusTone[] = ['neutral', 'pending', 'success', 'info', 'warning', 'danger'];
    for (const tone of tones) {
      const { unmount } = renderWithProviders(
        <StatusBadge tone={tone} label="x" testId="b" />,
      );
      const cls = screen.getByTestId('b').className;
      expect(cls, tone).toMatch(/(status-|surface-|text-)/);
      expect(cls, tone).not.toMatch(/-(slate|emerald|red|amber|blue)-\d/);
      unmount();
    }
  });

  it('renders the label it is given, verbatim', () => {
    // It maps nothing. The domain owns its vocabulary — see the docblock for
    // the argument.
    renderWithProviders(<StatusBadge tone="danger" label="Refused" testId="b" />);
    expect(screen.getByTestId('b')).toHaveTextContent('Refused');
    expect(screen.getByTestId('b')).toHaveAttribute('data-tone', 'danger');
  });

  it('keeps the chip on one line beside a long title', () => {
    renderWithProviders(<StatusBadge tone="pending" label="Awaiting approval" testId="b" />);
    expect(screen.getByTestId('b')).toHaveClass('shrink-0', 'whitespace-nowrap');
  });
});
