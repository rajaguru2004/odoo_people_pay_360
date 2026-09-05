import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

export interface UploadResponse {
  url: string;
  fileName?: string;
  size?: number;
  mimetype?: string;
}

/** Folders the backend allowlists on POST /upload/file. */
export type UploadFolder = 'profile' | 'documents';

class UploadService {
  /**
   * Upload a file that has no record to hang off yet and get its URL back.
   *
   * The entity-scoped routes (`/upload/avatar/:employeeId`, …) cannot serve a
   * CREATE form, where the id does not exist until save.
   */
  async uploadFile(
    file: File,
    folder: UploadFolder = 'profile',
  ): Promise<ApiResponse<UploadResponse>> {
    const formData = new FormData();
    formData.append('file', file);

    return axiosInstance.post('/upload/file', formData, {
      params: { folder },
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  }

  async uploadAvatar(
    employeeId: string,
    file: File,
  ): Promise<ApiResponse<UploadResponse>> {
    const formData = new FormData();
    formData.append('file', file);

    return axiosInstance.post(`/upload/avatar/${employeeId}`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  }

  async uploadContract(
    contractId: string,
    file: File,
  ): Promise<ApiResponse<UploadResponse>> {
    const formData = new FormData();
    formData.append('file', file);

    return axiosInstance.post(`/upload/contract/${contractId}`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  }

  async uploadDocument(
    employeeId: string,
    file: File,
    category: string,
  ): Promise<ApiResponse<UploadResponse>> {
    const formData = new FormData();
    formData.append('file', file);

    return axiosInstance.post(`/upload/document/${employeeId}`, formData, {
      params: { category },
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  }
}

export default new UploadService();
