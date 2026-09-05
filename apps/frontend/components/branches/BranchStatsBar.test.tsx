import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import BranchStatsBar from './BranchStatsBar';

describe('BranchStatsBar', () => {
  it('prints the four figures the list is read against', () => {
    renderWithProviders(
      <BranchStatsBar stats={{ total: 3, active: 2, geofenced: 1, employees: 20 }} />,
    );

    expect(screen.getByTestId('branch-stat-total')).toHaveTextContent('3');
    expect(screen.getByTestId('branch-stat-active')).toHaveTextContent('2');
    expect(screen.getByTestId('branch-stat-geofenced')).toHaveTextContent('1');
    expect(screen.getByTestId('branch-stat-employees')).toHaveTextContent('20');
  });

  it('says what "geofenced" is counting, so the figure is not read as intent', () => {
    renderWithProviders(
      <BranchStatsBar stats={{ total: 0, active: 0, geofenced: 0, employees: 0 }} />,
    );

    expect(screen.getByText('Fence has a centre and a radius')).toBeInTheDocument();
  });
});
