/**
 * Live wiring check for the Telegram channel.
 *
 * Exercises the REAL path — settings resolution, the login-alert renderer, the
 * outbox row, the drainer, the Bot API client — and sends one actual message.
 * That is the point: the unit and e2e suites stub the HTTP client, so they can
 * prove the message is correct but not that the bot, the token and the chat id
 * agree with each other.
 *
 * Refuses to run against anything but a loopback database, for the reason
 * `assert-test-database.ts` exists: this writes rows, and `apps/backend/.env`
 * has pointed at production before.
 *
 *   DATABASE_URL=postgresql://…@localhost:8069/ess_e2e \
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_ALERT_CHAT_ID=… \
 *   npx ts-node --transpile-only scripts/telegram-live-check.ts
 */
import { PrismaClient } from '@prisma/client';
import { TelegramApiClient } from '../src/telegram/api/telegram-api.client';
import { TelegramOutboxService } from '../src/telegram/telegram-outbox.service';
import { TelegramSettingsService } from '../src/telegram/telegram-settings.service';
import { LoginAlertService } from '../src/telegram/login-alerts/login-alert.service';
import { IpGeoService } from '../src/telegram/login-alerts/ip-geo.service';
import { TELEGRAM_SETTING_KEYS } from '../src/telegram/telegram.types';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function assertLoopback(url: string): void {
  if (!/^postgresql:\/\/[^@]*@(localhost|127\.0\.0\.1):8069\//.test(url)) {
    throw new Error(
      `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — loopback:8069 only.`,
    );
  }
}

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  assertLoopback(url);
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = (process.env.TELEGRAM_ALERT_CHAT_ID ?? '').trim();
  if (!token || !chatId) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALERT_CHAT_ID.');

  console.log('target :', url.replace(/:\/\/[^@]*@/, '://***@'));
  console.log('chat   :', chatId);

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const settings = new TelegramSettingsService(prisma as any);
  const api = new TelegramApiClient();
  const outbox = new TelegramOutboxService(prisma as any, settings, api);
  const alerts = new LoginAlertService(settings, outbox, new IpGeoService(), prisma as any);

  // Turn the channel on for this database only. The token goes through the same
  // encrypt-on-write path the admin endpoint uses.
  await settings.update({
    enabled: true,
    botToken: token,
    alertChatId: chatId,
    loginAlertsEnabled: true,
    loginAlertFailures: true,
    loginAlertGeo: true,
  });

  const cfg = await settings.ensureConfigured();
  if (!cfg) throw new Error('Channel is still not configured after the write.');

  // The RESOLVED id, not the argument: settings normalise a pasted label or a
  // typographic dash, and sending to the raw string would test something the
  // application never does.
  const resolvedChat = cfg.alertChatId;
  if (resolvedChat !== chatId) console.log('chat   : normalised to', resolvedChat);

  const me = await api.getMe(cfg);
  console.log('bot    :', me ? `@${me.username} (${me.id})` : 'getMe FAILED — bad token?');
  if (!me) process.exit(1);

  // 1. Resolve the chat before sending anything. `sendMessage` answers every
  //    bad-chat cause with the same "chat not found"; getChat names the group.
  const chat = await api.getChat(cfg, resolvedChat);
  console.log('chat   :', chat.ok ? `"${chat.title}" (${chat.type}, id ${chat.id})` : `FAILED — ${chat.error}`);
  if (!chat.ok) process.exit(1);

  // 2. A plain send, to prove the bot can post in that chat at all.
  const direct = await api.sendMessage(
    cfg,
    resolvedChat,
    '<b>ESS</b>\nTelegram channel wiring check — step 1 of 3 (direct send).',
  );
  console.log('direct :', direct.ok ? `sent id=${direct.messageId}` : `FAILED — ${direct.error}`);
  if (!direct.ok) process.exit(1);

  // 3. A successful login alert, built by the real renderer.
  alerts.onLoginSuccess(
    {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'wiring.check@example.com',
      role: 'ADMIN',
      employeeId: null,
      fullName: 'Wiring Check',
      employeeCode: 'EMP-0001',
      branchName: 'Muscat HO',
      branchId: null,
    },
    { ip: '8.8.8.8', userAgent: CHROME_UA },
  );

  // 4. A failed login alert.
  alerts.onLoginFailure('attacker@example.com', 'BAD_PASSWORD', {
    ip: '1.1.1.1',
    userAgent: 'curl/8.6.0',
  });

  await new Promise((r) => setTimeout(r, 1500));
  const drained = await outbox.drain();
  console.log('drain  :', JSON.stringify(drained));

  const rows = await prisma.telegramMessage.findMany({
    where: { templateKey: { startsWith: 'login_alert' } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { templateKey: true, status: true, lastError: true },
  });
  for (const r of rows) {
    console.log(`row    : ${r.templateKey} ${r.status}${r.lastError ? ` — ${r.lastError}` : ''}`);
  }

  // Leave the database as it was found: the token must not linger in a shared
  // local database after a smoke test.
  await prisma.systemSetting.deleteMany({
    where: { key: { in: [TELEGRAM_SETTING_KEYS.botTokenEnc, TELEGRAM_SETTING_KEYS.enabled] } },
  });
  await prisma.telegramMessage.deleteMany({
    where: { templateKey: { startsWith: 'login_alert' } },
  });
  await prisma.$disconnect();
  console.log('cleanup: token and test rows removed from the local database.');
}

void main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
