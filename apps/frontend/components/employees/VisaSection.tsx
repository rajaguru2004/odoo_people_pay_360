'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Plus,
  Edit,
  Trash2,
  X,
  Globe,
  RefreshCw,
  Ban,
  Paperclip,
  Download,
  Clock,
  ChevronDown,
  ChevronUp,
  FileText,
} from 'lucide-react';
import visaService from '@/services/visaService';
import libraryService from '@/services/libraryService';
import { COUNTRIES } from '@/lib/countries';
import {
  VisaRecord,
  VisaStatus,
  CreateVisaPayload,
  RenewVisaPayload,
  VISA_STATUS_LABEL_KEYS,
  VISA_STATUS_CLASSES,
  VISA_EXPIRING_SOON_CLASS,
} from '@/types/visa';
import { formatDate } from '@/utils/formatters';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { useAuthStore } from '@/store/authStore';
import { getApiErrorMessage } from '@/lib/apiError';

interface VisaSectionProps {
  employeeId: string;
  canEdit?: boolean;
}

type ModalMode = 'add' | 'edit' | 'renew' | null;

const emptyForm = {
  documentNumber: '',
  documentType: '',
  country: '',
  nationality: '',
  issueDate: '',
  expiryDate: '',
  issuingAuthority: '',
  placeOfIssue: '',
  sponsor: '',
  remarks: '',
};

