import { WhatsAppActionDef } from '../action.types';
import { bold, escapeWa, lines, outbound, unwrapData } from '../../render/wa-format';

const APPROVERS: any[] = ['ADMIN', 'HR_MANAGER', 'MANAGER'];

/**
 * Approve / reject tapped from a notification button.
 *
 * These are the only actions that operate on somebody else's record, so they
 * are the only ones that require an action token. The token supplies the
 * resource id from a server-side row; the inbound message never does.
 *
 * All of them are inert until `whatsapp.approvals_enabled` is turned on — the
 * router filters them out otherwise.
 */
export function approvalActions(): WhatsAppActionDef[] {
  const decided = (verb: string) => (payload: any) => {
    const d = unwrapData(payload);
    return outbound(
      lines(
        bold(verb === 'approve' ? '✅ Approved' : '❌ Rejected'),
        d?.status ? `Status is now ${escapeWa(d.status)}.` : '',
      ),
    );
  };

  return [
    {
      key: 'approval.leave.approve',
      menuLabel: 'Approve leave request',
      menuGroup: 'approvals',
      roles: APPROVERS,
      requiresEmployee: false,
      sensitivity: 'normal',
      keywords: [],
      tool: { name: 'leave_request_approve' },
      confirmPolicy: 'explicit',
      needsActionToken: true,
      hidden: true,
      render: decided('approve'),
    },
    {
      key: 'approval.leave.reject',
      menuLabel: 'Reject leave request',
      menuGroup: 'approvals',
      roles: APPROVERS,
      requiresEmployee: false,
      sensitivity: 'normal',
      keywords: [],
      tool: { name: 'leave_request_reject' },
      confirmPolicy: 'explicit',
      needsActionToken: true,
      hidden: true,
      // A rejection always needs a reason, so this can never be a single tap.
      flow: {
        key: 'approval.leave.reject',
        ttlMinutes: 10,
        steps: [
          {
            slot: 'reason',
            prompt: () => outbound(bold('Why are you rejecting this request?')),
            parse: (input) => {
              const raw = (input.text ?? '').trim();
              if (raw.length < 2) return { ok: false, error: 'Please give a short reason.' };
              return { ok: true, value: raw.slice(0, 1000) };
            },
          },
        ],
        // `reason` — leave_request_reject's field. overtime_reject calls the
        // same concept `rejectedReason`, and copying that name here meant every
        // leave rejection from chat failed zod validation.
        buildArgs: (slots) => ({ reason: slots.reason }),
      },
      render: decided('reject'),
    },
    {
      key: 'approval.overtime.approve',
      menuLabel: 'Approve overtime',
      menuGroup: 'approvals',
      roles: APPROVERS,
      requiresEmployee: false,
      sensitivity: 'normal',
      keywords: [],
      tool: { name: 'overtime_approve' },
      confirmPolicy: 'explicit',
      needsActionToken: true,
      hidden: true,
      render: decided('approve'),
    },
    {
      key: 'approval.overtime.reject',
      menuLabel: 'Reject overtime',
      menuGroup: 'approvals',
      roles: APPROVERS,
      requiresEmployee: false,
      sensitivity: 'normal',
      keywords: [],
      tool: { name: 'overtime_reject' },
      confirmPolicy: 'explicit',
      needsActionToken: true,
      hidden: true,
      flow: {
        key: 'approval.overtime.reject',
        ttlMinutes: 10,
        steps: [
          {
            slot: 'reason',
            prompt: () => outbound(bold('Why are you rejecting this overtime?')),
            parse: (input) => {
              const raw = (input.text ?? '').trim();
              if (raw.length < 2) return { ok: false, error: 'Please give a short reason.' };
              return { ok: true, value: raw.slice(0, 1000) };
            },
          },
        ],
        buildArgs: (slots) => ({ rejectedReason: slots.reason }),
      },
      render: decided('reject'),
    },
  ];
}

/** Approval keys, so the router can hide them behind the kill switch. */
export const APPROVAL_ACTION_KEYS = new Set(
  approvalActions().map((a) => a.key),
);
