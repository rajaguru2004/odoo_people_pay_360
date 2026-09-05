// Visa lifecycle types — generic "legal document" model, visa-focused UI.

export type VisaStatus = 'ACTIVE' | 'EXPIRED' | 'RENEWED' | 'CANCELLED';

export interface VisaAttachment {
  id: string;
  legalDocumentId: string;
  fileName: string;
  fileUrl: string;
  fileSize: number | null;
  mimeType: string | null;
  uploadedAt: string;
  uploadedBy?: {
    id: string;
    email: string;
    employee?: { fullName: string; avatarUrl?: string | null } | null;
  } | null;
}

export interface VisaRecord {
  id: string;
  employeeId: string;
  category: 'VISA';
  documentNumber: string;
  documentType: string;
  country: string;
  nationality?: string | null;
  issueDate: string;
  expiryDate: string;
  issuingAuthority?: string | null;
  placeOfIssue?: string | null;
  sponsor?: string | null;
  remarks?: string | null;
  status: VisaStatus;
  isCurrent: boolean;
  renewedFromId?: string | null;
  expiryAlertSentAt?: string | null;
  createdAt: string;
  updatedAt: string;
  // Derived by the backend
  daysUntilExpiry: number;
  isExpiringSoon: boolean;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    avatarUrl?: string | null;
    branchId?: string | null;
    department?: { id: string; name: string } | null;
  };
  attachments?: VisaAttachment[];
  renewedFrom?: VisaRecord | null;
  renewals?: VisaRecord[];
}

export interface VisaSummary {
  active: number;
  expiringSoon: number;
  expired: number;
  cancelled: number;
  renewedThisYear: number;
  alertDays: number;
}

export interface CreateVisaPayload {
  employeeId: string;
  documentNumber: string;
  documentType: string;
  country: string;
  nationality?: string;
  issueDate: string;
  expiryDate: string;
  issuingAuthority?: string;
  placeOfIssue?: string;
  sponsor?: string;
  remarks?: string;
}

export type UpdateVisaPayload = Partial<Omit<CreateVisaPayload, 'employeeId'>>;

export interface RenewVisaPayload {
  documentNumber: string;
  issueDate: string;
  expiryDate: string;
  documentType?: string;
  issuingAuthority?: string;
  placeOfIssue?: string;
  sponsor?: string;
  remarks?: string;
}

// i18n label keys per status (visas namespace)
export const VISA_STATUS_LABEL_KEYS: Record<VisaStatus, string> = {
  ACTIVE: 'statusActive',
  EXPIRED: 'statusExpired',
  RENEWED: 'statusRenewed',
  CANCELLED: 'statusCancelled',
};

// Status pill classes (theme tokens; EXPIRING_SOON derived → amber on ACTIVE)
export const VISA_STATUS_CLASSES: Record<VisaStatus, string> = {
  ACTIVE: 'bg-green-100 text-green-700',
  EXPIRED: 'bg-red-100 text-red-700',
  RENEWED: 'bg-blue-100 text-blue-700',
  CANCELLED: 'bg-gray-200 text-gray-600',
};

export const VISA_EXPIRING_SOON_CLASS = 'bg-yellow-100 text-yellow-700';
