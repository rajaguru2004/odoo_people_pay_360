import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The settings write contract, checked against itself.
 *
 * Two silent failure modes live in the gap between the DTO and the service,
 * and both have bitten this page already:
 *
 *   1. The UI sends a field the DTO does not declare. The ValidationPipe
 *      whitelists, so the WHOLE save 400s — "property approvalTokenTtlMinutes
 *      should not exist" — and the admin sees a page that simply will not
 *      save. The frontend side is now a compile error (EDITABLE_KEYS is typed
 *      against the write contract); this file guards the backend side.
 *
 *   2. The DTO accepts a field that `update()` never pushes. That one is
 *      WORSE: the request succeeds, the toggle animates, and nothing is
 *      persisted. Nobody finds out until someone wonders why a setting keeps
 *      reverting.
 *
 * Source text rather than reflection: class-validator metadata does not expose
 * plain optional properties, and the thing worth pinning is what a reviewer
 * would read anyway.
 */

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

const dtoSource = read('dto/update-whatsapp-settings.dto.ts');
const serviceSource = read('whatsapp-settings.service.ts');

/** Declared properties of UpdateWhatsAppSettingsDto. */
const dtoFields = [...dtoSource.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);

/** Fields `update()` writes through the generic `push(...)` helper. */
const pushedFields = new Set(
  [...serviceSource.matchAll(/push\(SETTING_KEYS\.\w+,\s*dto\.(\w+)/g)].map((m) => m[1]),
);

/**
 * Fields deliberately handled outside `push` — each for a stated reason, so a
 * newly-forgotten field cannot hide behind a vague allowlist.
 */
const SPECIALLY_HANDLED: Record<string, string> = {
  apiKey: 'encrypted before write, never a plain upsert',
  clearApiKey: 'deletes the row rather than writing a value',
  disabledTemplates: 'validated against the template registry, then joined to CSV',
  quietHoursOverrideTemplates: 'joined to CSV',
  actionDenylist: 'joined to CSV',
  redirectAllTo:
    'parsed to E.164 and REJECTED if unreadable before write — an unparseable ' +
    'value halts the whole channel, so it must not reach the row (see ' +
    'normaliseRedirectForWrite, pinned in whatsapp-settings.security.spec.ts)',
  carbonCopyTo:
    'parsed to E.164 and rejected if unreadable before write, via the same ' +
    'normalisePhoneForWrite helper as redirectAllTo',
};

describe('WhatsApp settings write contract', () => {
  it('declares the fields the admin page sends', () => {
    // Spot-check the ones added late, which is when this drifts.
    for (const field of [
      'inboundEnabled',
      'enrollmentEnabled',
      'mutationsEnabled',
      'approvalsEnabled',
      'requirePinForSensitive',
      'approvalTokenTtlMinutes',
      'attendanceVerification',
      'selfieDailyCap',
      'selfieChallengeSeconds',
      'verificationLinkTtlMinutes',
      'supportContact',
      'quietHoursStart',
      'quietHoursEnd',
    ]) {
      expect(dtoFields).toContain(field);
    }
  });

  it('persists every field it accepts', () => {
    // The silent one: accepted, validated, and then dropped on the floor.
    const dropped = dtoFields.filter(
      (f) => !pushedFields.has(f) && !(f in SPECIALLY_HANDLED),
    );
    expect(dropped).toEqual([]);
  });

  it('does not claim special handling for a field that no longer exists', () => {
    // Keeps the allowlist honest as the DTO changes.
    for (const field of Object.keys(SPECIALLY_HANDLED)) {
      expect(dtoFields).toContain(field);
    }
  });

  it('never accepts a read-only projection field', () => {
    // These describe state; they are not settings. Accepting one would let a
    // client "set" something the server computes.
    for (const field of [
      'apiKeyConfigured',
      'apiKeyMasked',
      'apiKeySource',
      'redirectMisconfigured',
      'webhookSecretConfigured',
    ]) {
      expect(dtoFields).not.toContain(field);
    }
  });
});