export default function VisaSection({ employeeId, canEdit = false }: VisaSectionProps) {
  const t = useTranslations('visas');
  const tc = useTranslations('common');
  const { user } = useAuthStore();
  const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();

  const [visas, setVisas] = useState<VisaRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [visaTypes, setVisaTypes] = useState<string[]>([]);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [targetVisa, setTargetVisa] = useState<VisaRecord | null>(null);
  const [formData, setFormData] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);

  const canDelete = user?.role === 'ADMIN';

  const fetchVisas = useCallback(async () => {
    try {
      setLoading(true);
      const res = await visaService.getByEmployee(employeeId);
      if (res?.success) setVisas(res.data || []);
    } catch (error) {
      console.error('Failed to fetch visas:', error);
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    fetchVisas();
  }, [fetchVisas]);

  useEffect(() => {
    (async () => {
      try {
        const res = await libraryService.getAll('VISA_TYPE', true);
        if (res?.success && res.data.length > 0) {
          setVisaTypes(res.data.map((i) => i.label));
        }
      } catch (error) {
        console.error('Failed to fetch visa types:', error);
      }
    })();
  }, []);

  const currentVisas = visas.filter((v) => v.isCurrent);
  const historyVisas = visas.filter((v) => !v.isCurrent);

  const statusBadge = (visa: VisaRecord) => {
    const cls =
      visa.status === 'ACTIVE' && visa.isExpiringSoon
        ? VISA_EXPIRING_SOON_CLASS
        : VISA_STATUS_CLASSES[visa.status as VisaStatus] || VISA_STATUS_CLASSES.CANCELLED;
    const label =
      visa.status === 'ACTIVE' && visa.isExpiringSoon
        ? t('statusExpiringSoon')
        : t(VISA_STATUS_LABEL_KEYS[visa.status as VisaStatus] || 'statusCancelled');
    return (
      <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${cls}`}>
        {label}
      </span>
    );
  };

  const openAdd = () => {
    setFormData({ ...emptyForm, documentType: visaTypes[0] || '' });
    setTargetVisa(null);
    setModalMode('add');
  };

  const openEdit = (visa: VisaRecord) => {
    setFormData({
      documentNumber: visa.documentNumber,
      documentType: visa.documentType,
      country: visa.country,
      nationality: visa.nationality || '',
      issueDate: visa.issueDate?.slice(0, 10) || '',
      expiryDate: visa.expiryDate?.slice(0, 10) || '',
      issuingAuthority: visa.issuingAuthority || '',
      placeOfIssue: visa.placeOfIssue || '',
      sponsor: visa.sponsor || '',
      remarks: visa.remarks || '',
    });
    setTargetVisa(visa);
    setModalMode('edit');
  };

  const openRenew = (visa: VisaRecord) => {
    setFormData({
      ...emptyForm,
      documentType: visa.documentType,
      country: visa.country,
      nationality: visa.nationality || '',
      issuingAuthority: visa.issuingAuthority || '',
      placeOfIssue: visa.placeOfIssue || '',
      sponsor: visa.sponsor || '',
    });
    setTargetVisa(visa);
    setModalMode('renew');
  };

  const closeForm = () => {
    setModalMode(null);
    setTargetVisa(null);
    setFormData({ ...emptyForm });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.documentNumber || !formData.documentType || !formData.country) {
      toast.error(t('fillRequired'));
      return;
    }
    if (!formData.issueDate || !formData.expiryDate) {
      toast.error(t('fillRequired'));
      return;
    }
    if (formData.issueDate >= formData.expiryDate) {
      toast.error(t('issueBeforeExpiry'));
      return;
    }

    try {
      setSaving(true);
      if (modalMode === 'add') {
        const payload: CreateVisaPayload = {
          employeeId,
          documentNumber: formData.documentNumber,
          documentType: formData.documentType,
          country: formData.country,
          nationality: formData.nationality || undefined,
          issueDate: formData.issueDate,
          expiryDate: formData.expiryDate,
          issuingAuthority: formData.issuingAuthority || undefined,
          placeOfIssue: formData.placeOfIssue || undefined,
          sponsor: formData.sponsor || undefined,
          remarks: formData.remarks || undefined,
        };
        await visaService.create(payload);
        toast.success(t('created'));
      } else if (modalMode === 'edit' && targetVisa) {
        await visaService.update(targetVisa.id, {
          documentNumber: formData.documentNumber,
          documentType: formData.documentType,
          country: formData.country,
          nationality: formData.nationality || undefined,
          issueDate: formData.issueDate,
          expiryDate: formData.expiryDate,
          issuingAuthority: formData.issuingAuthority || undefined,
          placeOfIssue: formData.placeOfIssue || undefined,
          sponsor: formData.sponsor || undefined,
          remarks: formData.remarks || undefined,
        });
        toast.success(t('updated'));
      } else if (modalMode === 'renew' && targetVisa) {
        const payload: RenewVisaPayload = {
          documentNumber: formData.documentNumber,
          issueDate: formData.issueDate,
          expiryDate: formData.expiryDate,
          documentType: formData.documentType || undefined,
          issuingAuthority: formData.issuingAuthority || undefined,
          placeOfIssue: formData.placeOfIssue || undefined,
          sponsor: formData.sponsor || undefined,
          remarks: formData.remarks || undefined,
        };
        await visaService.renew(targetVisa.id, payload);
        toast.success(t('renewed'));
      }
      closeForm();
      fetchVisas();
    } catch (error: any) {
      toast.error(getApiErrorMessage(error, t('actionFailed')));
    } finally {
      setSaving(false);
    }
  };

  const handleCancelVisa = async (visa: VisaRecord) => {
    const confirmed = await confirm({
      title: t('confirmCancelTitle'),
      message: t('confirmCancelDesc', { number: visa.documentNumber }),
      confirmText: t('cancelVisa'),
      type: 'danger',
    });
    if (!confirmed) return;
    try {
      setConfirmLoading(true);
      await visaService.cancel(visa.id);
      closeModal();
      toast.success(t('cancelled'));
      fetchVisas();
    } catch (error: any) {
      closeModal();
      toast.error(getApiErrorMessage(error, t('actionFailed')));
    }
  };

  const handleDeleteVisa = async (visa: VisaRecord) => {
    const confirmed = await confirm({
      title: t('confirmDeleteTitle'),
      message: t('confirmDeleteDesc', { number: visa.documentNumber }),
      confirmText: tc('delete'),
      type: 'danger',
    });
    if (!confirmed) return;
    try {
      setConfirmLoading(true);
      await visaService.remove(visa.id);
      closeModal();
      toast.success(t('deleted'));
      fetchVisas();
    } catch (error: any) {
      closeModal();
      toast.error(getApiErrorMessage(error, t('actionFailed')));
    }
  };

  const handleUpload = async (visa: VisaRecord, file: File) => {
    try {
      setUploadingFor(visa.id);
      await visaService.uploadAttachment(visa.id, file);
      toast.success(t('attachmentUploaded'));
      fetchVisas();
    } catch (error: any) {
      toast.error(getApiErrorMessage(error, t('actionFailed')));
    } finally {
      setUploadingFor(null);
    }
  };

  const handleDeleteAttachment = async (visa: VisaRecord, attachmentId: string) => {
    try {
      await visaService.deleteAttachment(visa.id, attachmentId);
      toast.success(t('attachmentDeleted'));
      fetchVisas();
    } catch (error: any) {
      toast.error(getApiErrorMessage(error, t('actionFailed')));
    }
  };

  const visaCard = (visa: VisaRecord, isHistory = false) => (
    <div
      key={visa.id}
      data-testid={`visa-row-${visa.documentNumber}`}
      className={`border rounded-xl p-5 ${
        isHistory ? 'border-surface-border bg-surface-page/50 opacity-80' : 'border-surface-border bg-surface-card'
      }`}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-brand-primary-light/20 flex items-center justify-center">
            <Globe className="w-5 h-5 text-brand-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-text-heading">{visa.documentNumber}</p>
              <span data-testid={`visa-status-${visa.documentNumber}`}>{statusBadge(visa)}</span>
            </div>
            <p className="text-sm text-text-muted">
              {visa.documentType} · {visa.country}
            </p>
          </div>
        </div>
        {canEdit && !isHistory && (
          <div className="flex items-center gap-1.5">
            {visa.status !== 'CANCELLED' && (
              <button
                data-testid={`visa-renew-${visa.documentNumber}`}
                onClick={() => openRenew(visa)}
                className="p-2 rounded-lg text-brand-primary hover:bg-brand-primary-light/20 transition-colors"
                title={t('renew')}
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            )}
            <button
              data-testid={`visa-edit-${visa.documentNumber}`}
              onClick={() => openEdit(visa)}
              className="p-2 rounded-lg text-text-muted hover:bg-surface-page transition-colors"
              title={tc('edit')}
            >
              <Edit className="w-4 h-4" />
            </button>
            {visa.status !== 'CANCELLED' && (
              <button
                data-testid={`visa-cancel-${visa.documentNumber}`}
                onClick={() => handleCancelVisa(visa)}
                className="p-2 rounded-lg text-status-warning hover:bg-status-warning-bg transition-colors"
                title={t('cancelVisa')}
              >
                <Ban className="w-4 h-4" />
              </button>
            )}
            {canDelete && (
              <button
                data-testid={`visa-delete-${visa.documentNumber}`}
                onClick={() => handleDeleteVisa(visa)}
                className="p-2 rounded-lg text-status-error hover:bg-status-error-bg transition-colors"
                title={tc('delete')}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
        <div>
          <p className="text-xs text-text-muted mb-0.5">{t('issueDate')}</p>
          <p className="text-sm font-medium text-text-heading">{formatDate(visa.issueDate)}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted mb-0.5">{t('expiryDate')}</p>
          <p className="text-sm font-medium text-text-heading">{formatDate(visa.expiryDate)}</p>
        </div>
        {visa.status === 'ACTIVE' && (
          <div>
            <p className="text-xs text-text-muted mb-0.5">{t('daysRemaining')}</p>
            <p
              className={`text-sm font-semibold ${
                visa.daysUntilExpiry <= 7
                  ? 'text-status-error'
                  : visa.isExpiringSoon
                    ? 'text-status-warning'
                    : 'text-status-success'
              }`}
            >
              <Clock className="w-3.5 h-3.5 inline-block me-1 -mt-0.5" />
              {t('daysCount', { count: Math.max(visa.daysUntilExpiry, 0) })}
            </p>
          </div>
        )}
        {visa.issuingAuthority && (
          <div>
            <p className="text-xs text-text-muted mb-0.5">{t('issuingAuthority')}</p>
            <p className="text-sm font-medium text-text-heading">{visa.issuingAuthority}</p>
          </div>
        )}
        {visa.sponsor && (
          <div>
            <p className="text-xs text-text-muted mb-0.5">{t('sponsor')}</p>
            <p className="text-sm font-medium text-text-heading">{visa.sponsor}</p>
          </div>
        )}
        {visa.placeOfIssue && (
          <div>
            <p className="text-xs text-text-muted mb-0.5">{t('placeOfIssue')}</p>
            <p className="text-sm font-medium text-text-heading">{visa.placeOfIssue}</p>
          </div>
        )}
      </div>

      {visa.remarks && (
        <p className="text-sm text-text-muted mt-3 border-t border-surface-border pt-3">
          {visa.remarks}
        </p>
      )}

      {/* Attachments */}
      <div className="mt-4 border-t border-surface-border pt-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wide flex items-center gap-1.5">
            <Paperclip className="w-3.5 h-3.5" />
            {t('attachments')} ({visa.attachments?.length || 0})
          </p>
          {canEdit && (
            <label className="text-xs font-medium text-brand-primary cursor-pointer hover:underline">
              {uploadingFor === visa.id ? tc('loading') : t('uploadAttachment')}
              <input
                type="file"
                className="hidden"
                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                disabled={uploadingFor === visa.id}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleUpload(visa, file);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
        {(visa.attachments?.length || 0) > 0 && (
          <ul className="space-y-1.5">
            {visa.attachments!.map((att) => (
              <li
                key={att.id}
                className="flex items-center justify-between gap-2 text-sm bg-surface-page rounded-lg px-3 py-2"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <FileText className="w-4 h-4 text-text-muted shrink-0" />
                  <span className="truncate text-text-body">{att.fileName}</span>
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  <a
                    href={att.fileUrl.startsWith('http') ? att.fileUrl : `${process.env.NEXT_PUBLIC_API_URL || ''}${att.fileUrl}`}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1.5 rounded text-text-muted hover:text-brand-primary transition-colors"
                    title={t('download')}
                  >
                    <Download className="w-4 h-4" />
                  </a>
                  {canEdit && (
                    <button
                      onClick={() => handleDeleteAttachment(visa, att.id)}
                      className="p-1.5 rounded text-text-muted hover:text-status-error transition-colors"
                      title={tc('delete')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <ConfirmDialog />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-text-heading">{t('title')}</h3>
          <p className="text-sm text-text-muted">{t('subtitle')}</p>
        </div>
        {canEdit && (
          <button
            data-testid="visa-add"
            onClick={openAdd}
            className="flex items-center gap-2 px-4 py-2 bg-brand-primary text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            {t('addVisa')}
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-40 rounded-xl bg-surface-page animate-pulse" />
          ))}
        </div>
      ) : visas.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-surface-border rounded-xl">
          <Globe className="w-10 h-10 text-text-muted mx-auto mb-3" />
          <p data-testid="visa-empty" className="text-text-muted">{t('noVisas')}</p>
        </div>
      ) : (
        <>
          {/* Current records */}
          <div className="space-y-4">{currentVisas.map((v) => visaCard(v))}</div>

          {/* History */}
          {historyVisas.length > 0 && (
            <div>
              <button
                data-testid="visa-history-toggle"
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-2 text-sm font-medium text-text-muted hover:text-text-heading transition-colors mb-3"
              >
                {showHistory ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                {t('history')} ({historyVisas.length})
              </button>
              {showHistory && (
                <div className="space-y-3">{historyVisas.map((v) => visaCard(v, true))}</div>
              )}
            </div>
          )}
        </>
      )}

      {/* Add / Edit / Renew modal */}
      {modalMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-surface-card rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border sticky top-0 bg-surface-card">
              <h4 className="font-semibold text-text-heading">
                {modalMode === 'add' && t('addVisa')}
                {modalMode === 'edit' && t('editVisa')}
                {modalMode === 'renew' && t('renewVisa')}
              </h4>
              <button
                onClick={closeForm}
                className="p-1.5 rounded-lg text-text-muted hover:bg-surface-page transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalMode === 'renew' && targetVisa && (
              <div className="mx-6 mt-4 rounded-lg bg-surface-page border border-surface-border p-3 text-sm text-text-muted">
                {t('renewInfo', {
                  number: targetVisa.documentNumber,
                  date: formatDate(targetVisa.expiryDate),
                })}
              </div>
            )}

            <form onSubmit={handleSubmit} className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-text-body mb-1">
                  {t('visaNumber')} *
                </label>
                <input
                  data-testid="visa-form-number"
                  type="text"
                  value={formData.documentNumber}
                  onChange={(e) => setFormData({ ...formData, documentNumber: e.target.value })}
                  className="w-full px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                  maxLength={100}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-body mb-1">
                  {t('visaType')} *
                </label>
                {visaTypes.length > 0 ? (
                  <select
                    data-testid="visa-form-type"
                    value={formData.documentType}
                    onChange={(e) => setFormData({ ...formData, documentType: e.target.value })}
                    className="w-full px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                    required
                  >
                    {visaTypes.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.documentType}
                    onChange={(e) => setFormData({ ...formData, documentType: e.target.value })}
                    className="w-full px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                    maxLength={100}
                    required
                  />
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-text-body mb-1">
                  {t('country')} *
                </label>
                <input
                  type="text"
                  data-testid="visa-form-country"
                  value={formData.country}
                  onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                  className="w-full px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40 disabled:opacity-60"
                  maxLength={100}
                  disabled={modalMode === 'renew'}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-body mb-1">
                  {t('nationality')}
                </label>
                <select
                  data-testid="visa-form-nationality"
                  value={formData.nationality}
                  onChange={(e) => setFormData({ ...formData, nationality: e.target.value })}
                  className="w-full px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40 disabled:opacity-60"
                  disabled={modalMode === 'renew'}
                >
                  <option value="">—</option>
                  {formData.nationality &&
                    !COUNTRIES.some((c) => c.code === formData.nationality) && (
                      <option value={formData.nationality}>{formData.nationality} (legacy)</option>
                    )}
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-body mb-1">
                  {t('issuingAuthority')}
                </label>
                <input
                  type="text"
                  value={formData.issuingAuthority}
                  onChange={(e) => setFormData({ ...formData, issuingAuthority: e.target.value })}
                  className="w-full px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                  maxLength={200}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-body mb-1">
                  {t('issueDate')} *
                </label>
                <input
                  type="date"
                  data-testid="visa-form-issue"
                  value={formData.issueDate}
                  onChange={(e) => setFormData({ ...formData, issueDate: e.target.value })}
                  className="w-full px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-body mb-1">
                  {t('expiryDate')} *
                </label>
                <input
                  type="date"
                  data-testid="visa-form-expiry"
                  value={formData.expiryDate}
                  onChange={(e) => setFormData({ ...formData, expiryDate: e.target.value })}
                  className="w-full px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-body mb-1">
                  {t('placeOfIssue')}
                </label>
                <input
                  type="text"
                  value={formData.placeOfIssue}
                  onChange={(e) => setFormData({ ...formData, placeOfIssue: e.target.value })}
                  className="w-full px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                  maxLength={200}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-body mb-1">
                  {t('sponsor')}
                </label>
                <input
                  type="text"
                  value={formData.sponsor}
                  onChange={(e) => setFormData({ ...formData, sponsor: e.target.value })}
                  className="w-full px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                  maxLength={200}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-text-body mb-1">
                  {t('remarks')}
                </label>
                <textarea
                  value={formData.remarks}
                  onChange={(e) => setFormData({ ...formData, remarks: e.target.value })}
                  className="w-full px-3 py-2 border border-surface-border rounded-lg bg-surface-card text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                  rows={2}
                />
              </div>

              <div className="md:col-span-2 flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeForm}
                  className="px-4 py-2 rounded-lg border border-surface-border text-text-body text-sm font-medium hover:bg-surface-page transition-colors"
                >
                  {tc('cancel')}
                </button>
                <button
                  data-testid="visa-form-submit"
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-brand-primary text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {saving
                    ? tc('loading')
                    : modalMode === 'renew'
                      ? t('renew')
                      : tc('save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
