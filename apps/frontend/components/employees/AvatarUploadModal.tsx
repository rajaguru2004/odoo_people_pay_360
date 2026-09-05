'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import Cropper from 'react-easy-crop';
import { X, Upload, RotateCw, ZoomIn, Check, Image as ImageIcon, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';

interface AvatarUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUpload: (file: File) => Promise<void>;
  employeeName: string;
}

interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB — mirrors the backend limit
const OUTPUT_SIZE = 512; // bounded square output keeps uploads small & consistent

export default function AvatarUploadModal({ isOpen, onClose, onUpload, employeeName }: AvatarUploadModalProps) {
  const t = useTranslations('avatarUploadModal');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<CropArea | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onCropComplete = useCallback((_croppedArea: any, areaPixels: CropArea) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  const resetState = useCallback(() => {
    setSelectedImage(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setRotation(0);
    setCroppedAreaPixels(null);
    setOriginalFile(null);
    setUploadProgress(0);
    setDragActive(false);
  }, []);

  const handleClose = useCallback(() => {
    if (uploading) return; // never abandon an in-flight upload
    resetState();
    onClose();
  }, [uploading, resetState, onClose]);

  // ESC closes the modal (X mirrors this); lock background scroll while open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, handleClose]);

  // Shared entry point for both the file picker and drag-and-drop.
  const processFile = (file: File | undefined | null) => {
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error(t('selectImageFile'));
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      toast.error(t('fileSizeLimit'));
      return;
    }

    // Fresh image → reset any prior crop/zoom/rotation.
    setOriginalFile(file);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setRotation(0);
    setCroppedAreaPixels(null);

    const reader = new FileReader();
    reader.onloadend = () => setSelectedImage(reader.result as string);
    reader.onerror = () => toast.error(t('fileReadError'));
    reader.readAsDataURL(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    processFile(e.target.files?.[0]);
    e.target.value = ''; // allow re-selecting the same file after cancel
  };

  // ── Drag & drop ──
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    processFile(e.dataTransfer.files?.[0]);
  };

  // ── Cropping ──
  const createImage = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener('load', () => resolve(image));
      image.addEventListener('error', (err) => reject(err));
      image.src = url;
    });

  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  /**
   * Crops (and optionally rotates) the selected image into a bounded square
   * JPEG. Uses a rotated intermediate canvas + a single scaled drawImage — no
   * multi-megapixel getImageData/putImageData round-trip, so it stays fast and
   * memory-safe even for large source photos.
   */
  const getCroppedImg = async (imageSrc: string, pixelCrop: CropArea, rotation = 0): Promise<Blob> => {
    const image = await createImage(imageSrc);
    const rot = toRadians(rotation);

    // Bounding box of the rotated source.
    const bBoxWidth = Math.abs(Math.cos(rot) * image.width) + Math.abs(Math.sin(rot) * image.height);
    const bBoxHeight = Math.abs(Math.sin(rot) * image.width) + Math.abs(Math.cos(rot) * image.height);

    const rotCanvas = document.createElement('canvas');
    const rotCtx = rotCanvas.getContext('2d');
    if (!rotCtx) throw new Error('No 2d context');
    rotCanvas.width = bBoxWidth;
    rotCanvas.height = bBoxHeight;
    rotCtx.translate(bBoxWidth / 2, bBoxHeight / 2);
    rotCtx.rotate(rot);
    rotCtx.drawImage(image, -image.width / 2, -image.height / 2);

    // Bounded square output canvas.
    const size = Math.max(1, Math.min(OUTPUT_SIZE, Math.round(pixelCrop.width)));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2d context');
    canvas.width = size;
    canvas.height = size;

    // JPEG has no alpha channel — flatten onto white to avoid black corners.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      rotCanvas,
      pixelCrop.x,
      pixelCrop.y,
      pixelCrop.width,
      pixelCrop.height,
      0,
      0,
      size,
      size,
    );

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Canvas is empty'))),
        'image/jpeg',
        0.92,
      );
    });
  };

  const handleUpload = async () => {
    if (!selectedImage || !croppedAreaPixels || !originalFile || uploading) return;

    setUploading(true);
    setUploadProgress(0);
    // Smoothly creep toward 90% while the request is in flight; jump to 100% on success.
    const timer = setInterval(() => {
      setUploadProgress((p) => (p < 90 ? p + 5 : p));
    }, 120);

    // Step 1 — crop locally. A failure here is our problem, so we surface it.
    let croppedFile: File;
    try {
      const croppedBlob = await getCroppedImg(selectedImage, croppedAreaPixels, rotation);
      croppedFile = new File([croppedBlob], 'avatar.jpg', {
        type: 'image/jpeg',
        lastModified: Date.now(),
      });
    } catch (error) {
      clearInterval(timer);
      setUploadProgress(0);
      setUploading(false);
      console.error('Avatar crop failed:', error);
      toast.error(t('imageProcessError'));
      return;
    }

    // Step 2 — hand off to the parent, which posts to the server and toasts on failure.
    try {
      await onUpload(croppedFile);
      clearInterval(timer);
      setUploadProgress(100);
      await new Promise((resolve) => setTimeout(resolve, 400));
      resetState();
      onClose();
    } catch (error) {
      // The parent already showed an error toast — just recover so the user can retry.
      clearInterval(timer);
      setUploadProgress(0);
      console.error('Avatar upload failed:', error);
    } finally {
      setUploading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm animate-in fade-in duration-200 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-300">
        {/* Header */}
        <div className="relative bg-gradient-to-r from-brand-primary to-brand-primary-dark p-5">
          <div className="flex items-center justify-between text-white">
            <div className="flex-1 pe-4">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <div className="p-1.5 bg-white/20 rounded-lg backdrop-blur-sm">
                  <ImageIcon size={20} />
                </div>
                {t('title')}
              </h2>
              <p className="text-brand-primary-light mt-1 text-sm truncate">{employeeName}</p>
            </div>
            <button
              onClick={handleClose}
              disabled={uploading}
              className="p-2 hover:bg-white/20 rounded-lg transition-all disabled:opacity-50 backdrop-blur-sm flex-shrink-0"
              aria-label={t('title')}
            >
              <X size={20} />
            </button>
          </div>

          {/* Progress bar */}
          {uploading && (
            <div className="mt-3">
              <div className="flex items-center justify-between text-white text-xs mb-1.5">
                <span>{t('uploading')}</span>
                <span className="font-semibold">{uploadProgress}%</span>
              </div>
              <div className="h-1.5 bg-white/20 rounded-full overflow-hidden backdrop-blur-sm">
                <div
                  className="h-full bg-white rounded-full transition-all duration-300 ease-out shadow-lg"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto max-h-[calc(90vh-140px)]">
          {!selectedImage ? (
            /* Upload Area */
            <div className="space-y-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
              />
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragEnter={handleDrag}
                onDragOver={handleDrag}
                onDragLeave={handleDrag}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all duration-300 group focus:outline-none focus:ring-2 focus:ring-brand-primary/40 ${
                  dragActive
                    ? 'border-brand-primary bg-gradient-to-br from-blue-50 to-purple-50 scale-[1.01]'
                    : 'border-slate-300 hover:border-brand-primary hover:bg-gradient-to-br hover:from-blue-50 hover:to-purple-50'
                }`}
              >
                <div className="relative inline-block pointer-events-none">
                  <div className="absolute inset-0 bg-gradient-to-r from-brand-primary to-purple-500 rounded-full blur-xl opacity-0 group-hover:opacity-30 transition-opacity duration-300" />
                  <Upload
                    className={`relative mx-auto transition-colors duration-300 ${
                      dragActive ? 'text-brand-primary' : 'text-slate-400 group-hover:text-brand-primary'
                    }`}
                    size={48}
                  />
                </div>
                <p className="text-lg font-semibold text-slate-700 mb-2 mt-4">
                  {dragActive ? t('dropHere') : t('selectPhotoHeading')}
                </p>
                <p className="text-sm text-slate-500 mb-5">{t('dragDropOrClick')}</p>
                <div className="flex flex-col items-center gap-2 pointer-events-none">
                  <span className="inline-block px-6 py-3 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-white rounded-xl shadow-sm group-hover:shadow-lg transition-all duration-200 font-medium">
                    <span className="flex items-center gap-2">
                      <Upload size={18} />
                      {t('selectImageButton')}
                    </span>
                  </span>
                  <p className="text-xs text-slate-400">{t('fileTypeHint')}</p>
                </div>
              </div>

              {/* Tips */}
              <div className="bg-gradient-to-br from-blue-50 to-purple-50 rounded-xl p-4 border border-brand-primary-light/20">
                <h3 className="font-semibold text-slate-700 mb-2 flex items-center gap-2 text-sm">
                  <div className="w-1.5 h-1.5 bg-brand-primary rounded-full" />
                  {t('tipsHeading')}
                </h3>
                <ul className="space-y-1.5 text-xs text-slate-600">
                  <li className="flex items-start gap-2">
                    <span className="text-brand-primary mt-0.5">•</span>
                    <span>{t('tipPortrait')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-primary mt-0.5">•</span>
                    <span>{t('tipBackground')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-primary mt-0.5">•</span>
                    <span>{t('tipResolution')}</span>
                  </li>
                </ul>
              </div>
            </div>
          ) : (
            /* Crop Area */
            <div className="space-y-4">
              {/* Cropper — container MUST be positioned; react-easy-crop absolutely positions its contents */}
              <div className="relative h-80 bg-slate-900 rounded-xl overflow-hidden shadow-inner">
                <Cropper
                  image={selectedImage}
                  crop={crop}
                  zoom={zoom}
                  rotation={rotation}
                  aspect={1}
                  cropShape="round"
                  showGrid={false}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onRotationChange={setRotation}
                  onCropComplete={onCropComplete}
                />
              </div>

              {/* Controls */}
              <div className="space-y-4 bg-gradient-to-br from-slate-50 to-blue-50 rounded-xl p-4 border border-slate-200">
                {/* Zoom */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      <div className="p-1 bg-brand-primary/10 rounded">
                        <ZoomIn size={14} className="text-brand-primary" />
                      </div>
                      {t('zoom')}
                    </label>
                    <span className="text-xs font-semibold text-brand-primary bg-brand-primary-light/20 px-2 py-0.5 rounded-lg">
                      {Math.round(zoom * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={3}
                    step={0.1}
                    value={zoom}
                    disabled={uploading}
                    onChange={(e) => setZoom(Number(e.target.value))}
                    className="w-full h-2 bg-slate-200 rounded-full appearance-none cursor-pointer accent-brand-primary hover:accent-brand-primary-dark transition-colors disabled:opacity-50"
                    style={{
                      background: `linear-gradient(to right, rgb(37, 99, 235) 0%, rgb(37, 99, 235) ${
                        ((zoom - 1) / 2) * 100
                      }%, rgb(226, 232, 240) ${((zoom - 1) / 2) * 100}%, rgb(226, 232, 240) 100%)`,
                    }}
                  />
                </div>

                {/* Rotation */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      <div className="p-1 bg-brand-primary/10 rounded">
                        <RotateCw size={14} className="text-brand-primary" />
                      </div>
                      {t('rotatePhoto')}
                    </label>
                    <span className="text-xs font-semibold text-brand-primary bg-brand-primary-light/20 px-2 py-0.5 rounded-lg">
                      {rotation}°
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={360}
                    step={1}
                    value={rotation}
                    disabled={uploading}
                    onChange={(e) => setRotation(Number(e.target.value))}
                    className="w-full h-2 bg-slate-200 rounded-full appearance-none cursor-pointer accent-brand-primary hover:accent-brand-primary-dark transition-colors disabled:opacity-50"
                    style={{
                      background: `linear-gradient(to right, rgb(37, 99, 235) 0%, rgb(37, 99, 235) ${
                        (rotation / 360) * 100
                      }%, rgb(226, 232, 240) ${(rotation / 360) * 100}%, rgb(226, 232, 240) 100%)`,
                    }}
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setSelectedImage(null);
                    setCroppedAreaPixels(null);
                  }}
                  disabled={uploading}
                  className="flex-1 px-4 py-3 border-2 border-slate-300 text-slate-700 rounded-xl hover:bg-slate-50 hover:border-slate-400 transition-all duration-200 disabled:opacity-50 font-medium text-sm"
                >
                  {t('chooseAnotherPhoto')}
                </button>
                <button
                  onClick={handleUpload}
                  disabled={uploading || !croppedAreaPixels}
                  className="flex-1 px-4 py-3 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-white rounded-xl hover:shadow-lg hover:scale-105 transition-all duration-200 disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2 font-medium text-sm"
                >
                  {uploading ? (
                    <>
                      <Loader2 size={18} className="animate-spin" />
                      <span>{t('processing')}</span>
                    </>
                  ) : (
                    <>
                      <Check size={18} />
                      <span>{t('confirmAndUpload')}</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
