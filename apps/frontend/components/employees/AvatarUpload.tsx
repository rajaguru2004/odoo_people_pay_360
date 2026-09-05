'use client';

import React, { useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Camera, Eye, Upload, X } from 'lucide-react';
import AvatarUploadModal from './AvatarUploadModal';
import { resolveFileUrl } from '@/utils/fileUrl';

interface AvatarUploadProps {
  currentAvatar?: string;
  employeeName: string;
  onUpload: (file: File) => Promise<void>;
  disabled?: boolean;
}

export default function AvatarUpload({
  currentAvatar,
  employeeName,
  onUpload,
  disabled = false,
}: AvatarUploadProps) {
  const t = useTranslations('avatarUpload');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  const avatarUrl = resolveFileUrl(currentAvatar);

  const initials = employeeName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const handleUploadSuccess = async (file: File) => {
    try {
      await onUpload(file);
      setShowUploadModal(false); // Avatar will be updated by parent component
    } catch (error) {
      // Error is handled by parent
      throw error;
    }
  };

  return (
    <>
      <div className="flex flex-col items-center gap-3">
        {/* Avatar Display - Large 192px */}
        <div className="relative group">
          {/* Decorative ring */}
          <div className="absolute -inset-1 bg-gradient-to-r from-brand-primary via-blue-500 to-purple-500 rounded-full opacity-0 group-hover:opacity-75 blur-lg transition-all duration-300"></div>
          
          <div
            className="relative w-48 h-48 rounded-full overflow-hidden border-4 border-white shadow-2xl transition-all duration-300 group-hover:scale-105 cursor-pointer"
            onClick={() => !disabled && avatarUrl && setShowPreviewModal(true)}
          >
            {avatarUrl ? (
              <Image src={avatarUrl} alt={employeeName} fill className="object-cover" unoptimized />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-brand-primary via-brand-primary to-purple-600 flex items-center justify-center">
                <span className="text-6xl font-bold text-white drop-shadow-lg">{initials}</span>
              </div>
            )}

            {/* Overlay on hover */}
            {!disabled && (
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-all duration-300 flex flex-col items-center justify-end pb-6 gap-3">
                <div className="flex items-center gap-3">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowUploadModal(true);
                    }}
                    className="p-3 bg-white/95 backdrop-blur-sm rounded-full hover:bg-white hover:scale-110 transition-all duration-200 shadow-lg"
                    title={t('changePhoto')}
                  >
                    <Camera size={20} className="text-brand-primary" />
                  </button>
                  {avatarUrl && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowPreviewModal(true);
                      }}
                      className="p-3 bg-white/95 backdrop-blur-sm rounded-full hover:bg-white hover:scale-110 transition-all duration-200 shadow-lg"
                      title={t('viewPhoto')}
                    >
                      <Eye size={20} className="text-brand-primary" />
                    </button>
                  )}
                </div>
                <p className="text-white text-xs font-semibold drop-shadow-lg">
                  {avatarUrl ? t('viewOrChangePhotos') : t('uploadPhoto')}
                </p>
              </div>
            )}
          </div>

          {/* Upload badge for no avatar */}
          {!disabled && !avatarUrl && (
            <button
              onClick={() => setShowUploadModal(true)}
              className="absolute bottom-2 end-2 p-3 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-white rounded-full shadow-xl hover:shadow-2xl hover:scale-110 transition-all duration-200 z-10"
              title={t('uploadPhoto')}
            >
              <Upload size={20} />
            </button>
          )}
        </div>

        {/* Minimal hint */}
        {!disabled && (
          <p className="text-xs text-gray-500 text-center">
            {avatarUrl ? t('clickToViewChange') : t('uploadHint')}
          </p>
        )}
      </div>

      {/* Upload Modal */}
      <AvatarUploadModal
        isOpen={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        onUpload={handleUploadSuccess}
        employeeName={employeeName}
      />

      {/* Preview Modal - Enhanced */}
      {showPreviewModal && avatarUrl && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/95 backdrop-blur-md animate-in fade-in duration-200"
          onClick={() => setShowPreviewModal(false)}
        >
          <div className="relative max-w-5xl max-h-[90vh] p-8 animate-in zoom-in-95 duration-300">
            {/* Close button */}
            <button
              onClick={() => setShowPreviewModal(false)}
              className="absolute -top-4 -end-4 p-3 bg-white hover:bg-gray-100 rounded-full shadow-2xl transition-all duration-200 hover:scale-110 z-10"
              title={t('close')}
            >
              <X size={24} className="text-gray-700" />
            </button>

            {/* Image container */}
            <div className="relative bg-white rounded-2xl shadow-2xl overflow-hidden">
              <img
                src={avatarUrl}
                alt={employeeName}
                className="max-w-full max-h-[80vh] w-auto h-auto mx-auto"
                onClick={(e) => e.stopPropagation()}
              />
            </div>

            {/* Info bar */}
            <div className="mt-6 bg-white/10 backdrop-blur-md rounded-xl px-6 py-4 text-center">
              <p className="text-white text-xl font-semibold">{employeeName}</p>
              <p className="text-white/70 text-sm mt-1">{t('avatarImage')}</p>
            </div>

            {/* Action button */}
            <div className="mt-4 flex justify-center">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowPreviewModal(false);
                  setShowUploadModal(true);
                }}
                className="px-6 py-3 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-white rounded-xl hover:shadow-xl transition-all duration-200 hover:scale-105 flex items-center gap-2"
              >
                <Camera size={20} />
                <span>{t('changePhoto')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
