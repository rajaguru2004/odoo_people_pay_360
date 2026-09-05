/**
 * What a task attachment is allowed to be (finding R53).
 *
 * `FileInterceptor('file')` carried no `fileFilter` and no `limits` at all, so
 * an `.exe` and a `text/html` page uploaded cleanly into the PUBLIC bucket and
 * a 6 MB body was taken whole into memory. Employee documents and avatars have
 * policed both since they were written (`employees.controller.ts`); this is the
 * same shape, kept in one place because the resolver and the register-by-URL
 * door have to agree with the interceptor.
 */
export const TASK_ATTACHMENT_ALLOWED_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
] as const;

/**
 * 5 MB, the same ceiling `POST /employees/:id/avatar` uses. Multer holds the
 * whole body in memory (`memoryStorage` is its default and what StorageService
 * needs), so this number is a heap budget per concurrent upload, not a policy
 * preference.
 */
export const TASK_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** The private-bucket folder every task attachment is written into. */
export const TASK_ATTACHMENT_FOLDER = 'task-attachments';

export const TASK_ATTACHMENT_MIME_MESSAGE =
  'Only PDF, images, Word/Excel documents and plain text are allowed as task attachments';
