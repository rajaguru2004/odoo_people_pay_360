import { CommandRouterService } from './command-router.service';
import { decodeCallback, encodeCallback, isCallbackId } from './callback-id';

/**
 * The resolution ladder. Order matters more than any single rule, so most of
 * these tests are about precedence rather than individual matches.
 */
const ACTIONS: Record<string, any> = {
  'leave.balance': { key: 'leave.balance', keywords: ['leave balance'], patterns: [/^balance$/] },
  'attendance.checkin': { key: 'attendance.checkin', keywords: ['check in'], patterns: [] },
  'attendance.checkin_location': { key: 'attendance.checkin_location', keywords: [] },
};

function makeRouter(menu?: any[], menuAgeMinutes = 0) {
  const registry: any = {
    getByKey: (k: string) => ACTIONS[k],
    getByKeyword: (w: string) =>
      Object.values(ACTIONS).find((a: any) => a.keywords.includes(w)),
    matchPattern: (t: string) =>
      Object.values(ACTIONS).find((a: any) => (a.patterns ?? []).some((re: RegExp) => re.test(t))),
  };
  const sessions: any = {
    resolveMenuChoice: (_s: any, n: number) =>
      menu && menuAgeMinutes < 10 ? (menu.find((o) => o.n === n) ?? null) : null,
  };
  return new CommandRouterService(registry, sessions);
}

const session: any = { id: 's1' };
const text = (t: string) => ({ kind: 'text' as const, text: t, callbackId: null });

describe('normalise', () => {
  it.each([
    ['  CHECK IN  ', 'check in'],
    ['/menu', 'menu'],
    ['Menu?', 'menu'],
    ['MENU!', 'menu'],
    ['check in', 'check in'],
    ['check in 👍', 'check in'],
  ])('%p -> %p', (input, expected) => {
    expect(makeRouter().normalise(input)).toBe(expected);
  });
});

describe('resolution ladder', () => {
  it('resolves a callback id to its action', () => {
    const r = makeRouter().resolve(
      session,
      { kind: 'callback', text: null, callbackId: encodeCallback('leave.balance') },
      false,
    );
    expect(r).toMatchObject({ type: 'action', action: { key: 'leave.balance' } });
  });

  it('carries callback params through', () => {
    const r = makeRouter().resolve(
      session,
      { kind: 'callback', text: null, callbackId: encodeCallback('leave.balance', { m: '8' }) },
      false,
    );
    expect(r.type === 'action' && r.params).toEqual({ m: '8' });
  });

  it('treats an unknown callback id as no-match, never as text', () => {
    const r = makeRouter().resolve(
      session,
      { kind: 'callback', text: null, callbackId: 'v1|nope.gone' },
      false,
    );
    expect(r.type).toBe('no-match');
  });

  it('answers a shared location with guidance, never a punch', () => {
    // It used to auto-check-in. Retired: a pin is wherever the sender drops
    // it, including a place they are not standing — the secure link's browser
    // fix replaced it, and old habits get redirected rather than punched in.
    const r = makeRouter().resolve(
      session,
      { kind: 'location', text: null, callbackId: null },
      false,
    );
    expect(r).toEqual({ type: 'location-attachment' });
  });

  it.each([
    ['cancel', 'cancel'],
    ['MENU', 'menu'],
    ['help', 'help'],
    ['stop', 'stop'],
    ['yes', 'yes'],
    ['no', 'no'],
    ['0', 'menu'],
  ])('recognises the control verb %p', (input, verb) => {
    const r = makeRouter().resolve(session, text(input), false);
    expect(r).toEqual({ type: 'control', verb });
  });

  it('CONTROLS BEAT FLOW INPUT — cancel is never swallowed as a leave reason', () => {
    // The single most important ordering rule in the ladder.
    const r = makeRouter().resolve(session, text('cancel'), true);
    expect(r).toEqual({ type: 'control', verb: 'cancel' });
  });

  it('treats other text as flow input while a flow is active', () => {
    const r = makeRouter().resolve(session, text('leave balance'), true);
    expect(r).toEqual({ type: 'flow-input' });
  });

  it('does not route a location into an active flow', () => {
    // Mid-flow a location is an answer to the current step, not a new command.
    const r = makeRouter().resolve(
      session,
      { kind: 'location', text: null, callbackId: null },
      true,
    );
    expect(r).toEqual({ type: 'flow-input' });
  });

  it('resolves a numbered reply against the menu we rendered', () => {
    const r = makeRouter([{ n: 2, label: 'Leave balance', actionKey: 'leave.balance' }]).resolve(
      session,
      text('2'),
      false,
    );
    expect(r).toMatchObject({ type: 'action', action: { key: 'leave.balance' } });
  });

  it('treats a bare number with NO stored menu as no-match, never a guess', () => {
    // Guessing here could fire a mutation the user never asked for.
    const r = makeRouter().resolve(session, text('2'), false);
    expect(r.type).toBe('no-match');
  });

  it('ignores a stale menu', () => {
    const r = makeRouter([{ n: 2, label: 'x', actionKey: 'leave.balance' }], 30).resolve(
      session,
      text('2'),
      false,
    );
    expect(r.type).toBe('no-match');
  });

  it('matches an exact keyword', () => {
    const r = makeRouter().resolve(session, text('Leave Balance'), false);
    expect(r).toMatchObject({ type: 'action', action: { key: 'leave.balance' } });
  });

  it('falls through to an anchored pattern', () => {
    const r = makeRouter().resolve(session, text('balance'), false);
    expect(r).toMatchObject({ type: 'action', action: { key: 'leave.balance' } });
  });

  it('does NOT fuzzy-match', () => {
    // "checkin" vs "checkout" is 3 edits; "in" vs "out" is one word apart in
    // meaning. A fuzzy hit that fires a mutation is unrecoverable.
    for (const t of ['chekc in', 'blance', 'leave balence']) {
      expect(makeRouter().resolve(session, text(t), false).type).toBe('no-match');
    }
  });

  it('returns the normalised text on no-match, for the AI seam', () => {
    const r = makeRouter().resolve(session, text('What is my leave?'), false);
    expect(r).toEqual({ type: 'no-match', text: 'what is my leave' });
  });
});

