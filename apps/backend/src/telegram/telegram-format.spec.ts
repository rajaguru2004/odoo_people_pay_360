import {
  b,
  chunkTelegram,
  code,
  escapeTelegramHtml,
  kv,
  TELEGRAM_MAX_CHARS,
  toTelegramHtml,
} from './render/telegram-format';

describe('Telegram HTML conversion', () => {
  it('converts WhatsApp bold', () => {
    expect(toTelegramHtml('*Checked in*')).toBe('<b>Checked in</b>');
  });

  it('converts WhatsApp italic', () => {
    expect(toTelegramHtml('_Marked late._')).toBe('<i>Marked late.</i>');
  });

  it('converts strikethrough', () => {
    expect(toTelegramHtml('~gone~')).toBe('<s>gone</s>');
  });

  it('handles bold and italic in one string', () => {
    expect(toTelegramHtml('*Bold* and _italic_')).toBe('<b>Bold</b> and <i>italic</i>');
  });

  it('handles a real rendered message', () => {
    const wa = '*📅 Today*\n*Status:* PRESENT\n_Not checked out yet._';
    expect(toTelegramHtml(wa)).toBe(
      '<b>📅 Today</b>\n<b>Status:</b> PRESENT\n<i>Not checked out yet.</i>',
    );
  });

  it.each(['', 'no markup at all', '2 * 3 = 6'])('leaves %p alone', (input) => {
    expect(toTelegramHtml(input)).toBe(input);
  });

  // The order bug this guards: escaping AFTER inserting tags would turn the
  // <b> we just wrote into &lt;b&gt; and the message would render as source.
  it('escapes the payload before inserting tags, not after', () => {
    expect(toTelegramHtml('*a < b & c*')).toBe('<b>a &lt; b &amp; c</b>');
  });

  it('neutralises markup smuggled in through content', () => {
    // A name, an email or a User-Agent is attacker-controlled on the failed
    // login path. It must never be able to close a tag we opened.
    expect(toTelegramHtml('</b><a href="x">click</a>')).toBe(
      '&lt;/b&gt;&lt;a href="x"&gt;click&lt;/a&gt;',
    );
  });

  it('escapes exactly the three characters Telegram HTML reserves', () => {
    expect(escapeTelegramHtml(`& < > " '`)).toBe(`&amp; &lt; &gt; " '`);
  });
});

describe('Telegram HTML helpers', () => {
  it('escapes inside bold', () => {
    expect(b('a & b')).toBe('<b>a &amp; b</b>');
  });

  it('escapes inside code, which is where user agents go', () => {
    expect(code('Mozilla/5.0 <script>')).toBe('<code>Mozilla/5.0 &lt;script&gt;</code>');
  });

  it('renders a labelled line', () => {
    expect(kv('Email', 'a@b.com')).toBe('<b>Email:</b> a@b.com');
  });

  it.each([null, undefined, '', '   '])('drops the whole line for %p', (v) => {
    expect(kv('Email', v)).toBe('');
  });
});

describe('Telegram chunking', () => {
  it('leaves a short message intact', () => {
    expect(chunkTelegram('short')).toEqual(['short']);
  });

  it('splits on line boundaries at the 4096-char cap', () => {
    const line = 'x'.repeat(100);
    const parts = chunkTelegram(Array.from({ length: 80 }, () => line).join('\n'));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  it('breaks a single over-long line rather than dropping it', () => {
    const parts = chunkTelegram('y'.repeat(9000));
    expect(parts.join('').length).toBe(9000);
  });

  it('uses a larger cap than Discord — 4096, not 2000', () => {
    // Pinned because chunking at Discord's cap would split every payslip into
    // two messages for no reason.
    expect(chunkTelegram('z'.repeat(3000))).toHaveLength(1);
  });
});
