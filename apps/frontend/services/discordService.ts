import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { DiscordLinkCode, MyDiscordStatus } from '@/types/discord';

class DiscordService {
  // ----------------------------------------------------------- self-service
  me(): Promise<ApiResponse<MyDiscordStatus>> {
    return axiosInstance.get('/discord/me');
  }

  /**
   * Issue a one-time code to type as `/link <code>` in Discord.
   *
   * The code is shown in the browser and redeemed from Discord — the reverse
   * direction to the WhatsApp opt-in, but the same property: neither side alone
   * completes the link.
   */
  startLink(): Promise<ApiResponse<DiscordLinkCode>> {
    return axiosInstance.post('/discord/me/link/start');
  }

  unlink(): Promise<ApiResponse<{ ok: true }>> {
    return axiosInstance.post('/discord/me/unlink');
  }

  // ------------------------------------------------------------------ admin
  identityStats(): Promise<ApiResponse<{ total: number; active: number; pending: number }>> {
    return axiosInstance.get('/discord/identities/stats');
  }
}

export default new DiscordService();
