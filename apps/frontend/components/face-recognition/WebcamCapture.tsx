'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, FlipHorizontal, RefreshCw } from 'lucide-react';

interface WebcamCaptureProps {
  onCapture: (imageBase64: string) => void;
  isProcessing?: boolean;
  width?: number;
  height?: number;
  buttonText?: string;
  showPreview?: boolean;
  /**
   * Longest edge of the captured frame, in pixels.
   *
   * The canvas is sized from `video.videoWidth`, NOT from the `width` prop — so
   * a 1080p webcam produced 400–700 KB of base64 against a request body limit.
   * Detection is unaffected: SSD MobileNet runs well below 720px, and the
   * payload drops roughly fourfold.
   */
  maxCaptureWidth?: number;
}

/**
 * The camera, and the frame it hands upwards.
 *
 * This component knows nothing about faces. It opens the camera, draws a frame
 * to a canvas and gives the caller a JPEG data URI — the recogniser runs on the
 * server, so there is no model to load here and nothing to gate the shutter on.
 */
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
    // Stop whatever is running first, or a retry leaves the old track live and
    // the indicator light on.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setError(null);
    setCapturedImage(null);
    setCameraReady(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: width },
          height: { ideal: height },
          facingMode: 'user',
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => setCameraReady(true);
      }
    } catch (err) {
      const domErr = err as DOMException;
      if (domErr.name === 'NotAllowedError') {
        setError('Camera access was refused. Allow it in your browser settings and try again.');
      } else if (domErr.name === 'NotFoundError') {
        setError('No camera was found. Connect one and try again.');
      } else {
        setError(`The camera would not open: ${domErr.message}`);
      }
    }
  }, [width, height]);

  // Opened once on mount, closed on unmount. The latest `startCamera` is held
  // in a ref so re-creating the callback never re-opens the camera.
  const startCameraRef = useRef(startCamera);
  useEffect(() => {
    startCameraRef.current = startCamera;
  }, [startCamera]);

  useEffect(() => {
    void startCameraRef.current();
    return () => {
      // Every track has to be stopped by hand. Unmounting the element leaves
      // the camera running.
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    // Downscale to the cap, keeping the aspect ratio. A modern webcam reports
    // 1920x1080 here, which is four times the payload for no gain in detection.
    const scale = Math.min(1, maxCaptureWidth / (video.videoWidth || maxCaptureWidth));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (isMirrored) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const base64 = canvas.toDataURL('image/jpeg', 0.8);
    if (showPreview) setCapturedImage(base64);
    onCapture(base64);
  }, [isMirrored, onCapture, showPreview, maxCaptureWidth]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center rounded-[var(--radius-card)] border-2 border-dashed border-status-error/30 bg-status-error-bg/40 p-8">
        <Camera className="mb-3 h-12 w-12 text-status-error" aria-hidden />
        <p className="mb-4 text-center text-sm text-status-error">{error}</p>
        <button
          type="button"
          onClick={() => void startCamera()}
          className="rounded-[var(--radius-button)] bg-status-error px-4 py-2 text-sm text-text-on-brand hover:bg-status-error/90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative overflow-hidden rounded-[var(--radius-card)] border-2 border-surface-border bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          aria-label="Camera preview"
          className={capturedImage && showPreview ? 'hidden' : 'block'}
          style={{
            width,
            height,
            maxWidth: '100%',
            transform: isMirrored ? 'scaleX(-1)' : 'none',
          }}
        />

        {capturedImage && showPreview && (
          <img
            src={capturedImage}
            alt="The frame just captured"
            style={{ width, height, maxWidth: '100%', objectFit: 'cover' }}
          />
        )}

        {/* Where to put your face. A frame filled edge to edge detects best. */}
        {!capturedImage && cameraReady && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div
              className={`h-56 w-44 rounded-full border-2 border-dashed ${
                isProcessing ? 'animate-pulse border-brand-primary' : 'border-white/60'
              }`}
            />
          </div>
        )}

        {isProcessing && !capturedImage && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-[1px]">
            <div className="mb-3 h-10 w-10 animate-spin rounded-full border-4 border-white border-t-transparent" />
            <p className="text-sm font-semibold text-white drop-shadow">Reading the face…</p>
          </div>
        )}

        {!cameraReady && (
          <div
            className="flex items-center justify-center bg-black"
            style={{ width, height, maxWidth: '100%' }}
          >
            <div className="text-center text-white">
              <RefreshCw className="mx-auto mb-2 h-8 w-8 animate-spin" aria-hidden />
              <p className="text-sm">Opening the camera…</p>
            </div>
          </div>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />

      <div className="flex gap-3">
        {capturedImage && showPreview ? (
          // The frozen frame is what was sent. Until it is cleared the shutter
          // is gone on purpose: a second capture taken against a preview the
          // person is no longer posing for is the one they did not mean to send.
          <button
            type="button"
            data-testid="webcam-retake"
            onClick={() => setCapturedImage(null)}
            disabled={isProcessing}
            className="flex items-center gap-2 rounded-[var(--radius-button)] border border-surface-border px-6 py-3 font-semibold text-text-body transition-colors hover:bg-surface-page disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className="h-5 w-5" aria-hidden />
            Take it again
          </button>
        ) : (
          <>
            <button
              type="button"
              data-testid="webcam-shutter"
              onClick={capturePhoto}
              disabled={!cameraReady || isProcessing}
              className="flex items-center gap-2 rounded-[var(--radius-button)] bg-brand-primary px-6 py-3 font-semibold text-text-on-brand transition-colors hover:bg-brand-primary-dark disabled:cursor-not-allowed disabled:bg-surface-border-light disabled:text-text-muted"
            >
              {isProcessing ? (
                <>
                  <RefreshCw className="h-5 w-5 animate-spin" aria-hidden />
                  Working…
                </>
              ) : (
                <>
                  <Camera className="h-5 w-5" aria-hidden />
                  {buttonText}
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => setIsMirrored((on) => !on)}
              className="rounded-[var(--radius-button)] border border-surface-border p-3 text-text-body transition-colors hover:bg-surface-page"
              title="Flip the camera"
              aria-label="Flip the camera"
            >
              <FlipHorizontal className="h-5 w-5" aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
