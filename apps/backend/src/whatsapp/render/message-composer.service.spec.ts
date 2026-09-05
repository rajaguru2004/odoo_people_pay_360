import { MessageComposerService } from './message-composer.service';
import { WaOutbound, replyBtn } from '../router/action.types';

/**
 * Interactive messages are best-effort by nature: builds differ on which
 * surfaces render, and the same build changes under us (lists were broken here
 * until the provider fixed them). The behaviour that has to hold regardless is
 * that a failed interactive send degrades to text rather than to silence, and
 * that one broken surface does not take the others down with it.
 */
function makeHarness(over: { interactiveMode?: string } = {}) {
  const cfg = {
    minGapMs: 0,
    maxPerMinute: 1000,
    interactiveMode: over.interactiveMode ?? 'auto',
  };
  const settings: any = { ensureCredentials: jest.fn().mockResolvedValue(cfg) };
  const evolution: any = {
    setPacing: jest.fn(),
    sendText: jest.fn().mockResolvedValue({ ok: true }),
    sendButtons: jest.fn().mockResolvedValue({ ok: true }),
    sendList: jest.fn().mockResolvedValue({ ok: true }),
    sendPoll: jest.fn().mockResolvedValue({ ok: true }),
    markRead: jest.fn().mockResolvedValue(undefined),
    sendPresence: jest.fn().mockResolvedValue(undefined),
  };
  const sessions: any = { rememberMenu: jest.fn().mockResolvedValue(undefined) };
  return {
    svc: new MessageComposerService(settings, evolution, sessions),
    evolution,
    sessions,
  };
}

const session: any = { id: 's1', remoteJid: '919952982836@s.whatsapp.net' };

const withButtons: WaOutbound = {
  plain: 'Confirm this?\nReply YES or NO.',
  menu: [{ n: 1, label: 'Check in', actionKey: 'attendance.checkin' }],
  buttons: {
    title: 'Confirm',
    description: 'Apply for leave?',
    items: [replyBtn('Yes, confirm', 'v1|__ctl.yes'), replyBtn('Cancel', 'v1|__ctl.no')],
  },
};

const withList: WaOutbound = {
  plain: '1. Check in\n2. Leave balance',
  menu: [
    { n: 1, label: 'Check in', actionKey: 'attendance.checkin' },
    { n: 2, label: 'Leave balance', actionKey: 'leave.balance' },
  ],
  list: {
    title: 'HR services',
    description: 'Pick one.',
    buttonText: 'Open menu',
    footerText: 'HR portal',
    sections: [
      {
        title: 'Attendance',
        rows: [{ title: '1. Check in', rowId: 'v1|attendance.checkin' }],
      },
      {
        title: 'Leave',
        rows: [{ title: '2. Leave balance', rowId: 'v1|leave.balance' }],
      },
    ],
  },
};

