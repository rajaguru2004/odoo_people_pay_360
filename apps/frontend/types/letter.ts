export type LetterStatus = 'PENDING' | 'ISSUED' | 'REJECTED';
export type LetterLocale = 'en' | 'ar';

export interface LetterTemplate {
  id: string;
  key: string;
  name: string;
  locale: LetterLocale;
  bodyHtml: string;
  /** false issues instantly; true routes through HR. */
  requiresApproval: boolean;
  isActive: boolean;
}

export interface LetterRequest {
  id: string;
  employeeId: string;
  templateKey: string;
  locale: LetterLocale;
  purpose: string | null;
  addressedTo: string | null;
  status: LetterStatus;
  /** Printed on the letter and verifiable publicly. */
  serialNumber: string | null;
  /** The EmployeeDocument the letter was filed as — the download handle. */
  documentId: string | null;
  issuedAt: string | null;
  rejectedReason: string | null;
  createdAt: string;
  employee?: LetterEmployeeCard;
}

/**
 * The employee card every letter LIST row carries (`GET /letters` and
 * `GET /letters/my-requests`). Absent from the single-row responses — `POST
 * /letters`, `/issue`, `/reject` all return the bare `LetterRequest` — which is
 * why `LetterRequest.employee` stays optional while these two fields do not.
 *
 * R66. A termination writes `Employee.status = 'INACTIVE'` instead of deleting
 * the row, so `LetterRequest`'s cascade never fires and an open request outlives
 * its subject's exit — still PENDING, still in `GET /letters?status=PENDING`,
 * which is the HR queue's default filter. Issuing after an exit is legitimate
 * (an experience or service letter is most often asked for precisely then), so
 * the flag gates nothing on either side: it exists so the queue can say whose
 * request this is.
 */
export interface LetterEmployeeCard {
  id: string;
  employeeCode: string;
  fullName: string;
  /** Raw `Employee.status` — `ACTIVE`, `INACTIVE`, … Shown, never compared. */
  status: string;
  /**
   * Derived server-side as `status !== 'ACTIVE'`. Read this rather than testing
   * the string: R72 records that all three exits write `INACTIVE` and that
   * `TERMINATED` is a CONTRACT status, so keying on `'TERMINATED'` here would
   * miss every leaver.
   */
  isFormerEmployee: boolean;
  department?: { name: string } | null;
}

/**
 * The envelope `POST /letters/:id/issue` and `POST /letters/:id/reject` return.
 *
 * `warning` is a SIBLING of `data`, not a field inside it. `lib/axios.ts`
 * resolves with the whole `response.data`, so it arrives intact on the object
 * the service returns — but only if the caller looks for it at the top level.
 * Reading `res.data.warning` finds nothing and drops the one line telling HR
 * they just minted a letter for someone who has left (R66).
 */
export interface LetterDecisionResult {
  success: boolean;
  message?: string;
  data: LetterRequest;
  /** Present only when the subject is no longer ACTIVE. Never a refusal. */
  warning?: string;
}

export interface RequestLetterData {
  templateKey: string;
  locale?: LetterLocale;
  purpose?: string;
  addressedTo?: string;
}
