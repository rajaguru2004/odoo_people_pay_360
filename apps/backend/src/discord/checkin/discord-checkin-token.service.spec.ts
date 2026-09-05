import { createHash } from 'crypto';
import { DiscordCheckinTokenService } from './discord-checkin-token.service';

/**
 * The link the bot hands out is a bearer credential in a URL, so the properties
 * that keep it safe are the ones worth pinning: it burns on use, it dies on
 * time, and issuing a new one kills the old.
 */

type Row = {
  id: string;
  tokenHash: string;
  identityId: string;
  userId: string;
  purpose: string;
  actionKey: string;
  toolName: string;
  argsJson: any;
  status: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

/** Enough of the Prisma delegate to exercise the CAS honestly. */
function makePrisma() {
  const rows: Row[] = [];
  let seq = 0;

  const matches = (row: Row, where: any): boolean => {
    if (where.id && row.id !== where.id) return false;
    if (where.tokenHash && row.tokenHash !== where.tokenHash) return false;
    if (where.userId && row.userId !== where.userId) return false;
    if (where.purpose && row.purpose !== where.purpose) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.expiresAt?.gt && !(row.expiresAt.getTime() > where.expiresAt.gt.getTime())) {
      return false;
    }
    if (where.expiresAt?.lte && !(row.expiresAt.getTime() <= where.expiresAt.lte.getTime())) {
      return false;
    }
    return true;
  };

  return {
    rows,
    discordActionToken: {
      create: async ({ data }: any) => {
        const row: Row = { id: `t${++seq}`, consumedAt: null, status: 'PENDING', ...data };
        rows.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
      updateMany: async ({ where, data }: any) => {
        const hits = rows.filter((r) => matches(r, where));
        for (const r of hits) Object.assign(r, data);
        return { count: hits.length };
      },
    },
  };
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

function makeService() {
  const prisma = makePrisma();
  const svc = new DiscordCheckinTokenService(prisma as any);
  return { svc, prisma };
}

const ISSUE = {
  identityId: 'id-1',
  userId: 'user-1',
  actionKey: 'attendance.checkin_location',
  toolName: 'attendance_check_in',
  ttlMinutes: 10,
};

describe('DiscordCheckinTokenService', () => {
  it('stores only the hash, never the token', async () => {
    const { svc, prisma } = makeService();
    const token = await svc.issue(ISSUE);

    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].tokenHash).toBe(hash(token));
    expect(JSON.stringify(prisma.rows)).not.toContain(token);
  });

  it('carries the tool name, so the browser can only supply coordinates', async () => {
    const { svc } = makeService();
    const token = await svc.issue({ ...ISSUE, args: { source: 'discord' } });

    const claim = await svc.consume(token);
    expect(claim).toMatchObject({
      ok: true,
      toolName: 'attendance_check_in',
      userId: 'user-1',
      args: { source: 'discord' },
    });
  });

  it('is single use — a second tap loses the race', async () => {
    const { svc } = makeService();
    const token = await svc.issue(ISSUE);

    expect((await svc.consume(token)).ok).toBe(true);
    expect(await svc.consume(token)).toEqual({ ok: false, reason: 'replay' });
  });

  it('refuses an expired token', async () => {
    const { svc, prisma } = makeService();
    const token = await svc.issue(ISSUE);
    prisma.rows[0].expiresAt = new Date(Date.now() - 1000);

    expect(await svc.consume(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses an unknown token', async () => {
    const { svc } = makeService();
    expect(await svc.consume('not-a-token')).toEqual({ ok: false, reason: 'unknown' });
    expect(await svc.consume('')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('kills the previous link when a new one is issued', async () => {
    // A stale link left in a channel must not still work after the employee
    // asks for another.
    const { svc } = makeService();
    const first = await svc.issue(ISSUE);
    await svc.issue(ISSUE);

    expect(await svc.consume(first)).toEqual({ ok: false, reason: 'replay' });
  });

  it('releases a claim so a geofence rejection does not burn the link', async () => {
    const { svc } = makeService();
    const token = await svc.issue(ISSUE);

    expect((await svc.consume(token)).ok).toBe(true);
    await svc.release(token);
    expect((await svc.consume(token)).ok).toBe(true);
  });

  it('will not release a token that has already expired', async () => {
    const { svc, prisma } = makeService();
    const token = await svc.issue(ISSUE);
    await svc.consume(token);
    prisma.rows[0].expiresAt = new Date(Date.now() - 1000);

    await svc.release(token);
    expect(prisma.rows[0].status).toBe('CONSUMED');
  });

  it('peek reports validity without consuming', async () => {
    const { svc } = makeService();
    const token = await svc.issue(ISSUE);

    expect(await svc.peek(token)).toEqual({ valid: true });
    expect(await svc.peek(token)).toEqual({ valid: true });
    expect(await svc.peek('nope')).toEqual({ valid: false });

    expect((await svc.consume(token)).ok).toBe(true);
    expect(await svc.peek(token)).toEqual({ valid: false });
  });

  it('sweeps links nobody opened', async () => {
    const { svc, prisma } = makeService();
    await svc.issue(ISSUE);
    prisma.rows[0].expiresAt = new Date(Date.now() - 1000);

    expect(await svc.expireStale()).toBe(1);
    expect(prisma.rows[0].status).toBe('EXPIRED');
  });
});
