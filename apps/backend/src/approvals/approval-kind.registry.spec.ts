import { $Enums } from '@prisma/client';
import {
  APPROVAL_KINDS,
  APPROVAL_REQUEST_TYPES,
  approvalKind,
  isApprovalRequestType,
} from './approval-kind.registry';

describe('APPROVAL_KINDS registry', () => {
  /**
   * The guard that makes adding a request type safe. `RequestApproval` rows are
   * written with the Prisma enum value, but the engine resolves requesters and
   * hydrates the inbox through this registry — a value in one and not the other
   * silently strands every request of that type in an approver's queue.
   */
  it('covers exactly the Prisma ApprovalRequestType enum', () => {
    const dbValues = Object.values($Enums.ApprovalRequestType).sort();
    expect([...APPROVAL_REQUEST_TYPES].sort()).toEqual(dbValues);
  });

  it('keys every entry by its own type', () => {
    for (const [key, kind] of Object.entries(APPROVAL_KINDS)) {
      expect(kind.type).toBe(key);
    }
  });

  it('gives every kind a link and a label', () => {
    for (const kind of Object.values(APPROVAL_KINDS)) {
      expect(kind.link).toMatch(/^\/dashboard\//);
      expect(kind.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('narrows unknown strings', () => {
    expect(isApprovalRequestType('LEAVE')).toBe(true);
    expect(isApprovalRequestType('NOPE')).toBe(false);
    expect(approvalKind('NOPE')).toBeUndefined();
  });

  describe('requesterOf', () => {
    it('returns the employee id from the kind-specific delegate', async () => {
      const prisma = {
        leaveRequest: {
          findUnique: jest.fn().mockResolvedValue({ employeeId: 'emp-1' }),
        },
      } as any;

      await expect(
        APPROVAL_KINDS.LEAVE.requesterOf(prisma, 'req-1'),
      ).resolves.toBe('emp-1');
      expect(prisma.leaveRequest.findUnique).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        select: { employeeId: true },
      });
    });

    it('returns null when the request row is gone', async () => {
      const prisma = {
        overtimeRequest: { findUnique: jest.fn().mockResolvedValue(null) },
      } as any;

      await expect(
        APPROVAL_KINDS.OVERTIME.requesterOf(prisma, 'missing'),
      ).resolves.toBeNull();
    });
  });

  describe('hydrate', () => {
    it('only returns requests still awaiting a decision', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const prisma = { leaveRequest: { findMany } } as any;

      await APPROVAL_KINDS.LEAVE.hydrate(prisma, ['a', 'b']);

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['a', 'b'] }, status: 'PENDING' },
        }),
      );
    });

  });
});
