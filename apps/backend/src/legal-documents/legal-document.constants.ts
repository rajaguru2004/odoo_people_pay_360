// Lifecycle status of a legal document record.
// EXPIRING_SOON is derived (expiry within the alert window), never stored.
export enum LegalDocumentStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  RENEWED = 'RENEWED',
  CANCELLED = 'CANCELLED',
}

// Categories mirror the Prisma LegalDocumentCategory enum. Visa-only for now;
// PASSPORT / WORK_PERMIT / EMIRATES_ID become new values later.
export enum LegalDocumentCategoryValue {
  VISA = 'VISA',
}

export const LEGAL_DOC_ALERT_RECIPIENT_ROLES = ['ADMIN', 'HR_MANAGER'];

// Settings key: days before expiry to start alerting (default 30).
export const VISA_EXPIRY_ALERT_DAYS_KEY = 'visa_expiry_alert_days';
export const VISA_EXPIRY_ALERT_DAYS_DEFAULT = '30';
