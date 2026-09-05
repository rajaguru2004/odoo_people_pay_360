'use client';

import { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  X,
  FileSpreadsheet,
  Loader2,
  CheckCircle,
  AlertCircle,
  Upload,
  Download,
  UserCheck,
  UserX,
  FileCheck2
} from 'lucide-react';
import { ArrowLeftIcon } from '@/components/common/icons/directional';
import employeeService from '@/services/employeeService';
import { formatCurrency } from '@/utils/formatters';
import { payBasisLabel, rateSuffix, toSalaryBasis } from '@/utils/payBasis';

interface ImportModalProps {
  onClose: () => void;
}

type Step = 'UPLOAD' | 'PREVIEW' | 'IMPORTING' | 'RESULTS';

export default function ImportModal({ onClose }: ImportModalProps) {
  const t = useTranslations('importModal');
  const tc = useTranslations('common');
  // Shared pay-basis strings, consumed by utils/payBasis.ts helpers.
  const tp = useTranslations('payBasis');
  const [step, setStep] = useState<Step>('UPLOAD');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{
    summary: { totalRows: number; validRows: number; invalidRows: number };
    rows: Array<{
      rowNumber: number;
      valid: boolean;
      errors: string[];
      data: any;
    }>;
  } | null>(null);
  const [results, setResults] = useState<Array<{
    email: string;
    success: boolean;
    employeeCode?: string;
    error?: string;
  }>>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDownloadTemplate = async () => {
    try {
      const blob = await employeeService.downloadImportTemplate();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'employee_import_template.xlsx';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error('Download template failed:', err);
      setError(t('templateDownloadFailed'));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Check extension
    if (!file.name.match(/\.(xlsx|xls)$/)) {
      setError(t('onlyExcelFiles'));
      setSelectedFile(null);
      return;
    }
    
    setSelectedFile(file);
    setError(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    if (!file.name.match(/\.(xlsx|xls)$/)) {
      setError(t('onlyExcelFiles'));
      return;
    }

    setSelectedFile(file);
    setError(null);
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    
    setLoading(true);
    setError(null);
    try {
      const res = await employeeService.previewImport(selectedFile);
      setPreviewData(res.data);
      setStep('PREVIEW');
    } catch (err: any) {
      console.error('File parsing failed:', err);
      setError(err?.response?.data?.message || err?.message || t('parseFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!previewData) return;

    const validEmployees = previewData.rows
      .filter(row => row.valid)
      .map(row => row.data);

    if (validEmployees.length === 0) {
      setError(t('noValidRecords'));
      return;
    }

    setLoading(true);
    setStep('IMPORTING');
    setError(null);
    try {
      const res = await employeeService.confirmImport(validEmployees);
      setResults(res.data);
      setStep('RESULTS');
    } catch (err: any) {
      console.error('Bulk import failed:', err);
      setError(err?.response?.data?.message || err?.message || t('importFailed'));
      setStep('PREVIEW');
    } finally {
      setLoading(false);
    }
  };

  const resetUpload = () => {
    setSelectedFile(null);
    setPreviewData(null);
    setResults([]);
    setError(null);
    setStep('UPLOAD');
  };

  // Helper to format currency
  const formatSalary = (val: any) => {
    const num = Number(val);
    if (isNaN(num)) return tc('notAvailable');
    return formatCurrency(num);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div 
        data-testid="import-modal"
        data-step={step}
        className={`bg-white rounded-2xl shadow-2xl w-full overflow-hidden transition-all duration-300 ${
          step === 'PREVIEW' ? 'max-w-6xl' : 'max-w-xl'
        }`}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-brand-primary to-brand-primary-dark px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-white/20 rounded-xl">
              <FileSpreadsheet className="text-white" size={24} />
            </div>
            <div>
              <h3 className="text-xl font-bold text-white">{t('title')}</h3>
              <p className="text-brand-primary-light text-xs mt-0.5">{t('subtitle')}</p>
            </div>
          </div>
          {step !== 'IMPORTING' && (
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/20 rounded-xl transition-all text-white/80 hover:text-white"
            >
              <X size={20} />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[70vh]">
          {error && (
            <div className="mb-4 bg-status-error-bg/40 border-2 border-status-error/20 rounded-xl p-4 flex gap-3 items-start">
              <AlertCircle className="text-status-error shrink-0 mt-0.5" size={18} />
              <div>
                <p className="text-sm font-semibold text-status-error">{t('importErrorHeading')}</p>
                <p className="text-sm text-status-error mt-0.5">{error}</p>
              </div>
            </div>
          )}

          {/* STEP 1: UPLOAD & TEMPLATE DOWNLOAD */}
          {step === 'UPLOAD' && (
            <div className="space-y-6">
              {/* Template Section */}
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <h4 className="font-bold text-slate-800 text-sm">{t('downloadTemplateHeading')}</h4>
                  <p className="text-xs text-slate-500">
                    {t('downloadTemplateDesc')}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    {t('payBasisHint')}
                  </p>
                </div>
                <button
                  onClick={handleDownloadTemplate}
                  className="flex items-center gap-2 px-4 py-2 border-2 border-slate-300 text-slate-700 rounded-xl hover:bg-white hover:border-brand-primary hover:text-brand-primary transition-all text-xs font-bold shrink-0"
                >
                  <Download size={16} />
                  {t('templateButton')}
                </button>
              </div>

              {/* Drag and drop zone */}
              <div
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-3 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all ${
                  selectedFile 
                    ? 'border-brand-primary/50 bg-brand-primary-light/10' 
                    : 'border-slate-300 hover:border-brand-primary/50 hover:bg-slate-50/50'
                }`}
              >
                <input
                  data-testid="import-file-input"
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".xlsx, .xls"
                  className="hidden"
                />
                
                <div className={`p-4 rounded-full ${selectedFile ? 'bg-brand-primary-light/20 text-brand-primary' : 'bg-slate-100 text-slate-400'}`}>
                  <Upload size={32} />
                </div>
                
                {selectedFile ? (
                  <div className="text-center">
                    <p className="font-bold text-slate-800 text-sm truncate max-w-xs">{selectedFile.name}</p>
                    <p className="text-xs text-slate-500 mt-1">{t('fileSizeKb', { size: (selectedFile.size / 1024).toFixed(1) })}</p>
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="font-bold text-slate-700 text-sm">{t('dragDropHere')}</p>
                    <p className="text-xs text-slate-400 mt-1">{t('orClickToSelect')}</p>
                  </div>
                )}
              </div>

              {/* Import tips */}
              <div className="bg-brand-primary-light/10 rounded-2xl p-4 border border-brand-primary-light/20">
                <h5 className="text-xs font-bold text-brand-primary mb-2">{t('importantInstructions')}</h5>
                <ul className="text-xs text-slate-600 space-y-1.5 list-disc ps-4">
                  <li>{t('requiredColumnsNote')}</li>
                  <li>{t('dateFieldsNote')}</li>
                  <li>{t('genderNote')}</li>
                  <li>{t('departmentsNote')}</li>
                  <li>{t('ageNote')}</li>
                </ul>
              </div>
            </div>
          )}

          {/* STEP 2: PREVIEW */}
          {step === 'PREVIEW' && previewData && (
            <div
              className="space-y-6"
              data-testid="import-preview"
              data-total-rows={String(previewData.summary.totalRows)}
              data-valid-rows={String(previewData.summary.validRows)}
              data-invalid-rows={String(previewData.summary.invalidRows)}
            >
              {/* Summary Widgets */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center">
                  <span className="block text-xs font-semibold text-slate-500 uppercase tracking-wider">{t('totalRowsFound')}</span>
                  <span className="block text-2xl font-black text-slate-800 mt-1">{previewData.summary.totalRows}</span>
                </div>
                <div className="bg-status-success-bg/40 border border-status-success/20 rounded-xl p-4 text-center">
                  <span className="block text-xs font-semibold text-status-success uppercase tracking-wider">{t('validReady')}</span>
                  <span className="block text-2xl font-black text-status-success mt-1 flex items-center justify-center gap-1.5">
                    <UserCheck className="inline" size={20} />
                    {previewData.summary.validRows}
                  </span>
                </div>
                <div className="bg-status-error-bg/40 border border-status-error/20 rounded-xl p-4 text-center">
                  <span className="block text-xs font-semibold text-status-error uppercase tracking-wider">{t('needsAttention')}</span>
                  <span className="block text-2xl font-black text-status-error mt-1 flex items-center justify-center gap-1.5">
                    <UserX className="inline" size={20} />
                    {previewData.summary.invalidRows}
                  </span>
                </div>
              </div>

              {previewData.summary.invalidRows > 0 && (
                <div className="bg-status-warning-bg/40 border border-status-warning/20 rounded-xl p-4 text-status-warning text-xs">
                  <strong>{t('warningNoteHeading')}</strong> {t('warningNoteDesc')}
                </div>
              )}

              {/* Data Table */}
              <div className="border border-slate-200 rounded-xl overflow-hidden shadow-xs">
                <div className="overflow-x-auto max-h-[40vh]">
                  <table className="w-full text-start border-collapse">
                    <thead>
                      <tr className="bg-slate-100 text-slate-700 font-bold text-xs uppercase border-b border-slate-200 sticky top-0 z-10">
                        <th className="px-4 py-3 text-center">{t('colRow')}</th>
                        <th className="px-4 py-3">{tc('status')}</th>
                        <th className="px-4 py-3">{t('colFullName')}</th>
                        <th className="px-4 py-3">{tc('email')}</th>
                        <th className="px-4 py-3">{tc('department')}</th>
                        <th className="px-4 py-3">{tc('position')}</th>
                        <th className="px-4 py-3">{t('colBaseSalary')}</th>
                        <th className="px-4 py-3">{t('colPayBasis')}</th>
                        <th className="px-4 py-3">{t('colStartDate')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {previewData.rows.map((row) => (
                        <tr 
                          key={row.rowNumber}
                          data-testid="import-preview-row"
                          data-row-number={String(row.rowNumber)}
                          data-row-valid={String(row.valid)} 
                          className={`hover:bg-slate-50 transition-colors ${
                            row.valid ? 'bg-green-50/10' : 'bg-red-50/20'
                          }`}
                        >
                          <td className="px-4 py-3 text-slate-500 font-medium text-center">{row.rowNumber}</td>
                          <td className="px-4 py-3">
                            {row.valid ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-status-success-bg text-status-success rounded-full font-bold text-[10px] uppercase">
                                <CheckCircle size={10} /> {t('valid')}
                              </span>
                            ) : (
                              <div className="space-y-1">
                                <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-status-error-bg text-status-error rounded-full font-bold text-[10px] uppercase">
                                  <AlertCircle size={10} /> {t('error')}
                                </span>
                                <ul className="text-[10px] text-status-error list-disc ps-3 mt-1 space-y-0.5 max-w-[250px]">
                                  {row.errors.map((err, i) => <li key={i}>{err}</li>)}
                                </ul>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 font-semibold text-slate-800">{row.data.fullName || tc('notAvailable')}</td>
                          <td className="px-4 py-3 text-slate-600">{row.data.email || tc('notAvailable')}</td>
                          <td className="px-4 py-3 font-medium text-slate-700">{row.data.departmentName || tc('notAvailable')}</td>
                          <td className="px-4 py-3 text-slate-600">{row.data.position || tc('notAvailable')}</td>
                          <td className="px-4 py-3 font-semibold text-slate-700">
                            {formatSalary(row.data.baseSalary)}
                            <span className="text-[10px] font-normal text-slate-500">
                              {rateSuffix(toSalaryBasis(row.data.salaryType), tp)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-600">
                            {payBasisLabel(toSalaryBasis(row.data.salaryType), tp)}
                          </td>
                          <td className="px-4 py-3 text-slate-600">{row.data.startDate || tc('notAvailable')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: IMPORTING LOADING SCREEN */}
          {step === 'IMPORTING' && (
            <div className="py-12 flex flex-col items-center justify-center gap-4 text-center">
              <Loader2 className="animate-spin text-brand-primary" size={48} />
              <div className="space-y-1.5 mt-2">
                <h4 className="font-bold text-slate-800 text-base">{t('creatingProfiles')}</h4>
                <p className="text-slate-500 text-sm max-w-sm">
                  {t('creatingProfilesDesc')}
                </p>
              </div>
            </div>
          )}

          {/* STEP 4: RESULTS */}
          {step === 'RESULTS' && (
            <div
              className="space-y-6"
              data-testid="import-results"
              data-success-count={String(results.filter((r) => r.success).length)}
              data-failed-count={String(results.filter((r) => !r.success).length)}
            >
              {/* Result Summary Widget */}
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 flex items-center justify-around gap-6">
                <div className="text-center">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('successfulImports')}</span>
                  <span className="block text-3xl font-black text-status-success mt-1">
                    {results.filter(r => r.success).length}
                  </span>
                </div>
                <div className="w-px h-10 bg-slate-200"></div>
                <div className="text-center">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('failedCreations')}</span>
                  <span className="block text-3xl font-black text-status-error mt-1">
                    {results.filter(r => !r.success).length}
                  </span>
                </div>
              </div>

              {/* Result Table */}
              <div className="border border-slate-200 rounded-xl overflow-hidden shadow-xs max-h-[40vh] overflow-y-auto">
                <table className="w-full text-start border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
                      <th className="px-4 py-2.5">{tc('email')}</th>
                      <th className="px-4 py-2.5">{tc('status')}</th>
                      <th className="px-4 py-2.5">{t('colDetail')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {results.map((res, i) => (
                      <tr key={i} data-testid="import-result-row" data-email={res.email} data-success={String(res.success)} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium text-slate-800">{res.email}</td>
                        <td className="px-4 py-3">
                          {res.success ? (
                            <span className="px-2 py-0.5 bg-status-success-bg text-status-success rounded font-bold text-[10px] uppercase">
                              {t('success')}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 bg-status-error-bg text-status-error rounded font-bold text-[10px] uppercase">
                              {t('failed')}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {res.success ? (
                            <span className="text-status-success font-medium flex items-center gap-1">
                              <FileCheck2 size={14} /> {t('codePrefix', { code: res.employeeCode ?? '' })}
                            </span>
                          ) : (
                            <span className="text-status-error font-medium flex items-center gap-1">
                              <AlertCircle size={14} /> {res.error}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-between gap-3">
          {step === 'UPLOAD' && (
            <>
              <button
                onClick={onClose}
                disabled={loading}
                className="px-5 py-2.5 border-2 border-slate-300 text-slate-700 rounded-xl hover:bg-slate-100 font-semibold transition-all text-sm disabled:opacity-50"
              >
                {tc('cancel')}
              </button>
              <button
                data-testid="import-upload"
                onClick={handleUpload}
                disabled={!selectedFile || loading}
                className="px-6 py-2.5 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-white rounded-xl hover:shadow-lg font-bold transition-all text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {loading && <Loader2 className="animate-spin" size={16} />}
                {t('uploadAndPreview')}
              </button>
            </>
          )}

          {step === 'PREVIEW' && (
            <>
              <button
                onClick={resetUpload}
                disabled={loading}
                className="px-4 py-2.5 border-2 border-slate-300 text-slate-700 rounded-xl hover:bg-slate-100 font-semibold transition-all text-sm disabled:opacity-50 flex items-center gap-2"
              >
                <ArrowLeftIcon size={16} />
                {t('reuploadFile')}
              </button>
              <button
                data-testid="import-confirm"
                onClick={handleConfirmImport}
                disabled={loading || !previewData || previewData.summary.validRows === 0}
                className="px-6 py-2.5 bg-gradient-to-r from-status-success to-status-success/80 text-white rounded-xl hover:shadow-lg font-bold transition-all text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {loading && <Loader2 className="animate-spin" size={16} />}
                {t('importCount', { count: previewData?.summary.validRows ?? 0 })}
              </button>
            </>
          )}

          {step === 'IMPORTING' && (
            <div className="w-full text-center text-xs text-slate-400 font-medium italic">
              {t('doNotRefresh')}
            </div>
          )}

          {step === 'RESULTS' && (
            <div className="w-full flex justify-end">
              <button
                data-testid="import-close"
                onClick={onClose}
                className="px-6 py-2.5 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-white rounded-xl hover:shadow-lg font-bold transition-all text-sm"
              >
                {t('closeAndRefresh')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
