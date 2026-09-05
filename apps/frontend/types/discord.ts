/**
 * Discord channel self-service types.
 *
 * Same absence as the WhatsApp types: no bot token field exists anywhere here,
 * because the backend's read projection cannot carry one across HTTP.
 */

export type DiscordLinkStatus = 'PENDING' | 'ACTIVE' | 'REVOKED';

export interface MyDiscordStatus {
  linked: boolean;
  /** The Discord snowflake, only once the link is ACTIVE. */
  discordUserId: string | null;
  discordTag: string | null;
  status: DiscordLinkStatus | null;
  linkedAt: string | null;
  optedIn: boolean;
  /** Channel enabled AND employee linking allowed. False hides the section. */
  available: boolean;
  applicationId: string | null;
}

export interface DiscordLinkCode {
  code: string;
  expiresInMinutes: number;
}
