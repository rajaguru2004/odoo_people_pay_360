import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import Field, { inputClass, selectClass, textareaClass } from './Field';

/**
 * The form-control recipe.
 *
 * The size rules are asserted on the exported class strings rather than on a
 * rendered box, because jsdom has no layout — `getBoundingClientRect()` returns
 * zeroes and would pass whatever we wrote. The browser spec measures the real
 * thing; this pins the intent so a "tidy-up" cannot quietly drop `text-base`.
 */

describe('the control recipe', () => {
  it.each([
    ['input', inputClass],
    ['select', selectClass],
  ])('%s is 48px tall', (_name, cls) => {
    expect(cls).toContain('h-12');
  });

  it.each([
    ['input', inputClass],
    ['select', selectClass],
    ['textarea', textareaClass],
  ])('%s sets a 16px font', (_name, cls) => {
    // Below 16px mobile Safari zooms the page on focus, and this shell scrolls
    // an inner <main> — so the zoom strands the reader sideways in a container
    // that still measures clean. Never `text-sm` here.
    expect(cls).toContain('text-base');
    expect(cls).not.toMatch(/\btext-(xs|sm)\b/);
  });
});

describe('Field', () => {
  it('labels the control, above it, and wires the two together', () => {
    renderWithProviders(
      <Field label="Reason">
        <input data-testid="reason" className={inputClass} />
      </Field>,
    );

    const input = screen.getByTestId('reason');
    expect(screen.getByLabelText('Reason')).toBe(input);
    // The label element precedes the control in the DOM — "above", not floating
    // inside it as a placeholder that vanishes the moment the reader types.
    expect(screen.getByText('Reason').tagName).toBe('LABEL');
  });

  it('announces an error and marks the control invalid', () => {
    renderWithProviders(
      <Field label="Amount" error="Enter an amount">
        <input data-testid="amount" className={inputClass} />
      </Field>,
    );

    const input = screen.getByTestId('amount');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter an amount');
  });

  it('shows a hint when there is no error, and the error wins when there is', () => {
    const { unmount } = renderWithProviders(
      <Field label="Amount" hint="Before tax">
        <input data-testid="a" className={inputClass} />
      </Field>,
    );
    expect(screen.getByTestId('a')).toHaveAccessibleDescription('Before tax');
    expect(screen.getByTestId('a')).not.toHaveAttribute('aria-invalid');
    unmount();

    renderWithProviders(
      <Field label="Amount" hint="Before tax" error="Too large">
        <input data-testid="b" className={inputClass} />
      </Field>,
    );
    expect(screen.getByTestId('b')).toHaveAccessibleDescription('Too large');
  });

  it('marks a required field without relying on the asterisk alone', () => {
    renderWithProviders(
      <Field label="Reason" required>
        <input data-testid="reason" className={inputClass} />
      </Field>,
    );
    // The glyph is decorative — a screen reader gets `required` from the
    // control, which the caller sets, not from a red star in the label.
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
  });
});
