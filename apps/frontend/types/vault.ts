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
  /** Days until it lapses; negative once it has. Null when it never expires. */
  daysUntilExpiry: number | null;
  /** A URL anyone may open, or null when the file needs the download route. */
  fileUrl: string | null;
  /** The authenticated route: /secure-files/{secureKind}/{secureId}. */
  secureKind: string | null;
  secureId: string | null;
  source: string;
}

export interface VaultSummary {
  total: number;
  byKind: Partial<Record<VaultKind, number>>;
  expiringSoon: number;
  expired: number;
}

export interface VaultResponse {
  items: VaultItem[];
  summary: VaultSummary;
}
