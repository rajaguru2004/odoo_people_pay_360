import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import Sheet from './Sheet';

/**
 * The overlay primitive.
 *
 * The cases worth pinning are the ones that are invisible in a screenshot and
 * that 33 pages would otherwise each get wrong: WHERE it renders (body, not
 * in place), WHAT it locks (`<main>`, not `<body>`), and that a backdrop press
 * which began inside the panel does not throw the reader's work away.
 */

/**
 * The shell `Sheet` expects: a page whose scroll container is `<main>`.
 * Recreated here because jsdom has no `DashboardLayout` around the component.
 */
function mountShell(): HTMLElement {
  const main = document.createElement('main');
  document.body.appendChild(main);
  return main;
}

let main: HTMLElement;

beforeEach(() => {
  main = mountShell();
});

afterEach(() => {
  main.remove();
});

const open = (props: Partial<React.ComponentProps<typeof Sheet>> = {}) =>
  renderWithProviders(
    <Sheet open onClose={vi.fn()} title="Request leave" testId="leave-sheet" {...props}>
      <p>body</p>
    </Sheet>,
    { role: 'EMPLOYEE' },
  );

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    renderWithProviders(
      <Sheet open={false} onClose={vi.fn()} title="Request leave" testId="leave-sheet">
        <p>body</p>
      </Sheet>,
      { role: 'EMPLOYEE' },
    );
    expect(screen.queryByTestId('leave-sheet')).not.toBeInTheDocument();
  });

  it('portals to document.body rather than rendering in place', () => {
    // A `motion` ancestor writes `transform`, which becomes the containing
    // block for `position: fixed` descendants — a sheet rendered in place would
    // position against the animated card instead of the viewport.
    const { container } = open();
    expect(container).toBeEmptyDOMElement();
    expect(document.body).toContainElement(screen.getByTestId('leave-sheet'));
  });

  it('is an accessible dialog named by its title', () => {
    open();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Request leave');
  });

  it('locks <main>, not <body>, and restores it on close', () => {
    // The usual body lock is a NO-OP in this shell: DashboardLayout already
    // sets overflow:hidden on the page shell and scrolls an inner <main>.
    main.style.overflow = 'auto';
    const { unmount } = open();

    expect(main.style.overflow).toBe('hidden');
    unmount();
    expect(main.style.overflow).toBe('auto');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop press', () => {
    const onClose = vi.fn();
    open({ onClose });
    // The backdrop is the dialog's parent — the element the panel is centred in.
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on a press that began inside the panel', () => {
    // A drag off a slider, or a text selection that ends on the backdrop,
    // must not discard a half-filled form.
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('traps Tab inside the panel', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <Sheet
        open
        onClose={onClose}
        title="Request leave"
        testId="leave-sheet"
        footer={<button data-testid="submit">Submit</button>}
      >
        <input data-testid="reason" />
      </Sheet>,
      { role: 'EMPLOYEE' },
    );

    const last = screen.getByTestId('submit');
    last.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    // Wraps to the first focusable — the close button in the header.
    expect(document.activeElement).toBe(screen.getByTestId('leave-sheet-close'));
  });

  it('offers a 44px close button, and can be told not to', () => {
    const { unmount } = open();
    expect(screen.getByTestId('leave-sheet-close')).toHaveClass('h-11', 'w-11');
    unmount();

    open({ hideClose: true });
    expect(screen.queryByTestId('leave-sheet-close')).not.toBeInTheDocument();
  });

  it('is a bottom sheet on a phone and a centred dialog above md', () => {
    // The whole mobile/desktop difference, asserted as classes because jsdom
    // has no layout: `items-end` + `md:items-center` on the backdrop, and a
    // top-only radius that squares off at md.
    open();
    const backdrop = screen.getByRole('dialog').parentElement!;
    expect(backdrop).toHaveClass('items-end', 'md:items-center');

    const panel = screen.getByTestId('leave-sheet');
    expect(panel).toHaveClass('rounded-t-2xl', 'md:rounded-2xl', 'md:max-w-md');
  });

  it('moves up one z-rung when nested', () => {
    const { unmount } = open();
    expect(screen.getByRole('dialog').parentElement).toHaveClass('z-[60]');
    unmount();

    open({ nested: true });
    expect(screen.getByRole('dialog').parentElement).toHaveClass('z-[70]');
  });

  it('keeps footer children as direct children of the footer', () => {
    // LOAD-BEARING. A spec reaches the confirm dialog's panel by walking two
    // ancestors up from its confirm button (button → footer → panel). One more
    // wrapper here silently breaks that walk, and the failure surfaces as an
    // unrelated spec timing out.
    renderWithProviders(
      <Sheet open onClose={vi.fn()} title="Delete" testId="x-sheet" footer={<button data-testid="go">Go</button>}>
        <p>body</p>
      </Sheet>,
      { role: 'EMPLOYEE' },
    );

    const button = screen.getByTestId('go');
    const footer = button.parentElement!;
    const panel = footer.parentElement!;
    expect(panel).toBe(screen.getByTestId('x-sheet'));
  });
});
