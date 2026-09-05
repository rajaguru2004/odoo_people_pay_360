import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import DepartmentStatsBar from './DepartmentStatsBar';

describe('DepartmentStatsBar', () => {
  it('prints the four figures the list is read against', () => {
    renderWithProviders(
      <DepartmentStatsBar stats={{ total: 7, topLevel: 1, headless: 1, people: 20 }} />,
    );

    expect(screen.getByTestId('department-stat-total')).toHaveTextContent('7');
    expect(screen.getByTestId('department-stat-top-level')).toHaveTextContent('1');
    expect(screen.getByTestId('department-stat-headless')).toHaveTextContent('1');
    expect(screen.getByTestId('department-stat-people')).toHaveTextContent('20');
  });

  it('says why a unit without a head matters, rather than leaving a bare count', () => {
    renderWithProviders(
      <DepartmentStatsBar stats={{ total: 0, topLevel: 0, headless: 0, people: 0 }} />,
    );

    expect(screen.getByText('Nothing routed here has an approver')).toBeInTheDocument();
  });
});
