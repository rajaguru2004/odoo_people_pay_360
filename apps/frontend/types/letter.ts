export type LetterStatus = 'PENDING' | 'ISSUED' | 'REJECTED';
export type LetterLocale = 'en' | 'ar';

export interface LetterTemplate {
  id: string;
  key: string;
  name: string;
  locale: LetterLocale;
  bodyHtml: string;
  requiresApproval: boolean;
  isActive: boolean;
}

export interface LetterRequestEmployee {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  fullName: string;
  status: string;
  /**
   * A termination changes a status rather than deleting the row, so a request
   * outlives its subject's exit and sits in the queue's default filter. It may
   * still be issued — the flag says whose request it is, it gates nothing.
   */
  isFormerEmployee: boolean;
  department?: { id: string; name: string } | null;
}

export interface LetterRequest {
  id: string;
  employeeId: string;
  templateKey: string;
  locale: LetterLocale;
  purpose: string | null;
  addressedTo: string | null;
  status: LetterStatus;
  serialNumber: string | null;
  documentId: string | null;
  rejectedReason: string | null;
  issuedAt: string | null;
  createdAt: string;
  employee: LetterRequestEmployee;
}

export interface RequestLetterData {
  templateKey: string;
  locale?: LetterLocale;
  purpose?: string;
  addressedTo?: string;
}
