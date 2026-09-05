'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { EmployeeDocument, DOCUMENT_TYPE_LABEL_KEYS } from '@/types/employee-profile';
import { formatDate } from '@/utils/formatDate';
import { resolveFileUrl } from '@/utils/fileUrl'; interface DocumentListProps { documents: EmployeeDocument[]; onDelete: (documentId: string) => Promise<void>; onRefresh?: () => void; } export default function DocumentList({ documents, onDelete, onRefresh }: DocumentListProps) { const t = useTranslations('documentList'); const tp = useTranslations('employeeProfileLabels'); const tc = useTranslations('common'); const [deletingId, setDeletingId] = useState<string | null>(null); const handleDelete = async (doc: EmployeeDocument) => { if (!confirm(t('confirmDelete', { name: doc.fileName }))) { return; } try { setDeletingId(doc.id); await onDelete(doc.id); if (onRefresh) onRefresh(); } catch (error) { console.error('Delete failed:', error);
      alert(t('deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  const getFileIcon = (mimeType?: string) => {
    if (!mimeType) mimeType = '';
    if (mimeType.startsWith('image/')) {
      return (
        <svg className="w-8 h-8 text-brand-primary-light0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clipRule="evenodd" />
        </svg>
      );
    }
    if (mimeType === 'application/pdf') {
      return (
        <svg className="w-8 h-8 text-red-500" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
        </svg>
      );
    }
    return (
      <svg className="w-8 h-8 text-text-muted" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
      </svg>
    );
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  if (documents.length === 0) {
    return (
      <div className="text-center py-12 bg-surface-page rounded-lg border-2 border-dashed border-gray-300">
        <svg className="w-16 h-16 mx-auto text-text-muted mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p className="text-gray-600 font-medium">{t('noDocumentsYet')}</p> <p className="text-sm text-text-muted mt-1">{t('uploadFirstDocument')}</p> </div> ); } return ( <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {documents.filter(doc => doc).map((doc) => (
        <div
          key={doc.id}
          className="bg-white border border-surface-border rounded-lg p-4 hover:shadow-md transition-shadow"
        >
          <div className="flex items-start gap-3">
            {/* File Icon */}
            <div className="flex-shrink-0">
              {getFileIcon(doc.mimeType)}
            </div>

            {/* File Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-medium text-text-heading truncate">
                    {doc.fileName}
                  </h4>
                  <p className="text-xs text-text-muted mt-1">
                    {(() => {
                      /*
                       * A documentType the map does not know about — and the
                       * backend can store any of them — resolved to `undefined`,
                       * which next-intl then tried to `.split('.')`. The result
                       * was a thrown MISSING_MESSAGE on every visit to
                       * /dashboard/profile that had such a document, which is
                       * what the route matrix was failing on. Fall back to the
                       * stored value rather than crashing on it.
                       */
                      const key = DOCUMENT_TYPE_LABEL_KEYS[doc.documentType as keyof typeof DOCUMENT_TYPE_LABEL_KEYS];
                      return key ? tp(key) : doc.documentType;
                    })()}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1">
                  <a
                    href={resolveFileUrl(doc.fileUrl) || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-11 md:min-w-0 items-center justify-center p-1.5 text-brand-primary hover:bg-brand-primary-light/10 rounded transition-colors touch-manipulation"
                    title={t('download')}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  </a>
                  <button
                    onClick={() => handleDelete(doc)}
                    disabled={deletingId === doc.id}
                    className="inline-flex min-w-11 md:min-w-0 items-center justify-center p-1.5 text-status-error hover:bg-status-error-bg/40 rounded transition-colors disabled:opacity-50 touch-manipulation"
                    title={tc('delete')}
                  >
                    {deletingId === doc.id ? (
                      <div className="w-4 h-4 border-2 border-red-600 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {/* Description */}
              {doc.description && (
                <p className="text-xs text-gray-600 mt-2 line-clamp-2">
                  {doc.description}
                </p>
              )}

              {/* Meta */}
              <div className="flex items-center gap-3 mt-2 text-xs text-text-muted">
                <span>{formatFileSize(doc.fileSize)}</span>
                <span>•</span>
                <span>{formatDate(doc.uploadedAt)}</span>
              </div>

              {/* Uploader */}
              {doc.uploader && (
                <p className="text-xs text-text-muted mt-1">
                  {t('uploadedBy')}{doc.uploader.email}
                </p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
