import type { EmployeeRef } from './common';

export type LegalDocumentCategory =
  | 'VISA'
  | 'LABOUR_CARD'
  | 'CIVIL_ID'
  | 'NATIONAL_ID'
  | 'WORK_PERMIT'
  | 'PASSPORT'
  | 'RESIDENCE_PERMIT';

export type LegalDocumentStatus = 'ACTIVE' | 'EXPIRED' | 'RENEWED' | 'CANCELLED';

export interface LegalDocument {
  id: string;
  employeeId: string;
  category: LegalDocumentCategory;
  status: LegalDocumentStatus;
  documentNumber: string;
  documentType?: string | null;
  country: string;
  nationality?: string | null;
  issueDate: string;
  expiryDate: string;
  issuingAuthority?: string | null;
  placeOfIssue?: string | null;
  sponsor?: string | null;
  remarks?: string | null;
  /** One current document per (employee, category); a renewal demotes the last. */
  isCurrent: boolean;
  renewedFromId?: string | null;
  documentUrl?: string | null;

  employee?: EmployeeRef & {
    department?: { id: string; name: string } | null;
    branch?: { id: string; name: string } | null;
  };
  renewedFrom?: LegalDocument | null;
  renewals?: LegalDocument[];

  /**
   * Derived server-side, never stored. `EXPIRING_SOON` is not a status: it is
   * a window around a date that moves every day, and storing it would need a
   * nightly job to keep every row honest.
   */
  daysUntilExpiry: number;
  isExpiringSoon: boolean;

  createdAt: string;
  updatedAt: string;
}

export interface LegalDocumentSummary {
  active: number;
  expiringSoon: number;
  expired: number;
  cancelled: number;
  renewedThisYear: number;
  /** The alert window the server used, so the screen can name it. */
  alertDays: number;
}

export interface CreateLegalDocumentPayload {
  employeeId: string;
  category?: LegalDocumentCategory;
  documentNumber: string;
  documentType?: string;
  country: string;
  nationality?: string;
  issueDate: string;
  expiryDate: string;
  issuingAuthority?: string;
  placeOfIssue?: string;
  sponsor?: string;
  remarks?: string;
}

export type UpdateLegalDocumentPayload = Partial<
  Omit<CreateLegalDocumentPayload, 'employeeId'>
>;

export interface RenewLegalDocumentPayload {
  documentNumber: string;
  issueDate: string;
  expiryDate: string;
  documentType?: string;
  issuingAuthority?: string;
  placeOfIssue?: string;
  sponsor?: string;
  remarks?: string;
}

export interface LegalDocumentListQuery {
  page?: number;
  limit?: number;
  employeeId?: string;
  category?: LegalDocumentCategory;
  status?: LegalDocumentStatus;
  search?: string;
  expiringWithinDays?: number;
  currentOnly?: boolean;
}
