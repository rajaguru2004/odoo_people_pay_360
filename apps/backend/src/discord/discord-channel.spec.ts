import { toDiscordMarkdown, chunkDiscord, mention, DISCORD_MAX_CHARS } from './render/discord-format';
import {
  actionKeyToCommandName,
  buildCommands,
  commandNameToActionKey,
  HELP_COMMAND,
  LINK_COMMAND,
  WHOAMI_COMMAND,
} from './interactions/discord-command.registry';
import { essActions } from '../whatsapp/router/actions/ess.actions';
import { approvalActions } from '../whatsapp/router/actions/approval.actions';

describe('Discord markdown', () => {
  it('converts WhatsApp bold to Discord bold', () => {
    // Discord reads *text* as ITALIC, so shipping WhatsApp markup unconverted
    // would render every heading wrong.
    expect(toDiscordMarkdown('*Checked in*')).toBe('**Checked in**');
  });

  it('converts WhatsApp italic to Discord italic', () => {
    expect(toDiscordMarkdown('_Marked late._')).toBe('*Marked late.*');
  });

  it('does not let the bold pass corrupt the italic pass', () => {
    // The bug this guards: writing ** first, then having the italic rule
    // re-read it as two italic markers.
    expect(toDiscordMarkdown('*Bold* and _italic_')).toBe('**Bold** and *italic*');
  });

  it('handles a real rendered message', () => {
    const wa = '*📅 Today*\n*Status:* PRESENT\n_Not checked out yet._';
    expect(toDiscordMarkdown(wa)).toBe('**📅 Today**\n**Status:** PRESENT\n*Not checked out yet.*');
  });

  it('converts strikethrough', () => {
    expect(toDiscordMarkdown('~gone~')).toBe('~~gone~~');
  });

  it.each(['', 'no markup at all', '2 * 3 = 6'])('leaves %p alone', (input) => {
    expect(toDiscordMarkdown(input)).toBe(input);
  });

  it('renders a real mention', () => {
    expect(mention('1234567890')).toBe('<@1234567890>');
  });
});

describe('Discord chunking', () => {
  it('leaves a short message intact', () => {
    expect(chunkDiscord('short')).toEqual(['short']);
  });

  it('splits on line boundaries at the 2000-char cap', () => {
    const line = 'x'.repeat(100);
    const parts = chunkDiscord(Array.from({ length: 40 }, () => line).join('\n'));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS);
  });

  it('breaks a single over-long line rather than dropping it', () => {
    const parts = chunkDiscord('y'.repeat(5000));
    expect(parts.join('').length).toBe(5000);
  });
});

describe('slash commands derived from the shared catalogue', () => {
  const actions = [...essActions(), ...approvalActions()];
  const commands = buildCommands(actions);

  it('always offers link, whoami and help', () => {
    const names = commands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([LINK_COMMAND, WHOAMI_COMMAND, HELP_COMMAND]));
  });

  it('exposes the attendance actions the brief asked for', () => {
    const names = commands.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['attendance-checkin', 'attendance-checkout', 'attendance-today']),
    );
  });

  it('round-trips a command name back to its action key', () => {
    for (const a of actions) {
      if (a.hidden || a.flow || a.needsActionToken) continue;
      expect(commandNameToActionKey(actionKeyToCommandName(a.key), actions)).toBe(a.key);
    }
  });

  it('omits multi-step flows', () => {
    // A slash command is one shot; "apply for leave" needs type, dates and a
    // reason, so it stays in the portal rather than being half-implemented.
    const names = commands.map((c) => c.name);
    expect(names).not.toContain('leave-apply');
  });

  it('omits approvals, which arrive as notification buttons with a token', () => {
    const names = commands.map((c) => c.name);
    for (const a of approvalActions()) {
      expect(names).not.toContain(actionKeyToCommandName(a.key));
    }
  });

  it('never exposes a hidden action', () => {
    const names = commands.map((c) => c.name);
    expect(names).not.toContain('attendance-checkin_location');
  });

  it('satisfies Discord command-name rules', () => {
    for (const c of commands) {
      expect(c.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('stays under Discord\'s 100 global command cap', () => {
    expect(commands.length).toBeLessThanOrEqual(100);
  });
});
