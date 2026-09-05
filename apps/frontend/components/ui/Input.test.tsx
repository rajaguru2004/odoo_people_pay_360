import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from './Input';

describe('Input', () => {
  it('associates the label with the field', () => {
    render(<Input label="Email" />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('generates distinct ids for two instances of the same field', () => {
    render(
      <>
        <Input label="Email" />
        <Input label="Email" />
      </>,
    );
    const [first, second] = screen.getAllByLabelText('Email');
    expect(first.id).not.toBe(second.id);
  });

  it('exposes the error to assistive tech, not just visually', () => {
    render(<Input label="Email" error="Enter a valid email" />);

    const field = screen.getByLabelText('Email');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Enter a valid email');
  });

  it('sets no describedby when there is no error', () => {
    render(<Input label="Email" />);
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-describedby');
  });
});
