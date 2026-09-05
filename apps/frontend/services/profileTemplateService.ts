import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  CountryPreset,
  ResolvedTemplate,
  TemplateDetail,
  TemplateMode,
  TemplateSummary,
} from '@/types/profile-template';

export interface UpsertSectionData {
  sectionKey?: string;
  label?: string;
  icon?: string;
  wizardStep?: number;
  columns?: number;
  displayOrder?: number;
  isActive?: boolean;
  visibleToRoles?: string[];
}

export interface UpsertFieldData {
  fieldKey?: string;
  sectionId?: string;
  label?: string;
  fieldType?: string;
  validationType?: string;
  regex?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  required?: boolean;
  options?: { value: string; label: string }[] | null;
  optionSource?: string | null;
  placeholder?: string | null;
  helpText?: string | null;
  defaultValue?: string | null;
  colSpan?: number;
  displayOrder?: number;
  visibleToRoles?: string[];
  editableByRoles?: string[];
  selfVisible?: boolean;
  selfEditable?: boolean;
  isSensitive?: boolean;
  isActive?: boolean;
  includeInCompletion?: boolean;
}

class ProfileTemplateService {
  /**
   * The template to render, already filtered to what this user's role may see.
   * The hot path — every employee form calls it.
   */
  async getActive(params: {
    branchId?: string;
    mode?: TemplateMode;
    employeeId?: string;
  } = {}): Promise<ResolvedTemplate> {
    const res: ApiResponse<ResolvedTemplate> = await axiosInstance.get(
      '/profile-templates/active',
      { params },
    );
    return res.data;
  }

  /** Which template applies to an employee, and why. Support/debug. */
  async resolveForEmployee(employeeId: string) {
    const res: ApiResponse<{
      source: string;
      templateId: string | null;
      scope: string;
      country: string | null;
      fieldCount: number;
      enabled: boolean;
    }> = await axiosInstance.get(`/profile-templates/resolve/${employeeId}`);
    return res.data;
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  async listPresets(): Promise<CountryPreset[]> {
    const res: ApiResponse<CountryPreset[]> = await axiosInstance.get(
      '/profile-templates/presets',
    );
    return res.data;
  }

  async list(params: { scope?: string; branchId?: string } = {}): Promise<
    TemplateSummary[]
  > {
    const res: ApiResponse<TemplateSummary[]> = await axiosInstance.get(
      '/profile-templates',
      { params },
    );
    return res.data;
  }

  async get(id: string): Promise<TemplateDetail> {
    const res: ApiResponse<TemplateDetail> = await axiosInstance.get(
      `/profile-templates/${id}`,
    );
    return res.data;
  }

  /** Copy a country preset into a new company or branch template. */
  async adopt(data: {
    country?: string;
    scope?: 'COMPANY' | 'BRANCH';
    branchId?: string;
    name?: string;
  }): Promise<TemplateDetail> {
    const res: ApiResponse<TemplateDetail> = await axiosInstance.post(
      '/profile-templates/adopt',
      data,
    );
    return res.data;
  }

  async rename(id: string, name: string) {
    return axiosInstance.patch(`/profile-templates/${id}`, { name });
  }

  async archive(id: string) {
    return axiosInstance.delete(`/profile-templates/${id}`);
  }

  /** Re-apply the shipped preset. Never overwrites a customization. */
  async reseed(id: string) {
    return axiosInstance.post(`/profile-templates/${id}/reseed`, {});
  }

  createSection(id: string, data: UpsertSectionData) {
    return axiosInstance.post(`/profile-templates/${id}/sections`, data);
  }

  updateSection(id: string, sectionId: string, data: UpsertSectionData) {
    return axiosInstance.patch(
      `/profile-templates/${id}/sections/${sectionId}`,
      data,
    );
  }

  removeSection(id: string, sectionId: string) {
    return axiosInstance.delete(`/profile-templates/${id}/sections/${sectionId}`);
  }

  reorderSections(id: string, order: string[]) {
    return axiosInstance.post(`/profile-templates/${id}/sections/reorder`, {
      order,
    });
  }

  createField(id: string, data: UpsertFieldData) {
    return axiosInstance.post(`/profile-templates/${id}/fields`, data);
  }

  updateField(id: string, fieldId: string, data: UpsertFieldData) {
    return axiosInstance.patch(
      `/profile-templates/${id}/fields/${fieldId}`,
      data,
    );
  }

  removeField(id: string, fieldId: string) {
    return axiosInstance.delete(`/profile-templates/${id}/fields/${fieldId}`);
  }

  /** Reorder within a section, or move fields into `sectionId`. */
  reorderFields(id: string, order: string[], sectionId?: string) {
    return axiosInstance.post(`/profile-templates/${id}/fields/reorder`, {
      order,
      ...(sectionId ? { sectionId } : {}),
    });
  }
}

export default new ProfileTemplateService();
