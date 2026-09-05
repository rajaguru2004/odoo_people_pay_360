import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import SystemHubPage from './page';

/**
 * The System hub, now reading `/audit-logs/stats`.
 *
 * These figures used to be counted in the browser over one page of the log, so
 * a busy day silently under-reported. The window is a real 24 hours computed in
 * the database, and these cases pin that the page renders what the server said
 * rather than re-deriving anything.
 */

vi.mock('@/lib/axios', () => ({ default: { get: vi.fn() } }));
import axiosInstance from '@/lib/axios';
const axiosGet = vi.mocked(axiosInstance.get);

const HOUR = 3_600_000;

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ hasHydrated: true });
  axiosGet.mockImplementation((url: string) => {
    if (url.includes('audit-logs/stats')) {
      return Promise.resolve({
        data: {
          windowHours: 24,
          total: 128,
          destructive: 3,
          byAction: [{ action: 'UPDATE', count: 90 }],
          byResource: [{ resource: 'Employee', count: 61 }],
          topActors: [
            { userId: 'u-hr', name: 'Asha Rahman', count: 74 },
            { userId: 'u-admin', name: 'admin@x.com', count: 30 },
          ],
        },
      }) as never;
    }
    return Promise.resolve({ data: { count: 4 } }) as never;
  });
});

describe('the system hub', () => {
  it('shows the whole day the server counted, not a page of it', async () => {
    renderWithProviders(<SystemHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Events in 24 hours')).toBeTruthy());
    // 128 events in the window — far more than any page the browser would have
    // fetched, which is the entire reason this moved server-side.
    expect(screen.getByText('128')).toBeTruthy();
    expect(screen.getByText('Aggregated over a real 24-hour window')).toBeTruthy();
  });

  it('separates the deletions out, because they are the ones that removed something', async () => {
    renderWithProviders(<SystemHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Deletions in 24 hours')).toBeTruthy());
    const card = document.querySelector('a.stat-card[href="/dashboard/audit-logs"]')!;
    expect(card).toBeTruthy();
  });

  it('ranks the busiest accounts by the name a reader recognises', async () => {
    renderWithProviders(<SystemHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Asha Rahman')).toBeTruthy());
    expect(screen.getByText('74 events')).toBeTruthy();
  });

  it('names the busiest resource type, which no count of events can show', async () => {
    renderWithProviders(<SystemHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Busiest resource')).toBeTruthy());
    expect(screen.getByText('Employee')).toBeTruthy();
    expect(screen.getByText('61 events in 24 hours')).toBeTruthy();
  });

  it('shows an em dash when the aggregate itself fails', async () => {
    axiosGet.mockImplementation((url: string) =>
      url.includes('audit-logs/stats')
        ? (Promise.reject(new Error('500')) as never)
        : (Promise.resolve({ data: { count: 0 } }) as never),
    );

    renderWithProviders(<SystemHubPage />, { role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText('Events in 24 hours')).toBeTruthy());
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  describe('when the reader may not open the audit trail', () => {
    // `audit-logs` is `@Roles('ADMIN')` on the whole controller, but this hub is
    // navigable by HR_MANAGER. HR used to load the page, fire a request that
    // could only ever be refused, and fill the console with 403s on a screen
    // that was otherwise working. The route matrix caught it; these cases stop
    // it coming back.

    it('does not ask for audit stats as HR', async () => {
      renderWithProviders(<SystemHubPage />, { role: 'HR_MANAGER' });

      await waitFor(() => expect(screen.getByText('Events in 24 hours')).toBeTruthy());
      const asked = axiosGet.mock.calls.map((c) => String(c[0]));
      expect(asked.some((u) => u.includes('audit-logs/stats'))).toBe(false);
      // The rest of the page still loads.
      expect(asked.some((u) => u.includes('notifications/unread-count'))).toBe(true);
    });

    it('leaves the audit figures blank and says why', async () => {
      // An unexplained blank card is what makes a working screen look broken.
      renderWithProviders(<SystemHubPage />, { role: 'HR_MANAGER' });

      // Wait for the KPI row itself, not just the panel: the panel text renders
      // before the cards have left their skeleton state.
      await waitFor(() => expect(screen.getByText('Events in 24 hours')).toBeTruthy());
      expect(screen.getByText('Audit activity is visible to administrators only.')).toBeTruthy();
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });

    it('still shows the notification count, which HR may read', async () => {
      renderWithProviders(<SystemHubPage />, { role: 'HR_MANAGER' });
      await waitFor(() => expect(screen.getByText('Unread notifications')).toBeTruthy());
      expect(screen.getByText('4')).toBeTruthy();
    });

    it('keeps asking as ADMIN, who may', async () => {
      // The other branch of the gate: the fix must not blind the role it is for.
      renderWithProviders(<SystemHubPage />, { role: 'ADMIN' });
      await waitFor(() => expect(screen.getByText('128')).toBeTruthy());
      expect(
        axiosGet.mock.calls.map((c) => String(c[0])).some((u) => u.includes('audit-logs/stats')),
      ).toBe(true);
      expect(screen.queryByText('Audit activity is visible to administrators only.')).toBeNull();
    });
  });
});
