import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('renders its children', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('calls onClick when pressed', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run payroll</Button>);

    await userEvent.click(screen.getByRole('button', { name: 'Run payroll' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is DISABLED while loading — a second click would be a duplicate run', async () => {
    const onClick = vi.fn();
    render(
      <Button isLoading onClick={onClick}>
        Run payroll
      </Button>,
    );

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('honours an explicit disabled prop', () => {
    render(<Button disabled>Save</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
