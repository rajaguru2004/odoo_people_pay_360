import { eventNameOf, parseInbound, redactEnvelope } from './inbound-parser';

/**
 * A silent parse miss produces a dead channel that looks healthy from every
 * dashboard — the webhook returns 200, nothing errors, and no user gets a
 * reply. Hence the breadth here.
 */
const envelope = (over: any = {}, message: any = { conversation: 'hello' }) => ({
  event: 'messages.upsert',
  instance: 'skill_hive',
  data: {
    key: { remoteJid: '919952982836@s.whatsapp.net', fromMe: false, id: 'WA1', ...over.key },
    pushName: 'Tester',
    messageType: 'conversation',
    message,
    ...over.data,
  },
  ...over.root,
});

describe('eventNameOf', () => {
  it.each([
    ['messages.upsert', 'MESSAGES_UPSERT'],
    ['MESSAGES_UPSERT', 'MESSAGES_UPSERT'],
    ['messages-upsert', 'MESSAGES_UPSERT'],
  ])('normalises %s', (input, expected) => {
    // Evolution builds differ on spelling; matching one and ignoring the other
    // would silently drop every message.
    expect(eventNameOf({ event: input })).toBe(expected);
  });

  it('returns empty for a missing event', () => {
    expect(eventNameOf({})).toBe('');
  });
});

describe('parseInbound — accepted shapes', () => {
  it('reads a plain text message', () => {
    const res = parseInbound(envelope());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message).toMatchObject({
      instance: 'skill_hive',
      waMessageId: 'WA1',
      phoneE164: '+919952982836',
      pushName: 'Tester',
      kind: 'text',
      text: 'hello',
    });
  });

  it('reads extendedTextMessage', () => {
    const res = parseInbound(envelope({}, { extendedTextMessage: { text: ' MENU ' } }));
    expect(res.ok && res.message.text).toBe('MENU');
  });

  it.each([
    ['ephemeralMessage', { ephemeralMessage: { message: { conversation: 'hi' } } }],
    ['viewOnceMessage', { viewOnceMessage: { message: { conversation: 'hi' } } }],
    ['viewOnceMessageV2', { viewOnceMessageV2: { message: { conversation: 'hi' } } }],
    [
      'documentWithCaptionMessage',
      { documentWithCaptionMessage: { message: { conversation: 'hi' } } },
    ],
    [
      'nested twice',
      { ephemeralMessage: { message: { viewOnceMessageV2: { message: { conversation: 'hi' } } } } },
    ],
  ])('unwraps %s', (_label, message) => {
    // Disappearing-message chats nest real content one or two levels deeper.
    const res = parseInbound(envelope({}, message));
    expect(res.ok && res.message.text).toBe('hi');
  });

  it.each([
    ['buttonsResponseMessage', { buttonsResponseMessage: { selectedButtonId: 'v1|leave.balance' } }],
    ['templateButtonReplyMessage', { templateButtonReplyMessage: { selectedId: 'v1|leave.balance' } }],
    [
      'listResponseMessage',
      { listResponseMessage: { singleSelectReply: { selectedRowId: 'v1|leave.balance' } } },
    ],
    [
      'nativeFlow',
      {
        interactiveResponseMessage: {
          nativeFlowResponseMessage: { paramsJson: '{"id":"v1|leave.balance"}' },
        },
      },
    ],
  ])('reads a callback id from %s', (_label, message) => {
    const res = parseInbound(envelope({}, message));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message.kind).toBe('callback');
    expect(res.message.callbackId).toBe('v1|leave.balance');
  });

  it('prefers the callback id over any display text', () => {
    // Routing on the visible label would lose the parameters in the id.
    const res = parseInbound(
      envelope({}, {
        conversation: 'Leave balance',
        buttonsResponseMessage: { selectedButtonId: 'v1|leave.balance|m=8' },
      }),
    );
    expect(res.ok && res.message.kind).toBe('callback');
  });

  it('reads a shared location', () => {
    const res = parseInbound(
      envelope({}, { locationMessage: { degreesLatitude: 12.97, degreesLongitude: 77.59 } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message.kind).toBe('location');
    expect(res.message.location).toEqual({ latitude: 12.97, longitude: 77.59 });
  });

  it('classifies an unsupported attachment rather than dropping it', () => {
    const res = parseInbound(envelope({}, { audioMessage: { seconds: 3 } }));
    expect(res.ok && res.message.kind).toBe('unsupported');
  });
});

describe('parseInbound — rejected shapes', () => {
  it('drops a non-message event', () => {
    const body = envelope();
    body.event = 'connection.update';
    expect(parseInbound(body).ok).toBe(false);
  });

  it('drops our own echo', () => {
    // Outbound messages come back through the same webhook.
    const body = envelope();
    body.data.key.fromMe = true;
    expect(parseInbound(body).ok).toBe(false);
  });

  it.each([
    '12345@g.us',
    'status@broadcast',
    'abc@newsletter',
  ])('drops group/broadcast %s', (jid) => {
    const body = envelope();
    body.data.key.remoteJid = jid;
    expect(parseInbound(body).ok).toBe(false);
  });

  it('drops protocol and reaction messages', () => {
    expect(parseInbound(envelope({ data: { messageType: 'protocolMessage' } })).ok).toBe(false);
    expect(parseInbound(envelope({}, { reactionMessage: { text: '👍' } })).ok).toBe(false);
  });

  it('drops an envelope with no key', () => {
    expect(parseInbound({ event: 'messages.upsert', data: {} }).ok).toBe(false);
  });
});

describe('parseInbound — sender resolution', () => {
  it('prefers senderPn over an @lid remoteJid', () => {
    // @lid is a privacy identifier, NOT a phone number. Treating it as one
    // could match a different person whose real number is those digits.
    const body = envelope({ key: { remoteJid: '123456789@lid', senderPn: '919952982836' } });
    const res = parseInbound(body);
    expect(res.ok && res.message.phoneE164).toBe('+919952982836');
    expect(res.ok && res.message.remoteJid).toBe('123456789@lid');
  });

  it('returns null rather than guessing when only an @lid is present', () => {
    const body = envelope({ key: { remoteJid: '123456789@lid' } });
    const res = parseInbound(body);
    expect(res.ok && res.message.phoneE164).toBeNull();
  });

  it('never falls back to the top-level sender field', () => {
    // On Evolution that is the INSTANCE OWNER's jid — trusting it would
    // attribute every inbound message to the bot's own number.
    const body = envelope({
      key: { remoteJid: '123456789@lid' },
      root: { sender: '917603941558@s.whatsapp.net' },
    });
    const res = parseInbound(body);
    expect(res.ok && res.message.phoneE164).toBeNull();
  });
});

describe('redactEnvelope', () => {
  it('strips the instance credential', () => {
    // The webhook body carries a live apikey; the admin UI renders this column.
    const out = redactEnvelope({ apikey: 'SECRET', server_url: 'https://x', data: { a: 1 } });
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(JSON.stringify(out)).not.toContain('https://x');
    expect(out.data.a).toBe(1);
  });

  it('strips inline media blobs', () => {
    const out = redactEnvelope({ data: { base64: 'AAAA'.repeat(1000) } });
    expect(out.data.base64).toBe('[stripped]');
  });

  it('truncates any runaway string', () => {
    const out = redactEnvelope({ data: { note: 'x'.repeat(9000) } });
    expect(out.data.note.length).toBeLessThan(500);
  });
});
