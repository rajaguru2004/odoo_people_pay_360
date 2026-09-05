import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import VariableMentionPopover, { optionsFromManifest } from './VariableMentionPopover';
import { TokenManifest } from '@/types/document-template';

/**
 * The @-mention picker, tested as PURE React — the editor that hosts it cannot
 * run in jsdom (GrapesJS needs a real canvas iframe) and is mocked at the page
 * level instead. Keyboard events arrive as window-level capture listeners
 * because the editor forwards keys it intercepted inside the canvas iframe.
 */

const manifest: TokenManifest = {
  documentType: 'PAYSLIP',
  name: 'Payslip',
  groups: [
    {
      group: 'Employee',
      tokens: [
        { path: 'employeeName', label: 'Employee name', type: 'string', sampleValue: 'A', alwaysPresent: true, columns: null },
        { path: 'employeeCode', label: 'Employee code', type: 'string', sampleValue: 'E1', alwaysPresent: true, columns: null },
        { path: 'baseSalary', label: 'Basic salary', type: 'money', sampleValue: '1', alwaysPresent: true, columns: null },
      ],
    },
  ],
  collections: [
    {
      path: 'earnings',
      label: 'Earnings',
      fields: [
        { name: 'label', label: 'Component', type: 'string' },
        { name: 'amount', label: 'Amount', type: 'money' },
      ],
      sampleRows: [],
    },
  ],
  sample: {},
};

const anchor = { top: 10, left: 20 };

describe('optionsFromManifest (the @ popover feed)', () => {
  it('promotes the current table collection with RELATIVE paths', () => {
    const opts = optionsFromManifest(manifest, { preferCollection: 'earnings' });
    expect(opts[0]).toMatchObject({ path: 'label', group: 'Earnings (this table)' });
    expect(opts[1]).toMatchObject({ path: 'amount', format: 'money' });
  });

  it('never offers a table as a chip', () => {
    const withTable: TokenManifest = {
      ...manifest,
      groups: [
        {
          group: 'Payslip',
          tokens: [
            { path: 'earnings', label: 'Earnings lines', type: 'table', sampleValue: [], alwaysPresent: true, columns: [] },
          ],
        },
      ],
    };
    expect(optionsFromManifest(withTable).some((o) => o.path === 'earnings')).toBe(false);
  });
});

describe('VariableMentionPopover', () => {
  it('lists manifest fields grouped, filtered by the live query', () => {
    render(
      <VariableMentionPopover
        manifest={manifest}
        anchor={anchor}
        query="code"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('mention-option-employeeCode')).toBeInTheDocument();
    expect(screen.queryByTestId('mention-option-baseSalary')).not.toBeInTheDocument();
  });

  it('reports the chosen field with its server format on mousedown (the pre-blur commit)', () => {
    const onSelect = vi.fn();
    render(
      <VariableMentionPopover
        manifest={manifest}
        anchor={anchor}
        query="salary"
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.mouseDown(screen.getByTestId('mention-option-baseSalary'));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'baseSalary', format: 'money' }),
    );
  });

  it('navigates with arrows and commits with Enter — keys arrive on window', () => {
    const onSelect = vi.fn();
    render(
      <VariableMentionPopover
        manifest={manifest}
        anchor={anchor}
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'employeeCode' }),
    );
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <VariableMentionPopover
        manifest={manifest}
        anchor={anchor}
        query=""
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('inside a table, promotes that collection first with RELATIVE paths', () => {
    render(
      <VariableMentionPopover
        manifest={manifest}
        anchor={anchor}
        query=""
        preferCollection="earnings"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const options = screen.getAllByRole('option');
    // Collection fields lead; their testids carry the RELATIVE path.
    expect(options[0]).toHaveAttribute('data-testid', 'mention-option-label');
    expect(options[1]).toHaveAttribute('data-testid', 'mention-option-amount');
    expect(screen.getByText('Earnings (this table)')).toBeInTheDocument();
  });

  it('in searchable (toolbar) mode, its own search box filters past the 12-option window', () => {
    const onSelect = vi.fn();
    render(
      <VariableMentionPopover
        manifest={manifest}
        anchor={anchor}
        query=""
        searchable
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    // With no query the list is capped; the search box is the way past it.
    fireEvent.change(screen.getByTestId('mention-search'), { target: { value: 'code' } });
    fireEvent.mouseDown(screen.getByTestId('mention-option-employeeCode'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'employeeCode' }));
  });

  it('says so when nothing matches instead of rendering an empty box', () => {
    render(
      <VariableMentionPopover
        manifest={manifest}
        anchor={anchor}
        query="zzzz"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('mention-popover').textContent).toContain('zzzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});
