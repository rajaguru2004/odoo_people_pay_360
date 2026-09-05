export interface EmployeeProfile {
  id: string;
  employeeId: string;
  placeOfBirth?: string;
  nationality?: string;
  maritalStatus?: 'SINGLE' | 'MARRIED' | 'DIVORCED' | 'WIDOWED';
  numberOfChildren?: number;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelationship?: string;
  emergencyContactAddress?: string;
  highestEducation?: 'HIGH_SCHOOL' | 'ASSOCIATE' | 'BACHELOR' | 'MASTER' | 'DOCTORATE';
  major?: string;
  university?: string;
  graduationYear?: number;
  bankName?: string;
  bankAccountNumber?: string;
  bankAccountHolderName?: string;
  bankBranch?: string;
  taxCode?: string;
  socialInsuranceNumber?: string;
  healthInsuranceNumber?: string;
  profileCompletionPercentage: number;
  lastProfileUpdate?: string;
}

export interface EmployeeDocument {
  id: string;
  employeeId: string;
  documentType: DocumentType;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  mimeType: string;
  description?: string;
  uploadedAt: string;
  uploader?: {
    id: string;
    email: string;
  };
}

export enum DocumentType {
  AVATAR = 'AVATAR',
  RESUME = 'RESUME',
  ID_CARD_FRONT = 'ID_CARD_FRONT',
  ID_CARD_BACK = 'ID_CARD_BACK',
  DEGREE = 'DEGREE',
  CERTIFICATE = 'CERTIFICATE',
  CONTRACT = 'CONTRACT',
  OTHER = 'OTHER',
}

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  [DocumentType.AVATAR]: 'Avatar',
  [DocumentType.RESUME]: 'Resume/CV',
  [DocumentType.ID_CARD_FRONT]: 'ID Card Front',
  [DocumentType.ID_CARD_BACK]: 'ID Card Back',
  [DocumentType.DEGREE]: 'Degree',
  [DocumentType.CERTIFICATE]: 'Certificate',
  [DocumentType.CONTRACT]: 'Contract',
  [DocumentType.OTHER]: 'Other',
};

export const MARITAL_STATUS_LABELS = {
  SINGLE: 'Single',
  MARRIED: 'Married',
  DIVORCED: 'Divorced',
  WIDOWED: 'Widowed',
};

export const EDUCATION_LABELS = {
  HIGH_SCHOOL: 'High School',
  ASSOCIATE: 'Associate',
  BACHELOR: 'Bachelor',
  MASTER: 'Master',
  DOCTORATE: 'Doctorate',
};

export const RELATIONSHIP_OPTIONS = [
  'Spouse',
  'Parent',
  'Child',
  'Sibling',
  'Other',
];

// Translation-key maps (Arabic i18n rollout) — mirror the *_LABELS maps above 1:1 but
// hold i18n keys instead of hardcoded English, so display text can go through
// useTranslations('employeeProfileLabels') without touching the stored enum values
// (`value={...}` attributes / persisted fields keep using the plain enum keys above).
export const DOCUMENT_TYPE_LABEL_KEYS: Record<DocumentType, string> = {
  [DocumentType.AVATAR]: 'documentTypeAvatar',
  [DocumentType.RESUME]: 'documentTypeResume',
  [DocumentType.ID_CARD_FRONT]: 'documentTypeIdCardFront',
  [DocumentType.ID_CARD_BACK]: 'documentTypeIdCardBack',
  [DocumentType.DEGREE]: 'documentTypeDegree',
  [DocumentType.CERTIFICATE]: 'documentTypeCertificate',
  [DocumentType.CONTRACT]: 'documentTypeContract',
  [DocumentType.OTHER]: 'documentTypeOther',
};

export const MARITAL_STATUS_LABEL_KEYS: Record<string, string> = {
  SINGLE: 'maritalSingle',
  MARRIED: 'maritalMarried',
  DIVORCED: 'maritalDivorced',
  WIDOWED: 'maritalWidowed',
};

export const EDUCATION_LABEL_KEYS: Record<string, string> = {
  HIGH_SCHOOL: 'eduHighSchool',
  ASSOCIATE: 'eduAssociate',
  BACHELOR: 'eduBachelor',
  MASTER: 'eduMaster',
  DOCTORATE: 'eduDoctorate',
};

export const RELATIONSHIP_LABEL_KEYS: Record<string, string> = {
  Spouse: 'relSpouse',
  Parent: 'relParent',
  Child: 'relChild',
  Sibling: 'relSibling',
  Other: 'relOther',
};

// Real bank names — proper nouns, not translated regardless of locale.
export const VIETNAM_BANKS = [
  'Vietcombank',
  'VietinBank',
  'BIDV',
  'Agribank',
  'Techcombank',
  'MB Bank',
  'ACB',
  'VPBank',
  'TPBank',
  'Sacombank',
  'HDBank',
  'VIB',
  'SHB',
  'SeABank',
  'OCB',
  'MSB',
  'Eximbank',
  'LienVietPostBank',
  'BacABank',
  'VietCapitalBank',
  'Other',
];
