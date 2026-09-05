import {
  GENERIC_TEMPLATE_KEY,
  listTemplates,
  WHATSAPP_TEMPLATES,
  WHATSAPP_TEMPLATES_BY_TYPE,
} from './whatsapp-template.registry';
import { WhatsAppTemplateContext } from './whatsapp-template.types';

/**
 * The registry is the WhatsApp allowlist, so these tests are as much about the
 * shape of the feature as about rendering. A template that throws would be
 * swallowed by the notification tee, which means a message that looked
 * deliverable would silently vanish — hence the "never throws" cases.
 */
const baseCtx = (over: Partial<WhatsAppTemplateContext> = {}): WhatsAppTemplateContext => ({
  recipientName: 'Aisha Al-Balushi',
  companyName: 'Acme HR',
  appBaseUrl: 'https://ess.example.com',
  title: 'Something happened',
  message: 'The body of the notification.',
  link: '/dashboard/leaves',
  data: {},
  ...over,
});

describe('WhatsApp template registry', () => {
  const keys = [...WHATSAPP_TEMPLATES.keys()];

  it('registers the Phase 1 template set', () => {
    expect(keys).toEqual(
      expect.arrayContaining([
        'expiry_reminder',
        'approval_requested',
        'approval_step_approved',
        'approval_rejected',
        'leave_applied',
        'leave_approved',
        'leave_rejected',
        'overtime_approved',
        'overtime_rejected',
        'training_nomination',
        'asset_assigned',
        'payroll_status',
        'payslip_ready',
        'shift_reminder',
        'generic',
      ]),
    );
  });

  describe.each(keys)('%s', (key) => {
    const t = WHATSAPP_TEMPLATES.get(key)!;

    it('renders a non-empty body from a minimal context', () => {
      const body = t.render(baseCtx());
      expect(typeof body).toBe('string');
      expect(body.trim().length).toBeGreaterThan(0);
    });

    it('does not throw when every optional data field is absent', () => {
      // The tee calls render() inside a business transaction; an exception here
      // must be impossible, not merely caught.
      expect(() => t.render(baseCtx({ data: {}, link: undefined }))).not.toThrow();
    });

    it('leaves no unresolved placeholders or stringified objects', () => {
      const body = t.render(baseCtx({ data: { nested: { a: 1 } } }));
      expect(body).not.toContain('{{');
      expect(body).not.toContain('undefined');
      expect(body).not.toContain('[object Object]');
      expect(body).not.toContain('NaN');
    });

    it('absolutises the deep link', () => {
      const body = t.render(baseCtx({ link: '/dashboard/leaves' }));
      expect(body).toContain('https://ess.example.com/dashboard/leaves');
    });

    it('escapes WhatsApp markup coming from user text', () => {
      // An unescaped asterisk in a leave reason would corrupt the formatting of
      // the entire message.
      const body = t.render(
        baseCtx({ message: 'reason *with* _markup_ and ~strike~', data: { reason: '*x*' } }),
      );
      expect(body).not.toContain('*with*');
      expect(body).not.toContain('_markup_');
    });

    it('points at the opt-out page rather than advertising a reply keyword', () => {
      // Phase 1 has no inbound webhook, so "reply STOP" would be a dead end.
      const body = t.render(baseCtx());
      expect(body).toContain('/dashboard/profile#notifications');
      expect(body).not.toMatch(/reply\s+stop/i);
    });
  });

  describe('type-based selection', () => {
    it('maps the discriminating notification types', () => {
      expect(WHATSAPP_TEMPLATES_BY_TYPE.get('LEAVE_APPROVED')?.key).toBe('leave_approved');
      expect(WHATSAPP_TEMPLATES_BY_TYPE.get('APPROVAL_REQUESTED')?.key).toBe('approval_requested');
    });

    it('does not claim the generic types', () => {
      // INFO/SUCCESS/WARNING/ERROR are passed by most call sites and cannot
      // discriminate a domain; claiming them would spam every notification.
      for (const generic of ['INFO', 'SUCCESS', 'WARNING', 'ERROR']) {
        expect(WHATSAPP_TEMPLATES_BY_TYPE.has(generic)).toBe(false);
      }
    });

    it('never lets two templates claim the same type', () => {
      const claimed = listTemplates().flatMap((t) => t.notificationTypes);
      expect(new Set(claimed).size).toBe(claimed.length);
    });

    it('keeps the generic passthrough off the type map', () => {
      const generic = WHATSAPP_TEMPLATES.get(GENERIC_TEMPLATE_KEY)!;
      expect(generic.notificationTypes ?? []).toHaveLength(0);
    });
  });

  describe('admin list metadata', () => {
    it('gives every update a group, so none lands in an unnamed section', () => {
      for (const t of listTemplates()) {
        expect(typeof t.group).toBe('string');
        expect(t.group.length).toBeGreaterThan(0);
      }
    });

    it('labels read as business events, not internal identities', () => {
      for (const t of listTemplates()) {
        expect(t.label).not.toMatch(/_/); // no snake_case keys leaking through
        expect(t.label).not.toMatch(/template|passthrough|fallback|payload/i);
        expect(t.label[0]).toBe(t.label[0].toUpperCase());
      }
    });
  });

  describe('content rules', () => {
    it('expiry_reminder renders the fields every reminder source supplies', () => {
      const body = WHATSAPP_TEMPLATES.get('expiry_reminder')!.render(
        baseCtx({
          data: {
            entityLabel: 'Visa',
            subjectName: 'Aisha Al-Balushi',
            expiryDate: '2026-09-01T00:00:00.000Z',
            daysRemaining: 30,
            fields: [{ label: 'Document no.', value: 'X1234567' }],
            isOwner: true,
          },
        }),
      );
      expect(body).toContain('Visa');
      expect(body).toContain('expires in 30 days');
      expect(body).toContain('01 Sep 2026');
      expect(body).toContain('X1234567');
    });

    it('expiry_reminder handles the already-expired and singular-day cases', () => {
      const render = (daysRemaining: number) =>
        WHATSAPP_TEMPLATES.get('expiry_reminder')!.render(
          baseCtx({ data: { entityLabel: 'Contract', daysRemaining } }),
        );
      expect(render(1)).toContain('expires in 1 day');
      expect(render(0)).toContain('has expired');
    });

    it('payslip_ready carries no salary figures', () => {
      // Amounts over a consumer messenger are a Phase 2 decision behind a PIN.
      const body = WHATSAPP_TEMPLATES.get('payslip_ready')!.render(
        baseCtx({ data: { period: 'August 2026', netSalary: 1137.5, gross: 1250 } }),
      );
      expect(body).toContain('August 2026');
      expect(body).not.toContain('1137');
      expect(body).not.toContain('1250');
    });

    /**
     * Shift reminders had no template at all, so they only reached WhatsApp when
     * an admin had switched the catch-all `generic` fallback on. The scheduler
     * emits a plain INFO/WARNING, so there is no notification type to fall back
     * to either — the key has to exist and be requested explicitly.
     */
    describe('shift_reminder', () => {
      const render = (data: Record<string, unknown>) =>
        WHATSAPP_TEMPLATES.get('shift_reminder')!.render(baseCtx({ data }));

      it('reads as a countdown before the shift', () => {
        const body = render({
          phase: 'prior',
          shiftType: 'MORNING',
          startTime: '09:00 AM',
          endTime: '06:00 PM',
          offsetMins: 15,
        });
        expect(body).toContain('starts in 15 minutes');
        expect(body).toContain('09:00 AM');
        expect(body).toContain('06:00 PM');
        expect(body).toContain('MORNING');
      });

      it('reads as a missed-punch alert after the shift started', () => {
        const body = render({ phase: 'post', startTime: '09:00 AM', offsetMins: 5 });
        expect(body).toContain('started 5 minutes ago');
        // The post alert is the only one with something to do about it.
        expect(body).toMatch(/check in/i);
      });

      it('says "1 minute", not "1 minutes"', () => {
        expect(render({ phase: 'prior', offsetMins: 1 })).toContain('starts in 1 minute');
        expect(render({ phase: 'post', offsetMins: 1 })).toContain('started 1 minute ago');
      });

      it('stays readable when the scheduler passes no offset', () => {
        expect(render({ phase: 'prior' })).toContain('is starting soon');
        expect(render({ phase: 'post' })).toContain('has already started');
      });

      it('does not tell the employee to check in before the shift begins', () => {
        expect(render({ phase: 'prior', offsetMins: 15 })).not.toMatch(/check in/i);
      });
    });

    it('payslip_ready carries no figures — salary over a consumer messenger is a separate decision', () => {
      const body = WHATSAPP_TEMPLATES.get('payslip_ready')!.render(
        baseCtx({ data: { netSalary: '1234567890' } }),
      );
      expect(body).not.toContain('1234567890');
    });
  });
});
