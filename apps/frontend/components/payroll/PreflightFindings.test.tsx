import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import type { PreflightFinding } from '@/types/payroll';
import PreflightFindings, { FindingGroup, FindingRow } from './PreflightFindings';

/**
 * Pre-flight is the server's verdict, shown.
 *
 * Two things are load-bearing. A BLOCKER and a WARNING are different claims —
 * one refuses the run, the other travels with it to whoever approves — so they
 * cannot share a section or a colour. And `canGenerate` arrives on the same
 * response and is NEVER re-derived from the list: a screen that decided for
 * itself which findings were fatal would eventually disagree with the endpoint
 * that actually refuses, and the disagreement would surface as a button that
 * does nothing.
 */
const finding = (overrides: Partial<PreflightFinding> = {}): PreflightFinding => ({
  code: 'NO_STRUCTURE',
  severity: 'BLOCKER',
  message: 'No salary structure is assigned.',
  ...overrides,
});

const blocker = finding({
  code: 'NO_STRUCTURE',
  severity: 'BLOCKER',
  employeeId: 'emp-1',
  employeeName: 'Aisha Al Balushi',
  message: 'No salary structure is assigned.',
});

const warning = finding({
  code: 'NO_ATTENDANCE',
  severity: 'WARNING',
  employeeId: 'emp-2',
  employeeName: 'Ahmed Al Habsi',
  message: 'No attendance was recorded for this period.',
});

describe('PreflightFindings', () => {
  it('separates blockers from warnings into labelled sections', () => {
    renderWithProviders(<PreflightFindings findings={[blocker, warning]} canGenerate={false} />);

    expect(screen.getByText('Blocking (1)')).toBeInTheDocument();
    expect(screen.getByText('Warnings (1)')).toBeInTheDocument();
    expect(
      screen.getByText('Generation is refused until every one of these is resolved.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The run will generate. These travel with it to whoever approves.'),
    ).toBeInTheDocument();

    // Each finding sits under its own severity, marked as such in the DOM.
    const blocked = screen.getByTestId('preflight-blocked-employee');
    const warned = screen.getByTestId('preflight-warned-employee');
    expect(blocked).toHaveTextContent('Aisha Al Balushi');
    expect(blocked).toHaveTextContent('No salary structure is assigned.');
    expect(warned).toHaveTextContent('Ahmed Al Habsi');
    expect(warned).toHaveTextContent('No attendance was recorded for this period.');
    expect(blocked).not.toHaveTextContent('Ahmed Al Habsi');
  });

  it('drops the section entirely when that severity produced nothing', () => {
    renderWithProviders(<PreflightFindings findings={[warning]} canGenerate />);
    expect(screen.queryByText(/^Blocking/)).not.toBeInTheDocument();
    expect(screen.getByText('Warnings (1)')).toBeInTheDocument();
  });

  it('refuses on the server’s word even with nothing to object to', () => {
    // Zero findings and `canGenerate: false`. Anything re-deriving the verdict
    // from the list would conclude the run is fine and say so.
    renderWithProviders(<PreflightFindings findings={[]} canGenerate={false} />);

    expect(screen.getByTestId('preflight-clear')).toHaveTextContent(
      'The run still cannot be generated — the server said so.',
    );
  });

  it('allows on the server’s word even with a warning outstanding', () => {
    // A warning is not a refusal. Nothing here may turn one into one.
    renderWithProviders(<PreflightFindings findings={[warning]} canGenerate />);

    expect(screen.getByTestId('preflight-findings')).toBeInTheDocument();
    expect(screen.getByTestId('preflight-warned-employee')).toBeInTheDocument();
    expect(screen.queryByTestId('preflight-blocked-employee')).not.toBeInTheDocument();
    expect(screen.queryByText(/cannot be generated/)).not.toBeInTheDocument();
    expect(
      screen.getByText('The run will generate. These travel with it to whoever approves.'),
    ).toBeInTheDocument();
  });

  it('keeps showing a blocker whatever the verdict says', () => {
    // The mirror of the two tests above: the list is not re-read to decide, and
    // the verdict is not read to decide what to list.
    renderWithProviders(<PreflightFindings findings={[blocker]} canGenerate />);
    expect(screen.getByText('Blocking (1)')).toBeInTheDocument();
    expect(screen.getByTestId('preflight-blocked-employee')).toBeInTheDocument();
  });

  it('says the period is clear rather than rendering a blank', () => {
    renderWithProviders(<PreflightFindings findings={[]} canGenerate />);

    const clear = screen.getByTestId('preflight-clear');
    expect(clear).toHaveTextContent('Nothing objected to this period.');
    expect(clear).not.toHaveTextContent('cannot be generated');
    expect(screen.queryByTestId('preflight-findings')).not.toBeInTheDocument();
  });

  it('collapses one employee’s objections into a single row', () => {
    // A check that asks for two things produces two findings per person; six
    // people would otherwise fill the screen with twelve near-identical lines.
    renderWithProviders(
      <PreflightFindings
        findings={[
          blocker,
          finding({
            code: 'NO_CONTRACT',
            severity: 'BLOCKER',
            employeeId: 'emp-1',
            employeeName: 'Aisha Al Balushi',
            message: 'No active contract covers this period.',
          }),
        ]}
        canGenerate={false}
      />,
    );

    expect(screen.getAllByTestId('preflight-blocked-employee')).toHaveLength(1);
    expect(screen.getByText('Blocking (2)')).toBeInTheDocument();
    expect(screen.getByTestId('preflight-blocked-employee')).toHaveTextContent('NO_CONTRACT');
  });

  it('renders a finding about nobody in particular as its own row', () => {
    renderWithProviders(
      <PreflightFindings
        findings={[
          finding({
            code: 'EMPTY_POPULATION',
            severity: 'BLOCKER',
            message: 'No employee matched this period.',
          }),
        ]}
        canGenerate={false}
      />,
    );

    expect(screen.getByTestId('finding-blocking')).toHaveTextContent(
      'No employee matched this period.',
    );
    expect(screen.queryByTestId('preflight-blocked-employee')).not.toBeInTheDocument();
  });
});

describe('FindingRow', () => {
  it('marks the severity it was given rather than inferring one', () => {
    const blocked = renderWithProviders(<FindingRow finding={finding({ severity: 'BLOCKER' })} />);
    expect(screen.getByTestId('finding-blocking')).toHaveAttribute('data-code', 'NO_STRUCTURE');
    blocked.unmount();

    renderWithProviders(<FindingRow finding={finding({ severity: 'WARNING' })} />);
    expect(screen.getByTestId('finding-warning')).toBeInTheDocument();
  });
});

describe('FindingGroup', () => {
  it('links to the record that resolves every one of the objections', () => {
    const { container } = renderWithProviders(
      <FindingGroup
        employeeId="emp-1"
        employeeName="Aisha Al Balushi"
        findings={[blocker]}
        severity="BLOCKER"
      />,
    );
    expect(container.querySelector('a[href="/dashboard/employees/emp-1"]')).toBeTruthy();
  });

  it('renders nothing at all for an employee with no findings', () => {
    const { container } = renderWithProviders(
      <FindingGroup employeeName="Aisha Al Balushi" findings={[]} severity="WARNING" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
