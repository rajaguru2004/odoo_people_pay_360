import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { FilterBar, SearchInput } from './FilterBar';

describe('FilterBar', () => {
  it('stacks on a phone and stretches its children', () => {
    // The pattern that breaks 390px is a `flex-wrap` row of `min-w-[220px]`
    // children. The container takes that decision away: one column below md,
    // and every child full-width whatever it asks for.
    renderWithProviders(
      <FilterBar testId="doc-filters">
        <select />
      </FilterBar>,
    );

    const bar = screen.getByTestId('doc-filters');
    expect(bar).toHaveClass('grid', 'grid-cols-1', 'md:flex');
    expect(bar.className).toContain('[&>*]:w-full');
    expect(bar.className).toContain('md:[&>*]:w-auto');
  });
});

describe('SearchInput', () => {
  const setup = (value = '') => {
    const onChange = vi.fn();
    const utils = renderWithProviders(
      <SearchInput value={value} onChange={onChange} placeholder="Search documents" testId="doc-search" />,
    );
    return { ...utils, onChange };
  };

  it('is named for a screen reader even though its label is a placeholder', () => {
    setup();
    expect(screen.getByLabelText('Search documents')).toBeInTheDocument();
  });

  it('opens the right keyboard', () => {
    setup();
    const input = screen.getByTestId('doc-search');
    expect(input).toHaveAttribute('type', 'search');
    expect(input).toHaveAttribute('enterkeyhint', 'search');
  });

  it('places its icon on the reading-start side', () => {
    // `start-3`/`ps-10`, not `left-3`/`pl-9` — the portal has a live Arabic
    // toggle, and a physically-placed icon lands on top of the text there.
    setup();
    expect(screen.getByTestId('doc-search').className).toContain('ps-10');
  });

  it('offers a thumb-sized clear button once there is something to clear', async () => {
    const { user, onChange } = setup('contract');
    const clear = screen.getByTestId('doc-search-clear');
    expect(clear).toHaveClass('h-11', 'w-11');

    await user.click(clear);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('hides the clear button when the box is empty', () => {
    setup();
    expect(screen.queryByTestId('doc-search-clear')).not.toBeInTheDocument();
  });
});
