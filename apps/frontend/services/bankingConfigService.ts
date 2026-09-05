import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { BankingField } from '@/services/bankChangeService';

export interface BankingFieldRow extends BankingField {
  id: string;
  country: string;
  isActive: boolean;
}

export interface UpsertBankingFieldData {
  country: string;
  fieldKey: string;
  label: string;
  fieldType?: string;
  validationType: string;
  regex?: string;
  required?: boolean;
  displayOrder?: number;
  placeholder?: string;
  helpText?: string;
  isSensitive?: boolean;
  isActive?: boolean;
}

export const VALIDATION_TYPES = [
  'NONE',
  'IBAN',
  'IFSC',
  'SWIFT',
  'SORT_CODE',
  'ROUTING',
  'NUMBER',
  'REGEX',
] as const;

export const FIELD_TYPES = ['TEXT', 'NUMBER', 'SELECT'] as const;

class BankingConfigService {
  /** Active fields for a country — drives dynamic forms. */
  async fields(country: string): Promise<ApiResponse<BankingField[]>> {
    return axiosInstance.get(`/banking-config/fields?country=${country}`);
  }

  /** Admin: all fields (optionally by country), includes inactive. */
  async list(country?: string): Promise<ApiResponse<BankingFieldRow[]>> {
    return axiosInstance.get(`/banking-config${country ? `?country=${country}` : ''}`);
  }

  async upsert(data: UpsertBankingFieldData): Promise<ApiResponse<BankingFieldRow>> {
    return axiosInstance.put('/banking-config', data);
  }

  async remove(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/banking-config/${id}`);
  }

  async seedDefaults(): Promise<ApiResponse<{ created: number }>> {
    return axiosInstance.post('/banking-config/seed', {});
  }
}

export default new BankingConfigService();
