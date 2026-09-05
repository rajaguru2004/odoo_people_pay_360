import { BadRequestException } from '@nestjs/common';
import { TeamsService } from './teams.service';
import { PrismaService } from '../prisma/prisma.service';

const prismaMock = () => ({
  team: { findUnique: jest.fn(), delete: jest.fn() },
  employee: { findUnique: jest.fn() },
  teamMember: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
});

type PrismaMock = ReturnType<typeof prismaMock>;

/** The first argument a mocked Prisma call received, typed for the assertion. */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as T[][])[0][0];
}

/** Midnight UTC `days` from today — the shape a `@db.Date` column comes back in. */
function utcDaysFromToday(days: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days),
  );
}

describe('TeamsService', () => {
  let prisma: PrismaMock;
  let service: TeamsService;

  beforeEach(() => {
    prisma = prismaMock();
    service = new TeamsService(prisma as unknown as PrismaService);
  });

  describe('addMember', () => {
    it('reopens the existing membership instead of adding a second one', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 'team-1' });
      prisma.employee.findUnique.mockResolvedValue({ id: 'employee-1' });
      prisma.teamMember.upsert.mockResolvedValue({
        id: 'member-1',
        isActive: true,
      });

      await service.addMember('team-1', {
        employeeId: 'employee-1',
        role: 'LEAD',
        allocation: 50,
      });

      expect(prisma.teamMember.create).not.toHaveBeenCalled();

      const upsert = firstArg<{
        where: Record<string, unknown>;
        update: Record<string, unknown>;
      }>(prisma.teamMember.upsert);
      expect(upsert.where).toEqual({
        teamId_employeeId: { teamId: 'team-1', employeeId: 'employee-1' },
      });
      expect(upsert.update).toMatchObject({
        isActive: true,
        endDate: null,
        role: 'LEAD',
        allocation: 50,
      });
    });

    it('leaves an unstated role and allocation to the existing row', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 'team-1' });
      prisma.employee.findUnique.mockResolvedValue({ id: 'employee-1' });
      prisma.teamMember.upsert.mockResolvedValue({ id: 'member-1' });

      await service.addMember('team-1', { employeeId: 'employee-1' });

      const upsert = firstArg<{ update: Record<string, unknown> }>(
        prisma.teamMember.upsert,
      );
      expect(upsert.update).not.toHaveProperty('role');
      expect(upsert.update).not.toHaveProperty('allocation');
    });
  });

  describe('removeMember', () => {
    it('closes off a membership that has already run', async () => {
      prisma.teamMember.findUnique.mockResolvedValue({
        id: 'member-1',
        teamId: 'team-1',
        startDate: utcDaysFromToday(-40),
      });
      prisma.teamMember.update.mockResolvedValue({});

      const result = await service.removeMember('team-1', 'member-1');

      expect(prisma.teamMember.delete).not.toHaveBeenCalled();
      const closed = firstArg<{
        where: { id: string };
        data: Record<string, unknown>;
      }>(prisma.teamMember.update);
      expect(closed.where).toEqual({ id: 'member-1' });
      expect(closed.data).toMatchObject({ isActive: false });
      expect(result).toEqual({ removed: true, retained: true });
    });

    it('deletes one added today, which produced no history', async () => {
      prisma.teamMember.findUnique.mockResolvedValue({
        id: 'member-1',
        teamId: 'team-1',
        startDate: utcDaysFromToday(0),
      });
      prisma.teamMember.delete.mockResolvedValue({});

      const result = await service.removeMember('team-1', 'member-1');

      expect(prisma.teamMember.update).not.toHaveBeenCalled();
      expect(prisma.teamMember.delete).toHaveBeenCalledWith({
        where: { id: 'member-1' },
      });
      expect(result).toEqual({ removed: true, retained: false });
    });
  });

  describe('remove', () => {
    it('refuses while anyone is still on the roster, and says how many', async () => {
      prisma.team.findUnique.mockResolvedValue({
        id: 'team-1',
        code: 'PAY-CORE',
        _count: { members: 3 },
      });

      await expect(service.remove('team-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.remove('team-1')).rejects.toThrow(/3 member/);

      expect(prisma.team.delete).not.toHaveBeenCalled();
    });
  });
});
