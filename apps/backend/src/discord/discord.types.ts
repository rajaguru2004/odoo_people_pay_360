/**
 * Discord channel — shared types.
 *
 * Same secret doctrine as WhatsApp: `DiscordResolvedConfig` carries the decrypted
 * bot token and is internal-only, `DiscordPublicConfig` is what a controller may
 * return. The split makes leaking the token a compile error rather than a review
 * miss.
 */
import { VerificationMode } from '../common/verification/verification.types';

export const DISCORD_SETTING_KEYS = {
  enabled: 'discord.enabled',
  /** Not secret — it appears in every invite URL. */
  applicationId: 'discord.applicationId',
  /** Not secret — Discord publishes it so you can verify their signatures. */
  publicKey: 'discord.publicKey',
  /** AES-256-GCM. Full control of the bot; never returned by any endpoint. */
  botTokenEnc: 'discord.botTokenEnc',
  /** Accept slash commands. Off by default, like the WhatsApp inbound switch. */
  inboundEnabled: 'discord.inboundEnabled',
  /** Allow actions that change data (read-only pilot mode when off). */
  mutationsEnabled: 'discord.mutationsEnabled',
  /** Employees may link their own Discord account. */
  linkingEnabled: 'discord.linkingEnabled',
  /** Deliver ESS notifications as DMs. */
  notificationsEnabled: 'discord.notificationsEnabled',
  /** Optional channel to mirror notifications into, mentioning the employee. */
  announceChannelId: 'discord.announceChannelId',
  /**
   * How attendance is verified over this channel — one of VERIFICATION_MODE.
   * Per-action overrides live under `${key}.CHECKIN` and friends.
   */
  attendanceVerification: 'discord.attendanceVerification',
  /**
   * @deprecated Superseded by `attendanceVerification`; read only when no enum
   * value exists, so an existing install keeps exactly today's behaviour.
   */
  attendanceFaceOverride: 'discord.attendanceFaceOverride',
  /** TTL of the one-time verification link. */
  verificationLinkTtlMinutes: 'discord.verificationLinkTtlMinutes',
  /** Test catcher: every DM goes to this Discord user id instead. */
  redirectAllTo: 'discord.redirectAllTo',
  retentionDays: 'discord.retentionDays',
  maxAttempts: 'discord.maxAttempts',
} as const;

export interface DiscordResolvedConfig {
  enabled: boolean;
  applicationId: string;
  publicKey: string;
  /** Decrypted. INTERNAL ONLY. */
  botToken: string;
  botTokenSource: 'db' | 'env' | 'none';
  inboundEnabled: boolean;
  mutationsEnabled: boolean;
  linkingEnabled: boolean;
  notificationsEnabled: boolean;
  announceChannelId: string;
  attendanceVerification: VerificationMode;
  /** @deprecated Legacy boolean, resolved only when no enum value is stored. */
  attendanceFaceOverride: boolean;
  verificationLinkTtlMinutes: number;
  redirectAllTo: string;
  retentionDays: number;
  maxAttempts: number;
}

export interface DiscordPublicConfig extends Omit<DiscordResolvedConfig, 'botToken'> {
  botTokenConfigured: boolean;
  botTokenMasked: string;
}

/** Interaction types we handle (Discord docs: InteractionType). */
export const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5,
} as const;

/** Response types (Discord docs: InteractionCallbackType). */
export const CALLBACK_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

/** 1 << 6 — only the invoking user sees the reply. */
export const EPHEMERAL_FLAG = 64;

/** Message component types (Discord docs: ComponentType). */
export const COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
} as const;

/**
 * Button styles. Only LINK is used: it opens a URL and fires no interaction,
 * so there is no second round trip and no component handler to write.
 */
export const BUTTON_STYLE = {
  PRIMARY: 1,
  SECONDARY: 2,
  LINK: 5,
} as const;
