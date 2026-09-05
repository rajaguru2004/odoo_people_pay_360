export type VaultKind =
  | 'PERSONAL'
  | 'LETTER'
  | 'LEGAL'
  | 'CONTRACT'
  | 'PAYSLIP'
  | 'CERTIFICATE';

export interface VaultItem {
  id: string;
  kind: VaultKind;
  title: string;
  category: string;
  issueDate: string | null;
  expiryDate: string | null;
  /** Negative once lapsed; null when it never expires. */
  daysUntilExpiry: number | null;
  /** Null for private files — use the secure download route instead. */
  fileUrl: string | null;
  secureKind: string | null;
  secureId: string | null;
  source: string;
}

export interface VaultResponse {
  items: VaultItem[];
  summary: {
    total: number;
    byKind: Record<string, number>;
    expiringSoon: number;
    expired: number;
  };
}
