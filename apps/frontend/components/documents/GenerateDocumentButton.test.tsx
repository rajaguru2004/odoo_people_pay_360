import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GenerateDocumentButton from './GenerateDocumentButton';
import documentTemplateService from '@/services/documentTemplateService';
import { useBrandingStore } from '@/store/brandingStore';

vi.mock('@/services/documentTemplateService', () => ({
  default: { generateAndDownload: vi.fn() },
}));

const setBranding = (enabled: boolean, loaded = true) => {
  useBrandingStore.setState((s) => ({
    ...s,
    loaded,
    branding: { ...s.branding, document_engine_enabled: enabled },
  }));
};

describe('GenerateDocumentButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBranding(true);
  });
  afterEach(() => {
    setBranding(false, false);
  });

  it('generates and downloads with the subject it was given', async () => {
    render(
      <GenerateDocumentButton
        documentType="PAYSLIP"
        employeeId="emp-1"
        subjectId="item-1"
        params={{ month: 7, year: 2026 }}
      />,
    );
    await userEvent.click(screen.getByTestId('generate-document'));
    await waitFor(() =>
      expect(documentTemplateService.generateAndDownload).toHaveBeenCalledWith({
        typeKey: 'PAYSLIP',
        employeeId: 'emp-1',
        subjectId: 'item-1',
        params: { month: 7, year: 2026 },
        locale: undefined,
      }),
    );
  });

  it('disables with a REASON when the engine is off', async () => {
    // The button this replaces was permanently disabled with
    // title="Download PDF (Coming soon)", which told an employee nothing about
    // whether it would ever work or who could make it work.
    setBranding(false);
    render(<GenerateDocumentButton documentType="PAYSLIP" employeeId="emp-1" />);
    const button = screen.getByTestId('generate-document');
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/administrator can turn them on/i);
    expect(screen.getByText(/aren’t set up yet/i)).toBeTruthy();
  });

  it('does NOT disable while branding is still loading', async () => {
    // Three-state discipline: "not fetched" is not "off". A button that
    // flashes disabled and then enables reads as broken.
    setBranding(false, false);
    render(<GenerateDocumentButton documentType="PAYSLIP" employeeId="emp-1" />);
    expect(screen.getByTestId('generate-document')).not.toBeDisabled();
  });

  it('shows the server’s reason when generation fails', async () => {
    // Read through getApiErrorMessage: axios rejects with a FLAT object, so
    // reaching for err.response.data.message yields undefined and the user is
    // told "the operation could not be completed".
    (documentTemplateService.generateAndDownload as ReturnType<typeof vi.fn>).mockRejectedValue({
      message: 'No published payslip template is available.',
    });
    render(<GenerateDocumentButton documentType="PAYSLIP" employeeId="emp-1" />);
    await userEvent.click(screen.getByTestId('generate-document'));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/No published payslip template/),
    );
  });

  it('shows progress while it works, and recovers afterwards', async () => {
    let resolve: () => void = () => {};
    (documentTemplateService.generateAndDownload as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    render(<GenerateDocumentButton documentType="PAYSLIP" employeeId="emp-1" />);
    await userEvent.click(screen.getByTestId('generate-document'));

    // Rendering takes seconds; a button that looks idle invites a second click
    // and a second document.
    expect(screen.getByTestId('generate-document')).toBeDisabled();
    expect(screen.getByText(/Preparing/)).toBeTruthy();

    resolve();
    await waitFor(() => expect(screen.getByTestId('generate-document')).not.toBeDisabled());
  });
});
