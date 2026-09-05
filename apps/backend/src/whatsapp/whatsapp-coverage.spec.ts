import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { WHATSAPP_TEMPLATES, WHATSAPP_TEMPLATES_BY_TYPE } from './templates/whatsapp-template.registry';

/**
 * "Every update we email, we also send on WhatsApp."
 *
 * That claim is made of two halves that live nowhere near each other: a trigger
 * site passing a discriminating notification `type` (or an explicit key), and a
 * template in the registry that claims that type. Break either half and nothing
 * fails — the email still sends, the in-app bell still rings, and only the
 * handset goes quiet. There is no runtime error to notice.
 *
 * So this file checks the two halves against each other by reading the source.
 * It is deliberately coarse: it asserts reachability, not wording.
 */

const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.includes('.spec.') ? [p] : [];
  });
}

const FILES = walk(SRC).filter((f) => !f.endsWith('whatsapp-template.registry.ts'));
const ALL_SOURCE = FILES.map((f) => readFileSync(f, 'utf8')).join('\n');

/** Template keys named explicitly at a trigger site, in any of the three ways. */
const explicitKeys = new Set<string>([
  ...[...ALL_SOURCE.matchAll(/waTemplate:\s*'([a-z_]+)'/g)].map((m) => m[1]),
  ...[...ALL_SOURCE.matchAll(/templateKey:\s*'([a-z_]+)'/g)].map((m) => m[1]),
  // NotificationDispatcher turns `event` into the template key.
  ...[...ALL_SOURCE.matchAll(/event:\s*'([a-z_]+)'/g)].map((m) => m[1]),
  // Reached via GENERIC_TEMPLATE_KEY when the admin allows the catch-all.
  'generic',
]);

/** Every SCREAMING_CASE literal anywhere — a superset of emitted notification types. */
const emittedTypes = new Set([...ALL_SOURCE.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)].map((m) => m[1]));

describe('WhatsApp coverage', () => {
  describe('every registered template can actually fire', () => {
    // A template nobody can trigger still appears in the admin's "which updates
    // go out" list as an ON switch. The page then reports "20 of 20 on" while
    // some of those updates are incapable of sending anything.
    it.each([...WHATSAPP_TEMPLATES.keys()].map((k) => [k]))('%s is reachable', (key) => {
      const template = WHATSAPP_TEMPLATES.get(key)!;
      const byType = (template.notificationTypes ?? []).some((t) => emittedTypes.has(t));
      expect(byType || explicitKeys.has(key)).toBe(true);
    });
  });

  describe('every claimed notification type resolves', () => {
    it('maps each type to exactly one template', () => {
      // The registry throws on a duplicate claim at import time; this pins that
      // the map was actually built rather than silently empty.
      expect(WHATSAPP_TEMPLATES_BY_TYPE.size).toBeGreaterThan(0);
      for (const [type, template] of WHATSAPP_TEMPLATES_BY_TYPE) {
        expect(WHATSAPP_TEMPLATES.get(template.key)).toBe(template);
        expect(type).toMatch(/^[A-Z][A-Z0-9_]+$/);
      }
    });
  });

  describe('employee-facing decisions reach the handset', () => {
    /**
     * Each entry is a decision an employee is waiting on. The email for it
     * already existed; the WhatsApp half is what this pins. `type` must be
     * discriminating — a generic 'INFO' resolves to no template, which is
     * exactly how these four went email-only without anyone noticing.
     */
    const DECISIONS: Array<[string, string]> = [
      ['ATTENDANCE_CORRECTION_APPROVED', 'attendance_correction_decision'],
      ['ATTENDANCE_CORRECTION_REJECTED', 'attendance_correction_decision'],
      ['LEAVE_APPLIED', 'leave_applied'],
      ['LEAVE_APPROVED', 'leave_approved'],
      ['LEAVE_REJECTED', 'leave_rejected'],
      ['OVERTIME_APPROVED', 'overtime_approved'],
      ['OVERTIME_REJECTED', 'overtime_rejected'],
      ['TASK_ASSIGNED', 'task_assigned'],
      ['PROJECT_MEMBER_ADDED', 'project_member_added'],
    ];

    it.each(DECISIONS)('%s selects %s', (type, key) => {
      expect(WHATSAPP_TEMPLATES_BY_TYPE.get(type)?.key).toBe(key);
    });

    it.each(DECISIONS)('%s is actually emitted by some trigger site', (type) => {
      // Guards the other half: a template claiming a type nobody ever sends.
      expect(emittedTypes.has(type)).toBe(true);
    });
  });

  describe('login credentials go out on both channels', () => {
    const employees = readFileSync(join(SRC, 'employees/employees.service.ts'), 'utf8');

    // Anchored on the CALL form: `resendWelcomeEmail(` contains
    // `sendWelcomeEmail(`, so a bare substring match counts the declaration of
    // the resend endpoint as a third email and the assertion never holds.
    const emailCalls = (employees.match(/\.sendWelcomeEmail\(/g) ?? []).length;
    const waCalls = (employees.match(/\.sendCredentialsWhatsApp\(/g) ?? []).length;

    it('sends the WhatsApp copy when an employee is created, not only on resend', () => {
      // The original gap: the one moment an employee is definitely waiting for
      // their login — being added — was email-only, and only the manual
      // "Resend credentials" action ever reached WhatsApp.
      expect(waCalls).toBeGreaterThanOrEqual(2);
    });

    it('pairs every welcome email with a credentials message', () => {
      expect(waCalls).toBeGreaterThanOrEqual(emailCalls);
    });
  });

  describe('templates render without throwing', () => {
    // A template runs inside the notification tee, which swallows errors — so a
    // throwing render drops a message that looked deliverable, silently.
    const ctx = {
      title: 'T',
      message: 'M',
      link: '/x',
      appBaseUrl: 'https://portal.example.com',
      recipientName: 'A',
      companyName: 'C',
      data: {} as Record<string, unknown>,
    };

    it.each([...WHATSAPP_TEMPLATES.keys()].map((k) => [k]))('%s renders with no data', (key) => {
      const out = WHATSAPP_TEMPLATES.get(key)!.render(ctx as any);
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    });

    it.each([...WHATSAPP_TEMPLATES.keys()].map((k) => [k]))(
      '%s renders with junk data',
      (key) => {
        const junk = {
          ...ctx,
          data: {
            date: 'not-a-date',
            amount: null,
            fields: 'not-an-array',
            daysRemaining: 'soon',
            expiryDate: undefined,
          },
        };
        expect(() => WHATSAPP_TEMPLATES.get(key)!.render(junk as any)).not.toThrow();
      },
    );
  });
});