describe('MessageComposerService', () => {
  it('sends buttons when the outbound has them', async () => {
    const { svc, evolution } = makeHarness();
    await svc.send(session, withButtons);

    expect(evolution.sendButtons).toHaveBeenCalledTimes(1);
    expect(evolution.sendText).not.toHaveBeenCalled();

    const args = evolution.sendButtons.mock.calls[0][1];
    expect(args.toE164).toBe('+919952982836');
    expect(args.buttons).toEqual([
      { type: 'reply', displayText: 'Yes, confirm', id: 'v1|__ctl.yes' },
      { type: 'reply', displayText: 'Cancel', id: 'v1|__ctl.no' },
    ]);
  });

  describe('list mode', () => {
    it('sends a list when the outbound offers one', async () => {
      const { svc, evolution } = makeHarness();
      await svc.send(session, withList);

      expect(evolution.sendList).toHaveBeenCalledTimes(1);
      expect(evolution.sendText).not.toHaveBeenCalled();
      const args = evolution.sendList.mock.calls[0][1];
      expect(args.sections).toHaveLength(2);
      expect(args.sections[0].rows[0].rowId).toBe('v1|attendance.checkin');
    });

    it('falls back to text when the list send fails', async () => {
      const { svc, evolution } = makeHarness();
      evolution.sendList.mockResolvedValue({ ok: false, error: 'nope' });

      await svc.send(session, withList);
      expect(evolution.sendText).toHaveBeenCalledTimes(1);
    });

    it('never sends two tappable surfaces for one outbound', async () => {
      // Two would double the cost of every menu against the send gap, for one
      // choice. A list wins; the buttons are its fallback rung.
      const { svc, evolution } = makeHarness();
      await svc.send(session, { ...withList, buttons: withButtons.buttons });

      expect(evolution.sendList).toHaveBeenCalledTimes(1);
      expect(evolution.sendButtons).not.toHaveBeenCalled();
    });

    it('does not send a list when the admin has chosen buttons mode', async () => {
      // The safety valve if lists regress on a future build.
      const { svc, evolution } = makeHarness({ interactiveMode: 'buttons' });
      await svc.send(session, withList);

      expect(evolution.sendList).not.toHaveBeenCalled();
      expect(evolution.sendText).toHaveBeenCalledTimes(1);
    });

    it('never degrades a failed list into a poll', async () => {
      // A poll vote carries only the option TEXT; a list row carries the action
      // key. Swapping one for the other is a weaker binding, not a fallback.
      const { svc, evolution } = makeHarness();
      evolution.sendList.mockResolvedValue({ ok: false, error: 'nope' });

      await svc.send(session, withList);
      expect(evolution.sendPoll).not.toHaveBeenCalled();
    });
  });

  it('latches each surface independently', async () => {
    // The regression this guards: a single shared counter meant three list
    // failures disabled confirmations too, and one successful button send
    // cleared a latch it knew nothing about.
    const { svc, evolution } = makeHarness();
    evolution.sendList.mockResolvedValue({ ok: false, error: 'nope' });

    for (let i = 0; i < 3; i++) await svc.send(session, withList);
    expect(evolution.sendList).toHaveBeenCalledTimes(3);

    await svc.send(session, withList);
    expect(evolution.sendList).toHaveBeenCalledTimes(3); // list is latched off

    // ...and buttons still work.
    await svc.send(session, withButtons);
    expect(evolution.sendButtons).toHaveBeenCalledTimes(1);

    // A successful button send must NOT resurrect the list latch.
    await svc.send(session, withList);
    expect(evolution.sendList).toHaveBeenCalledTimes(3);
  });

  it('falls back to text when the interactive send fails', async () => {
    // The whole point of carrying a complete `plain` on every outbound.
    const { svc, evolution } = makeHarness();
    evolution.sendButtons.mockResolvedValue({ ok: false, error: 'this.isZero is not a function' });

    await svc.send(session, withButtons);
    expect(evolution.sendText).toHaveBeenCalledTimes(1);
    expect(evolution.sendText.mock.calls[0][1].text).toContain('Reply YES or NO');
  });

  it('remembers the numbered menu even for an interactive send', async () => {
    // People type "2" whether or not the buttons rendered.
    const { svc, sessions } = makeHarness();
    await svc.send(session, withButtons);
    expect(sessions.rememberMenu).toHaveBeenCalledWith(session, withButtons.menu);
  });

  it('never tries buttons when the admin has forced text mode', async () => {
    const { svc, evolution } = makeHarness({ interactiveMode: 'text' });
    await svc.send(session, withButtons);

    expect(evolution.sendButtons).not.toHaveBeenCalled();
    expect(evolution.sendText).toHaveBeenCalledTimes(1);
  });

  it('latches off after repeated failures instead of retrying forever', async () => {
    // One broken build should not add a wasted round trip to every reply.
    const { svc, evolution } = makeHarness();
    evolution.sendButtons.mockResolvedValue({ ok: false, error: 'nope' });

    for (let i = 0; i < 3; i++) await svc.send(session, withButtons);
    expect(evolution.sendButtons).toHaveBeenCalledTimes(3);

    await svc.send(session, withButtons);
    expect(evolution.sendButtons).toHaveBeenCalledTimes(3); // no 4th attempt
    expect(evolution.sendText).toHaveBeenCalledTimes(4); // but the reply still went
  });

  describe('poll mode', () => {
    const menuOut: WaOutbound = {
      plain: '1. Check in\n2. Check out',
      pollTitle: 'Tap an option',
      menu: [
        { n: 1, label: 'Check in', actionKey: 'attendance.checkin' },
        { n: 2, label: 'Check out', actionKey: 'attendance.checkout' },
      ],
    };

    it('sends a native poll when the mode asks for it', async () => {
      const { svc, evolution } = makeHarness({ interactiveMode: 'poll' });
      await svc.send(session, menuOut);

      expect(evolution.sendPoll).toHaveBeenCalledTimes(1);
      const args = evolution.sendPoll.mock.calls[0][1];
      expect(args.name).toBe('Tap an option');
      expect(args.options).toEqual(['Check in', 'Check out']);
      expect(evolution.sendText).not.toHaveBeenCalled();
    });

    it('falls back to text when the poll send fails', async () => {
      const { svc, evolution } = makeHarness({ interactiveMode: 'poll' });
      evolution.sendPoll.mockResolvedValue({ ok: false, error: 'nope' });

      await svc.send(session, menuOut);
      expect(evolution.sendText).toHaveBeenCalledTimes(1);
    });

    it('does not poll a menu longer than WhatsApp allows', async () => {
      // 12 options is the cap; a 15-item directory has to stay text.
      const { svc, evolution } = makeHarness({ interactiveMode: 'poll' });
      const big = {
        ...menuOut,
        menu: Array.from({ length: 15 }, (_, i) => ({
          n: i + 1,
          label: `Item ${i + 1}`,
          actionKey: `a.${i}`,
        })),
      };
      await svc.send(session, big);

      expect(evolution.sendPoll).not.toHaveBeenCalled();
      expect(evolution.sendText).toHaveBeenCalledTimes(1);
    });

    it('does not poll in auto mode — buttons or text only', async () => {
      const { svc, evolution } = makeHarness({ interactiveMode: 'auto' });
      await svc.send(session, menuOut);
      expect(evolution.sendPoll).not.toHaveBeenCalled();
    });
  });

  it('sends plain text when there are no buttons', async () => {
    const { svc, evolution } = makeHarness();
    await svc.send(session, { plain: 'Just text' });

    expect(evolution.sendButtons).not.toHaveBeenCalled();
    expect(evolution.sendText).toHaveBeenCalledTimes(1);
  });

  it('refuses to reply to a JID that is not a phone number', async () => {
    // An @lid chat has no address we can safely send to.
    const { svc, evolution } = makeHarness();
    const ok = await svc.send({ ...session, remoteJid: '12345@lid' }, { plain: 'hi' });

    expect(ok).toBe(false);
    expect(evolution.sendText).not.toHaveBeenCalled();
  });
});
