import { WhatsAppActionDef } from '../../whatsapp/router/action.types';

/**
 * Slash commands, derived from the shared ESS action catalogue.
 *
 * The command set is generated rather than hand-written so the catalogue stays
 * the single source of truth: an action added for WhatsApp appears on Discord
 * with no second list to remember, and the role/tool/confirm rules validated at
 * boot apply unchanged.
 *
 * Action keys are dotted (`attendance.checkin`); Discord command names must be
 * lowercase, 1-32 chars, `[a-z0-9_-]`. The mapping is total and reversible.
 */
export const COMMAND_PREFIX_SEPARATOR = '-';

export function actionKeyToCommandName(actionKey: string): string {
  return actionKey.replace(/\./g, COMMAND_PREFIX_SEPARATOR).toLowerCase().slice(0, 32);
}

export function commandNameToActionKey(name: string, actions: WhatsAppActionDef[]): string | null {
  const hit = actions.find((a) => actionKeyToCommandName(a.key) === name);
  return hit?.key ?? null;
}

/** Commands that are not ESS actions — account linking and help. */
export const LINK_COMMAND = 'link';
export const WHOAMI_COMMAND = 'whoami';
export const HELP_COMMAND = 'help';

export interface DiscordCommand {
  name: string;
  description: string;
  type: 1;
  options?: Array<{
    name: string;
    description: string;
    type: number;
    required?: boolean;
  }>;
}

/**
 * Build the full command list.
 *
 * Only actions that need no argument collection are exposed. A multi-step flow
 * (apply for leave: type, dates, reason) is a conversation, and Discord's
 * one-shot slash command is the wrong shape for it — those stay in the portal
 * rather than being half-implemented here.
 */
export function buildCommands(actions: WhatsAppActionDef[]): DiscordCommand[] {
  const commands: DiscordCommand[] = [
    {
      name: LINK_COMMAND,
      description: 'Link this Discord account to your HR profile',
      type: 1,
      options: [
        {
          name: 'code',
          description: 'The 6-digit code from the HR portal',
          // 3 = STRING
          type: 3,
          required: true,
        },
      ],
    },
    { name: WHOAMI_COMMAND, description: 'Show which HR profile this account is linked to', type: 1 },
    { name: HELP_COMMAND, description: 'List the HR commands you can use', type: 1 },
  ];

  for (const a of actions) {
    if (a.hidden) continue;
    if (a.flow) continue; // multi-step; a slash command cannot carry it
    if (a.needsActionToken) continue; // approvals arrive as notification buttons

    commands.push({
      name: actionKeyToCommandName(a.key),
      // Discord requires 1-100 chars and rejects empty descriptions.
      description: a.menuLabel.slice(0, 100),
      type: 1,
    });
  }

  // Discord caps an application at 100 global commands.
  return commands.slice(0, 100);
}
