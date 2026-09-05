import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useConfirm } from './useConfirm';

/**
 * The promise-based confirm dialog.
 *
 * The single most widely shared interactive primitive in this app — more than
 * twenty screens await it before deleting a record, locking a payroll run or
 * approving a request. Its contract is unusual enough to be worth pinning:
 *
 *   - `confirm()` returns a promise that resolves TRUE or FALSE, so a caller
 *     can `if (!(await confirm(...))) return;` and read like ordinary code.
 *   - confirming does NOT close the dialog. The caller closes it once its own
 *     async work is done, which is what keeps the spinner on screen instead of
 *     flashing the dialog away while a request is still in flight.
 *
 * A regression that resolved the promise the wrong way round would silently
 * turn "Cancel" into "Delete" across every one of those screens.
 */

/** A screen that guards an action behind the dialog, as the real ones do. */
function Harness({ onResult }: { onResult?: (v: boolean) => void }) {
  const { confirm, ConfirmDialog, closeModal } = useConfirm();
  const [outcome, setOutcome] = useState<string>('none');

  const run = async () => {
    const ok = await confirm({
      title: 'Delete employee',
      message: 'This cannot be undone.',
      confirmText: 'Delete',
      cancelText: 'Keep',
      type: 'danger',
    });
    onResult?.(ok);
    setOutcome(ok ? 'confirmed' : 'cancelled');
    // The caller owns closing — see the note above.
    closeModal();
  };

  return (
    <div>
      <button type="button" onClick={run}>
        act
      </button>
      <span data-testid="outcome">{outcome}</span>
      <ConfirmDialog />
    </div>
  );
}

const openDialog = async (user: ReturnType<typeof renderWithProviders>['user']) => {
  await user.click(screen.getByRole('button', { name: 'act' }));
  await waitFor(() => expect(screen.getByText('Delete employee')).toBeInTheDocument());
};

describe('opening', () => {
  it('is closed until something asks for it', () => {
    renderWithProviders(<Harness />);
    expect(screen.queryByText('Delete employee')).not.toBeInTheDocument();
  });

  it('shows the title and message it was given', async () => {
    const { user } = renderWithProviders(<Harness />);
    await openDialog(user);

    expect(screen.getByText('Delete employee')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('uses the supplied button labels', async () => {
    // Callers pass their own wording — "Delete", "Lock", "Approve" — and a
    // generic fallback would make every destructive dialog read alike.
    const { user } = renderWithProviders(<Harness />);
    await openDialog(user);

    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
  });
});

describe('the promise', () => {
  it('resolves true when confirmed', async () => {
    const onResult = vi.fn();
    const { user } = renderWithProviders(<Harness onResult={onResult} />);

    await openDialog(user);
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(screen.getByTestId('outcome')).toHaveTextContent('confirmed');
  });

  it('resolves false when cancelled', async () => {
    // The direction that matters: getting this backwards would delete records
    // whenever a user declined.
    const onResult = vi.fn();
    const { user } = renderWithProviders(<Harness onResult={onResult} />);

    await openDialog(user);
    await user.click(screen.getByRole('button', { name: 'Keep' }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
    expect(screen.getByTestId('outcome')).toHaveTextContent('cancelled');
  });

  it('resolves exactly once per prompt', async () => {
    const onResult = vi.fn();
    const { user } = renderWithProviders(<Harness onResult={onResult} />);

    await openDialog(user);
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
  });

  it('closes on cancel without waiting for the caller', async () => {
    // Cancelling has no async work behind it, so the dialog goes at once.
    const { user } = renderWithProviders(<Harness />);

    await openDialog(user);
    await user.click(screen.getByRole('button', { name: 'Keep' }));

    await waitFor(() => expect(screen.queryByText('Delete employee')).not.toBeInTheDocument());
  });
});

describe('reuse', () => {
  it('can be asked again after a decision', async () => {
    // Screens call `confirm()` per row, so a dialog that only works once would
    // strand every subsequent action.
    const onResult = vi.fn();
    const { user } = renderWithProviders(<Harness onResult={onResult} />);

    await openDialog(user);
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));

    await openDialog(user);
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(true));
    expect(onResult).toHaveBeenCalledTimes(2);
  });
});

describe('the confirm button stays addressable', () => {
  it('carries the test id the browser journeys select on', async () => {
    // Every destructive-action journey drives this dialog. Without a stable
    // handle they would have to match translated button text, which breaks the
    // moment the suite runs in Arabic.
    const { user } = renderWithProviders(<Harness />);
    await openDialog(user);

    expect(screen.getByTestId('confirm-modal-confirm')).toBeInTheDocument();
  });
});
