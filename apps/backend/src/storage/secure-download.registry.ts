/**
 * How one kind of private file is located and authorized.
 *
 * The download route is generic — it knows about authentication, auditing and
 * signing, but nothing about letters, grievances or payslips. Each domain says
 * which storage ref an id maps to and who may have it.
 */
export interface SecureFile {
  /** `private://...` ref from StorageService. */
  ref: string;
  /** Filename offered to the browser. */
  fileName: string;
  /** For the audit trail; usually the owning employee. */
  ownerEmployeeId?: string | null;
}

export interface SecureDownloadResolver {
  /** URL segment, e.g. 'letter' | 'grievance-attachment'. */
  readonly kind: string;

  /**
   * Locate the file and decide access in one step.
   *
   * MUST throw (ForbiddenException / NotFoundException) when the caller may not
   * have it — returning null is treated as "not found", so a resolver that
   * forgets to check would leak existence rather than content. Prefer throwing
   * NotFoundException over ForbiddenException where existence itself is
   * sensitive, matching `assertInBranch`.
   */
  resolve(id: string, user: any): Promise<SecureFile | null>;
}

export const SECURE_DOWNLOAD_RESOLVERS = Symbol('SECURE_DOWNLOAD_RESOLVERS');
