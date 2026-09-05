import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '@/test/utils';
import AttentionStripSource, { buildAttentionItems } from './AttentionStripSource';
import type { AttendanceHubSummary } from '@/types/attendanceHub';

const empty = { count: 0, names: [] as string[] };

function attention(
  overrides: Partial<AttendanceHubSummary['attention']> = {},
): AttendanceHubSummary['attention'] {
  return {
    notCheckedIn: empty,
    notCheckedOut: empty,
    overScheduledHours: empty,
    pendingCorrections: 0,
    absent: empty,
    late: empty,
    ...overrides,
  };
}

describe('AttentionStripSource', () => {
  it('says how many are not named when the count outruns the sample', async () => {
    // `names` is a sample and `count` is the truth. Printing three names beside
    // a bucket of nineteen tells the reader the list is the whole problem.
    const user = userEvent.setup();
    renderWithProviders(
      <AttentionStripSource
        attention={attention({
          notCheckedIn: { count: 19, names: ['Aisha Al Balushi', 'Omar Al Harthy', 'Salim Al Rawahi'] },
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /show what needs attention/i }));

    expect(screen.getByText('19 not checked in')).toBeInTheDocument();
    expect(screen.getByText(/and 16 more/)).toBeInTheDocument();
  });

  it('does not imply there are more when the sample IS the set', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AttentionStripSource
        attention={attention({ late: { count: 2, names: ['Aisha Al Balushi', 'Omar Al Harthy'] } })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /show what needs attention/i }));

    expect(screen.getByText('Aisha Al Balushi, Omar Al Harthy')).toBeInTheDocument();
    expect(screen.queryByText(/more/)).toBeNull();
  });

  it('says nothing needs chasing rather than listing empty buckets', () => {
    renderWithProviders(<AttentionStripSource attention={attention()} />);
    expect(screen.getByText('Nothing is waiting on anybody right now.')).toBeInTheDocument();
  });
});

describe('buildAttentionItems', () => {
  it('drops a bucket with nobody in it', () => {
    // "0 people have not checked in" is not a task.
    const items = buildAttentionItems(attention({ absent: { count: 3, names: ['Salim'] } }));
    expect(items.map((i) => i.key)).toEqual(['absent']);
  });

  it('escalates a correction queue that has been waiting', () => {
    const fresh = buildAttentionItems(attention({ pendingCorrections: 2 }), {
      oldestCorrectionDays: 1,
    });
    expect(fresh[0].severity).toBe('warning');

    const stale = buildAttentionItems(attention({ pendingCorrections: 2 }), {
      oldestCorrectionDays: 5,
    });
    expect(stale[0].severity).toBe('critical');
    expect(stale[0].detail).toBe('oldest 5 days old');
  });

  it('returns nothing at all before the hub payload arrives', () => {
    expect(buildAttentionItems(undefined)).toEqual([]);
  });
});
