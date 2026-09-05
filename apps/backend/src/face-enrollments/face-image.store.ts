import { Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

const logger = new Logger('FaceImageStore');

/** Served statically at `/uploads/` by `main.ts`. */
const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');
const FACE_DIR = 'face-enrollments';

/**
 * The reference photo kept beside an enrolment.
 *
 * It is NOT the template — the template is 128 floats in the database and never
 * leaves it. This is the thumbnail the enrolment gallery draws, so an HR manager
 * looking at "three captures on file" can see which three, and delete the one
 * taken with a hand across the face rather than all of them.
 */
export async function saveFaceImage(
  employeeId: string,
  image: string,
  now: number,
): Promise<string | null> {
  try {
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const dir = path.join(UPLOAD_ROOT, FACE_DIR, employeeId);
    await fs.mkdir(dir, { recursive: true });
    const fileName = `${now}.jpg`;
    await fs.writeFile(path.join(dir, fileName), Buffer.from(base64, 'base64'));
    return `/uploads/${FACE_DIR}/${employeeId}/${fileName}`;
  } catch (error) {
    // A gallery thumbnail is not worth failing an enrolment over. The template
    // is what matching uses, and it is already computed by this point.
    logger.warn(
      `Could not store the reference photo: ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * Remove a stored photo.
 *
 * Refuses any path that does not sit under the face directory, so a crafted
 * `imageUrl` in the column cannot be turned into a delete anywhere on disk.
 */
export async function deleteFaceImage(imageUrl: string | null): Promise<void> {
  if (!imageUrl?.startsWith(`/uploads/${FACE_DIR}/`)) return;

  const target = path.resolve(UPLOAD_ROOT, imageUrl.replace('/uploads/', ''));
  const root = path.resolve(UPLOAD_ROOT, FACE_DIR);
  if (target !== root && !target.startsWith(root + path.sep)) return;

  try {
    await fs.unlink(target);
  } catch {
    // Already gone is the outcome we wanted.
  }
}
