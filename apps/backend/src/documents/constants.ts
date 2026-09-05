/**
 * Letterhead and document-asset limits.
 *
 * Styled on `src/task-attachments/task-attachment.constants.ts`, and for the
 * same reason: the multer interceptor, the service validation and the error
 * message all have to agree, and three copies of a number is how they stop
 * agreeing.
 */

/**
 * PNG and JPEG only.
 *
 * SVG is refused even though the company-logo uploader accepts it: an SVG
 * carries `<script>` and external references, and this file is about to be
 * inlined into a page that also renders admin-authored HTML.
 *
 * PDF is refused in v1 with an explicit message rather than silently. There is
 * no rasteriser in the dependency tree, and accepting PDF would mean adding a
 * second PDF stack purely to flatten one background image.
 */
export const LETTERHEAD_ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/jpg'] as const;

/**
 * 5 MB, matching the avatar and task-attachment ceilings.
 *
 * Multer holds the whole body in memory, so this is a heap budget per
 * concurrent upload rather than a policy preference. It is also the ceiling on
 * what gets base64'd into every rendered document.
 */
export const LETTERHEAD_MAX_BYTES = 5 * 1024 * 1024;

/** Private bucket folder. Letterheads are never public — see the service. */
export const DOCUMENT_ASSET_FOLDER = 'document-assets';

export const LETTERHEAD_MIME_MESSAGE =
  'A letterhead must be a PNG or JPEG image. Export your letter pad at 150 DPI or better; ' +
  'PDF and SVG stationery are not supported.';

/**
 * Minimum pixels for A4 at 150 DPI (210 × 297 mm).
 *
 * Below this the artwork visibly softens when printed, and the person who
 * uploaded it will not find out until somebody prints a letter.
 */
export const LETTERHEAD_MIN_WIDTH_PX = 1240;
export const LETTERHEAD_MIN_HEIGHT_PX = 1754;

/** How far the aspect ratio may drift from the page before it is refused. */
export const LETTERHEAD_ASPECT_TOLERANCE = 0.05;

/** Magic bytes. The mimetype a client sends is a claim, not evidence. */
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
