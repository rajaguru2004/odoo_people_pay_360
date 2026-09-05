import axiosInstance from '@/lib/axios';

export interface FaceDescriptorInfo {
  id: string;
  imageUrl: string | null;
  quality: number;
  createdAt: string;
}

export interface FaceRegistrationStatus {
  isRegistered: boolean;
  totalRegistered: number;
  maxAllowed: number;
  canRegisterMore: boolean;
}

export interface FaceRecognitionResult {
  employee: {
    id: string;
    fullName: string;
    employeeCode: string;
    avatarUrl: string | null;
  };
  attendance: any;
  recognition?: {
    confidence: number;
    distance: number;
    quality: number;
    threshold: number;
  };
}

class FaceRecognitionService {
  /**
   * Register face (1 photo, call multiple times for 3-5 photos)
   */
  async registerFace(image: string, employeeId?: string) {
    return axiosInstance.post('/face-recognition/register', {
      image,
      employeeId,
    });
  }

  /**
   * Time attendance using facial recognition
   */
  async faceCheckIn(image: string, coords?: { latitude?: number; longitude?: number; accuracy?: number }) {
    return axiosInstance.post('/face-recognition/check-in', { image, ...coords });
  }

  /**
   * Time attendance using facial recognition
   */
  async faceCheckOut(image: string) {
    return axiosInstance.post('/face-recognition/check-out', { image });
  }

  /**
   * Time lunch check-in using facial recognition
   */
  async faceLunchCheckIn(image: string) {
    return axiosInstance.post('/face-recognition/lunch-check-in', { image });
  }

  /**
   * Time lunch check-out using facial recognition
   */
  async faceLunchCheckOut(image: string) {
    return axiosInstance.post('/face-recognition/lunch-check-out', { image });
  }

  /**
   * Time attendance using capture only (no recognition)
   */
  async captureCheckIn(image: string, coords?: { latitude?: number; longitude?: number; accuracy?: number }) {
    return axiosInstance.post('/face-recognition/capture-check-in', { image, ...coords });
  }

  /**
   * Time attendance using capture only (no recognition)
   */
  async captureCheckOut(image: string) {
    return axiosInstance.post('/face-recognition/capture-check-out', { image });
  }

  /**
   * Time lunch check-in using capture only (no recognition)
   */
  async captureLunchCheckIn(image: string) {
    return axiosInstance.post('/face-recognition/capture-lunch-check-in', { image });
  }

  /**
   * Time lunch check-out using capture only (no recognition)
   */
  async captureLunchCheckOut(image: string) {
    return axiosInstance.post('/face-recognition/capture-lunch-check-out', { image });
  }

  /**
   * Check face registration status
   */
  async getRegistrationStatus() {
    return axiosInstance.get('/face-recognition/status');
  }

  /**
   * Get a list of self's registered face images
   */
  async getMyDescriptors() {
    return axiosInstance.get('/face-recognition/descriptors/me');
  }

  /**
   * Get a list of face images of an employee (admin)
   */
  async getEmployeeDescriptors(employeeId: string) {
    return axiosInstance.get(`/face-recognition/descriptors/${employeeId}`);
  }

  /**
   * Delete face images
   */
  async deleteDescriptor(id: string) {
    return axiosInstance.delete(`/face-recognition/descriptors/${id}`);
  }

  /**
   * Test recognition (debug)
   */
  async testRecognition(image: string) {
    return axiosInstance.post('/face-recognition/test', { image });
  }
}

const faceRecognitionService = new FaceRecognitionService();
export default faceRecognitionService;
