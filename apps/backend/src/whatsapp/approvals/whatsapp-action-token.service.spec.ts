import { createHash } from 'crypto';
import { WhatsAppActionTokenService } from './whatsapp-action-token.service';

/**
 * Approvals are the highest-risk surface in the channel: they act on somebody
 * else's record. Four properties carry that weight, and each is tested here.
 */
function makeHarness(row: any = null) {
  const store: any = { row };
  const prisma: any = {
    whatsAppActionToken: {
      create: jest.fn().mockImplementation(({ data }: any) => {
        store.row = { id: 't1', status: 'PENDING', ...data };
        return store.row;
      }),
      findUnique: jest.fn().mockImplementation(({ where }: any) =>
        store.row && store.row.tokenHash === where.tokenHash ? store.row : null,
      ),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        if (!store.row || store.row.status !== 'PENDING') return { count: 0 };
        if (where.expiresAt?.gt && store.row.expiresAt <= where.expiresAt.gt) return { count: 0 };
        Object.assign(store.row, data);
        return { count: 1 };
      }),
    },
  };
  return { svc: new WhatsAppActionTokenService(prisma), prisma, store };
}

const SESSION = { identityId: 'i1', userId: 'u1' };

const issueArgs = {
  identityId: 'i1',
  userId: 'u1',
  actionKey: 'approval.leave.approve',
  toolName: 'leave_request_approve',
  args: { id: 'leave-1' },
  resourceType: 'LeaveRequest',
  resourceId: 'leave-1',
  ttlMinutes: 60,
};

describe('WhatsAppActionTokenService', () => {
  it('stores only the hash, never a usable token', async () => {
    const { svc, store } = makeHarness();
    const { token } = await svc.issue(issueArgs);

    expect(token).toHaveLength(43); // 32 bytes base64url
    expect(store.row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(store.row)).not.toContain(token);
  });

  it('returns the arguments from the server-side row', async () => {
    // The inbound message never supplies a resource id — this is why.
    const { svc } = makeHarness();
    const { token } = await svc.issue(issueArgs);
    const res = await svc.consume(token, SESSION, 'msg1');

    expect(res).toMatchObject({
      ok: true,
      toolName: 'leave_request_approve',
      args: { id: 'leave-1' },
    });
  });

  it('is single-use — a double tap decides once', async () => {
    const { svc } = makeHarness();
    const { token } = await svc.issue(issueArgs);

    expect((await svc.consume(token, SESSION, 'msg1')).ok).toBe(true);
    const second = await svc.consume(token, SESSION, 'msg2');
    expect(second).toEqual({ ok: false, reason: 'replay' });
  });

  it('rejects a token presented by a different handset', async () => {
    // Defeats forwarding: the token string survives, the binding does not.
    const { svc } = makeHarness();
    const { token } = await svc.issue(issueArgs);

    const res = await svc.consume(token, { identityId: 'other', userId: 'u1' }, 'msg1');
    expect(res).toEqual({ ok: false, reason: 'wrong-identity' });
  });

  it('rejects a token presented for a different user', async () => {
    const { svc } = makeHarness();
    const { token } = await svc.issue(issueArgs);

    const res = await svc.consume(token, { identityId: 'i1', userId: 'other' }, 'msg1');
    expect(res).toEqual({ ok: false, reason: 'wrong-identity' });
  });

  it('rejects an expired token', async () => {
    const { svc } = makeHarness();
    const { token } = await svc.issue({ ...issueArgs, ttlMinutes: -1 });

    expect(await svc.consume(token, SESSION, 'msg1')).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects an unknown token', async () => {
    const { svc } = makeHarness();
    await svc.issue(issueArgs);

    expect(await svc.consume('not-a-real-token', SESSION, 'msg1')).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('records which message consumed it', async () => {
    const { svc, store } = makeHarness();
    const { token } = await svc.issue(issueArgs);
    await svc.consume(token, SESSION, 'inbound-42');

    expect(store.row.consumedByMessageId).toBe('inbound-42');
    expect(store.row.status).toBe('CONSUMED');
  });
});
