'use client';

import { useRef, useCallback, useState, useEffect } from 'react';
import { Camera, RefreshCw, FlipHorizontal } from 'lucide-react';

interface WebcamCaptureProps {
  onCapture: (imageBase64: string) => void;
  isProcessing?: boolean;
  width?: number;
  height?: number;
  buttonText?: string;
  buttonIcon?: 'camera' | 'check-in';
  showPreview?: boolean;
  /**
   * Longest edge of the captured frame, in pixels.
   *
   * The canvas is sized from `video.videoWidth`, NOT from the `width` prop —
   * so a 1080p webcam produced 400-700 KB of base64 against a 1 MB request
   * body limit. Detection is unaffected: SSD MobileNet runs well below 720px,
   * and the payload drops roughly fourfold.
   */
  maxCaptureWidth?: number;
}

export default function WebcamCapture({
  onCapture,
  isProcessing = false,
  width = 640,
  height = 480,
  buttonText = 'Take a photo',
  showPreview = true,
  maxCaptureWidth = 720,
}: WebcamCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [isMirrored, setIsMirrored] = useState(true);
  const [cameraReady, setCameraReady] = useState(false);

  const startCamera = useCallback(async () => {
    // Stop any previous stream first
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setError(null);
    setCapturedImage(null);
    setCameraReady(false);

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: width },
          height: { ideal: height },
          facingMode: 'user',
        },
        audio: false,
      });

      streamRef.current = mediaStream;

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.onloadedmetadata = () => {
          setCameraReady(true);
        };
      }
    } catch (err: unknown) {
      const domErr = err as DOMException;
      if (domErr.name === 'NotAllowedError') {
        setError('You need to allow camera access. Please check your browser settings.');
      } else if (domErr.name === 'NotFoundError') {
        setError('Camera not found. Please connect the webcam and try again.');
      } else {
        setError(`Error opening camera: ${domErr.message}`);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  // Start camera once on mount; stop it on unmount.
  // We use a ref to the latest startCamera so the effect never needs to re-run.
  const startCameraRef = useRef(startCamera);
  useEffect(() => { startCameraRef.current = startCamera; }, [startCamera]);

  useEffect(() => {
    startCameraRef.current();
    return () => {
      // Directly stop via ref — always has the current stream regardless of closure.
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, []); // intentionally empty — runs only once on mount

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    // Downscale to the capture cap, preserving aspect ratio. A modern webcam
    // reports 1920x1080 here, which is four times the payload for no gain in
    // detection quality.
    const scale = Math.min(1, maxCaptureWidth / (video.videoWidth || maxCaptureWidth));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Mirror the image if needed
    if (isMirrored) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Reset transform
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const base64 = canvas.toDataURL('image/jpeg', 0.8);
    // Only show preview if requested; for live check-in we stay in live camera mode
    if (showPreview) {
      setCapturedImage(base64);
    }
    onCapture(base64);
  }, [isMirrored, onCapture, showPreview, maxCaptureWidth]);

  const retake = useCallback(() => {
    setCapturedImage(null);
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center rounded-[--radius-card] border-2 border-dashed border-status-error/30 bg-status-error-bg/40 p-8">
        <Camera className="mb-3 h-12 w-12 text-status-error" />
        <p className="mb-4 text-center text-sm text-status-error">{error}</p>
        <button
          onClick={startCamera}
          className="rounded-[--radius-button] bg-status-error px-4 py-2 text-sm text-text-on-brand hover:bg-status-error/90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Video / Preview area */}
      <div className="relative overflow-hidden rounded-[--radius-card] border-2 border-surface-border bg-black">
        {/* Live video feed */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`${capturedImage && showPreview ? 'hidden' : 'block'}`}
          style={{
            width,
            height,
            maxWidth: '100%',
            transform: isMirrored ? 'scaleX(-1)' : 'none',
          }}
        />

        {/* Captured preview */}
        {capturedImage && showPreview && (
          <img
            src={capturedImage}
            alt="Captured"
            style={{ width, height, maxWidth: '100%', objectFit: 'cover' }}
          />
        )}

        {/* Face guide overlay */}
        {!capturedImage && cameraReady && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className={`h-56 w-44 rounded-full border-2 border-dashed ${isProcessing ? 'border-brand-primary animate-pulse' : 'border-white/60'}`} />
          </div>
        )}

        {/* Scanning animation overlay */}
        {isProcessing && !capturedImage && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-[1px]">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white border-t-transparent mb-3" />
            <p className="text-sm font-semibold text-white drop-shadow">Scanning faces...</p>
          </div>
        )}

        {/* Loading / not ready */}
        {!cameraReady && !error && (
          <div
            className="flex items-center justify-center bg-slate-900" /* neutral */
            style={{ width, height, maxWidth: '100%' }}
          >
            <div className="text-center text-white">
              <RefreshCw className="mx-auto mb-2 h-8 w-8 animate-spin" />
              <p className="text-sm">Opening the camera...</p>
            </div>
          </div>
        )}
      </div>

      {/* Hidden canvas for capture */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Controls */}
      <div className="flex gap-3">
        {!capturedImage ? (
          <>
            <button
              data-testid="webcam-shutter"
              onClick={capturePhoto}
              disabled={!cameraReady || isProcessing}
              className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary px-6 py-3 font-semibold text-text-on-brand transition-colors hover:bg-brand-primary-dark disabled:cursor-not-allowed disabled:bg-surface-border-light disabled:text-text-muted"
            >
              {isProcessing ? (
                <>
                  <RefreshCw className="h-5 w-5 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Camera className="h-5 w-5" />
                  {buttonText}
                </>
              )}
            </button>

            <button
              onClick={() => setIsMirrored(!isMirrored)}
              className="rounded-[--radius-button] border border-surface-border p-3 text-text-body transition-colors hover:bg-surface-page"
              title="Flip the camera"
            >
              <FlipHorizontal className="h-5 w-5" />
            </button>
          </>
        ) : (
          <div className="flex gap-3">
            <button
              onClick={retake}
              disabled={isProcessing}
              className="flex items-center gap-2 rounded-[--radius-button] border border-surface-border px-6 py-3 font-semibold text-text-body transition-colors hover:bg-surface-page disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className="h-5 w-5" />
              Take a picture
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
