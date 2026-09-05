import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  EnrollStartResult,
  WhatsAppActionRow,
  MyWhatsAppStatus,
  OptInPreview,
  Paged,
  UpdateWhatsAppSettings,
  WhatsAppConnection,
  WhatsAppEnrollResult,
  WhatsAppIdentityRow,
  WhatsAppIdentityStats,
  WhatsAppOutboxRow,
  WhatsAppQr,
  WhatsAppSettings,
  WhatsAppTemplate,
  WhatsAppTestSendResult,
  WhatsAppWebhookConfig,
  WhatsAppWebhookRegistered,
} from '@/types/whatsapp';

class WhatsAppService {
  // ------------------------------------------------------------------ admin
  getSettings(): Promise<ApiResponse<WhatsAppSettings>> {
    return axiosInstance.get('/whatsapp/settings');
  }

  updateSettings(dto: UpdateWhatsAppSettings): Promise<ApiResponse<WhatsAppSettings>> {
    return axiosInstance.put('/whatsapp/settings', dto);
  }

  connectionState(): Promise<ApiResponse<WhatsAppConnection>> {
    return axiosInstance.get('/whatsapp/connection-state', { timeout: 20_000 });
  }

  qr(): Promise<ApiResponse<WhatsAppQr>> {
    return axiosInstance.get('/whatsapp/qr', { timeout: 20_000 });
  }

  templates(): Promise<ApiResponse<WhatsAppTemplate[]>> {
    return axiosInstance.get('/whatsapp/templates');
  }

  webhookConfig(): Promise<ApiResponse<WhatsAppWebhookConfig>> {
    // Reaches out to the WhatsApp service to read back what it has on file,
    // so it inherits that hop's latency rather than the default timeout.
    return axiosInstance.get('/whatsapp/webhook/config', { timeout: 20_000 });
  }

  /** Omit `url` to use the callback address configured in settings. */
  registerWebhook(url?: string): Promise<ApiResponse<WhatsAppWebhookRegistered>> {
    return axiosInstance.post('/whatsapp/webhook/register', { url: url ?? '' }, { timeout: 20_000 });
  }

  testSend(input: {
    phone?: string;
    templateKey?: string;
    previewOnly?: boolean;
  }): Promise<ApiResponse<WhatsAppTestSendResult>> {
    return axiosInstance.post('/whatsapp/test-send', input, { timeout: 30_000 });
  }

  identities(params: {
    search?: string;
    optedIn?: boolean;
    verified?: boolean;
    skip?: number;
    take?: number;
  }): Promise<ApiResponse<Paged<WhatsAppIdentityRow>>> {
    return axiosInstance.get('/whatsapp/identities', { params });
  }

  identityStats(): Promise<ApiResponse<WhatsAppIdentityStats>> {
    return axiosInstance.get('/whatsapp/identities/stats');
  }

  /**
   * Link the numbers already on employee profiles. A long timeout because it
   * checks every number against WhatsApp in one batched round trip.
   */
  enrollFromEmployees(body: {
    commit?: boolean;
    confirmConsent?: boolean;
    employeeIds?: string[];
  }): Promise<ApiResponse<WhatsAppEnrollResult>> {
    return axiosInstance.post('/whatsapp/identities/enroll-from-employees', body, {
      timeout: 120_000,
    });
  }

  verifyPending(): Promise<ApiResponse<{ checked: number; verified: number }>> {
    return axiosInstance.post('/whatsapp/identities/verify-pending', {}, { timeout: 60_000 });
  }

  outbox(params: {
    status?: string;
    templateKey?: string;
    skip?: number;
    take?: number;
  }): Promise<ApiResponse<Paged<WhatsAppOutboxRow>>> {
    return axiosInstance.get('/whatsapp/outbox', { params });
  }

  retry(id: string): Promise<ApiResponse<null>> {
    return axiosInstance.post(`/whatsapp/outbox/${id}/retry`);
  }

  drain(): Promise<ApiResponse<{ processed: number; sent: number; failed: number }>> {
    return axiosInstance.post('/whatsapp/outbox/drain', {}, { timeout: 60_000 });
  }

  /**
   * The live action catalogue. Served from the registry rather than a copy of
   * it, so the settings page cannot drift from what the channel can do.
   */
  actions(): Promise<ApiResponse<WhatsAppActionRow[]>> {
    return axiosInstance.get('/whatsapp/actions');
  }

  setActionsDisabled(keys: string[]): Promise<ApiResponse<{ disabled: string[] }>> {
    return axiosInstance.put('/whatsapp/actions/disabled', { keys });
  }

  // ----------------------------------------------------------- self-service
  me(): Promise<ApiResponse<MyWhatsAppStatus>> {
    return axiosInstance.get('/whatsapp/me');
  }

  /** Step 1: normalise and check. Records nothing. */
  previewOptIn(phone: string): Promise<ApiResponse<OptInPreview>> {
    return axiosInstance.post('/whatsapp/me/opt-in/preview', { phone }, { timeout: 20_000 });
  }

  /** Step 2: consent to the exact number the preview returned. */
  confirmOptIn(phoneE164: string): Promise<ApiResponse<MyWhatsAppStatus>> {
    return axiosInstance.post('/whatsapp/me/opt-in', { phoneE164 }, { timeout: 20_000 });
  }

  // --------------------------------------------------------- two-way linking
  // Opting in is consent to RECEIVE. Linking is proof of identity so the
  // handset can also ACT — hence a code, and hence the code being typed HERE
  // rather than sent back over WhatsApp: closing the loop in an authenticated
  // browser is what stops somebody holding only the SIM from linking a number.

  enrollStart(phone: string): Promise<ApiResponse<EnrollStartResult>> {
    return axiosInstance.post('/whatsapp/me/enroll/start', { phone });
  }

  enrollVerify(enrollmentId: string, code: string): Promise<ApiResponse<MyWhatsAppStatus>> {
    return axiosInstance.post('/whatsapp/me/enroll/verify', { enrollmentId, code });
  }

  setPin(pin: string): Promise<ApiResponse<{ ok: boolean }>> {
    return axiosInstance.post('/whatsapp/me/pin', { pin });
  }

  unlink(): Promise<ApiResponse<MyWhatsAppStatus>> {
    return axiosInstance.post('/whatsapp/me/unlink');
  }

  optOut(): Promise<ApiResponse<MyWhatsAppStatus>> {
    return axiosInstance.post('/whatsapp/me/opt-out');
  }
}

export default new WhatsAppService();
