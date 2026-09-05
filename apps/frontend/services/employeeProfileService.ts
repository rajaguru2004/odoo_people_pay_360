import api from '@/lib/axios';
import { EmployeeProfile, EmployeeDocument } from '@/types/employee-profile';

export const employeeProfileService = {
  // Get employee profile
  async getProfile(employeeId: string) {
    const response = await api.get(`/employees/${employeeId}/profile`);
    return response.data;
  },

  // Update employee profile
  async updateProfile(employeeId: string, data: Partial<EmployeeProfile>) {
    const response = await api.patch(`/employees/${employeeId}/profile`, data);
    return response.data;
  },

  // Upload avatar
  async uploadAvatar(employeeId: string, file: File) {
    const formData = new FormData();
    formData.append('file', file);

    const response = await api.post(`/employees/${employeeId}/avatar`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        if (progressEvent.total) {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          console.log('Upload progress:', percentCompleted);
        }
      },
    });
    return response.data;
  },

  // Upload document
  async uploadDocument(
    employeeId: string,
    file: File,
    documentType: string,
    description?: string
  ) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('documentType', documentType);
    if (description) formData.append('description', description);
    const response = await api.post(`/employees/${employeeId}/documents`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  // Get documents
  async getDocuments(employeeId: string, type?: string) {
    const params = type ? { type } : {};
    const response = await api.get(`/employees/${employeeId}/documents`, { params });
    return response.data;
  },

  // Delete document
  async deleteDocument(employeeId: string, documentId: string) {
    const response = await api.delete(`/employees/${employeeId}/documents/${documentId}`);
    return response.data;
  },

  // Get profile completion stats
  async getProfileCompletionStats() {
    const response = await api.get('/employees/stats/profile-completion');
    return response.data;
  },
};
