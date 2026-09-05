import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import ContractStatsBar from './ContractStatsBar';

describe('ContractStatsBar', () => {
  it('prints the four figures the list is read against', () => {
    renderWithProviders(
      <ContractStatsBar
        stats={{ total: 24, active: 18, expiringSoon: 3, expired: 2 }}
        expiryWindowDays={30}
      />,
    );

    expect(screen.getByTestId('contract-stat-total')).toHaveTextContent('24');
    expect(screen.getByTestId('contract-stat-active')).toHaveTextContent('18');
    expect(screen.getByTestId('contract-stat-expiring')).toHaveTextContent('3');
    expect(screen.getByTestId('contract-stat-expired')).toHaveTextContent('2');
  });

  it('renders an em dash while a count is unknown, never a zero', () => {
    // A 0 here says "none expiring", which is a very different thing to tell
    // an HR officer than "the count has not come back yet".
    renderWithProviders(<ContractStatsBar stats={{}} expiryWindowDays={30} />);

    expect(screen.getByTestId('contract-stat-expiring')).toHaveTextContent('—');
    expect(screen.getByTestId('contract-stat-total')).toHaveTextContent('—');
  });

  it('names the window the expiry figure was counted over', () => {
    renderWithProviders(<ContractStatsBar stats={{}} expiryWindowDays={60} />);

    expect(screen.getByText('Active, ending within 60 days')).toBeInTheDocument();
  });
});
