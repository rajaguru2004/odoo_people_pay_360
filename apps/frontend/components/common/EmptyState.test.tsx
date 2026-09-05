import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import EmptyState from './EmptyState';

describe('EmptyState', () => {
  it('offers the next step, at a thumb-sized target', async () => {
    // On a phone the empty state is the whole screen. A grey sentence with no
    // action is 650px of dead end.
    const onClick = vi.fn();
    const { user } = renderWithProviders(
      <EmptyState
        title="No leave requests yet"
        hint="Your filed requests will appear here."
        action={{ label: 'Request leave', onClick, testId: 'leave-new' }}
        testId="leave-empty"
      />,
    );

    const button = screen.getByTestId('leave-new');
    expect(button).toHaveClass('h-12');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('distinguishes "nothing here" from "we could not load it"', () => {
    // Rendering a failed request as an empty list tells the reader their
    // records are gone. The tone is carried in the DOM so a spec can tell.
    const { unmount } = renderWithProviders(<EmptyState title="No rows" testId="s" />);
    expect(screen.getByTestId('s')).toHaveAttribute('data-tone', 'empty');
    unmount();

    renderWithProviders(<EmptyState tone="error" title="Could not load" testId="s" />);
    expect(screen.getByTestId('s')).toHaveAttribute('data-tone', 'error');
  });

  it('renders without an action or a hint', () => {
    renderWithProviders(<EmptyState title="No rows" testId="s" />);
    expect(screen.getByTestId('s')).toHaveTextContent('No rows');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