describe('callback ids', () => {
  it('round-trips an action key and params', () => {
    const enc = encodeCallback('approval.leave.approve', { t: 'abc123' });
    expect(isCallbackId(enc)).toBe(true);
    expect(decodeCallback(enc)).toEqual({
      actionKey: 'approval.leave.approve',
      params: { t: 'abc123' },
    });
  });

  it('caps the length so an id cannot be used as a payload', () => {
    const enc = encodeCallback('a.b', { x: 'y'.repeat(500) });
    expect(enc.length).toBeLessThanOrEqual(200);
  });

  it.each(['', 'hello', 'v2|a.b', null, undefined])('rejects %p', (v) => {
    expect(isCallbackId(v as any)).toBe(false);
  });
});

describe('greetings', () => {
  // Saying hello is the most likely first message anybody sends. Without this
  // it fell through to no-match, so greeting the assistant answered "I did not
  // understand that" — which reads as broken however well the rest works.
  it.each([
    'hi',
    'Hi',
    'hii',
    'hey',
    'heyy',
    'hello',
    'Hello!',
    'hai',
    'yo',
    'howdy',
    'good morning',
    'Good Evening',
    'namaste',
    'vanakkam',
  ])('answers %p with the menu', (t) => {
    const r = makeRouter().resolve(session, text(t), false);
    expect(r).toEqual({ type: 'control', verb: 'greeting' });
  });

  it.each(['hi there can I check in', 'hello leave balance', 'high', 'history'])(
    'does not treat %p as a greeting',
    (t) => {
      // Anchored and exact on purpose: guessing at "hi there, can I check in"
      // is how a bot checks somebody in who was only being polite. And "high"
      // / "history" must not be swallowed by a loose hi+ pattern.
      const r = makeRouter().resolve(session, text(t), false);
      expect(r.type).not.toBe('control');
    },
  );

  it('is just text mid-flow', () => {
    // A greeting is a courtesy, not an instruction. Abandoning a half-finished
    // leave application because somebody typed "hi" would be worse than
    // storing it as an answer the step can reject on its own terms.
    const r = makeRouter().resolve(session, text('hi'), true);
    expect(r).toEqual({ type: 'flow-input' });
  });

  it('never shadows CANCEL', () => {
    const r = makeRouter().resolve(session, text('cancel'), true);
    expect(r).toEqual({ type: 'control', verb: 'cancel' });
  });
});
