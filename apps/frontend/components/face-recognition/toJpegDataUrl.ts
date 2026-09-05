/** The cap the webcam capture uses, so both paths send the same kind of frame. */
export const MAX_UPLOAD_WIDTH = 720;

/**
 * Re-encode a chosen file as a downscaled JPEG.
 *
 * The uploaded file is NOT sent as it was chosen. Two reasons, and the second
 * is the one that bites:
 *
 *  - Size. A phone photo is several megabytes; through the canvas it is tens of
 *    kilobytes, and detection is unaffected — the detector runs well below this
 *    width either way.
 *  - Format. The server decodes with @napi-rs/canvas, whose in-memory decoder
 *    refuses a PNG carrying a private metadata chunk — `caBX`, the content
 *    credentials that AI tools and newer phone cameras write. Such a file loads
 *    perfectly in the browser and fails on the server, which is the worst shape
 *    a bug can have. Re-encoding here means the server only ever sees the one
 *    format the webcam path already produces.
 */
export function toJpegDataUrl(
  file: File,
  maxWidth = MAX_UPLOAD_WIDTH,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxWidth / (image.naturalWidth || maxWidth));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('This browser would not prepare the photo.'));
        return;
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };

    image.src = url;
  });
}
