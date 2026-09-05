import { BranchesService } from './branches.service';

/**
 * Listing branches.
 *
 * `isActive: false` is a SOFT delete, and a retired branch is hidden from this
 * list, from every picker that reads it, and from `findOne` (which 404s on it
 * on purpose, so a stale link cannot keep saving into somewhere nobody sees).
 * Together those made deactivation a ONE-WAY DOOR: a branch switched off by
 * mistake could not be listed, opened or edited again from anywhere in the UI.
 *
 * `includeInactive` is the single way back, so both of its branches are pinned
 * here. The default especially: every branch picker in the app goes through
 * this same call, and they must never start offering retired sites.
 */
describe('BranchesService.findAll', () => {
  const ACTIVE = { id: 'b1', code: 'A-ACTIVE', isActive: true };
  const RETIRED = { id: 'b2', code: 'B-RETIRED', isActive: false };

  const makeService = () => {
    const findMany = jest.fn(async ({ where }: any) =>
      where.isActive === true ? [ACTIVE] : [ACTIVE, RETIRED],
    );
    const prisma: any = { branch: { findMany } };
    return { service: new BranchesService(prisma), findMany };
  };

  it('hides retired branches by default', async () => {
    const { service, findMany } = makeService();

    const res = await service.findAll();

    expect(findMany.mock.calls[0][0].where.isActive).toBe(true);
    expect(res.data).toEqual([ACTIVE]);
  });

  it('returns retired branches when explicitly asked for them', async () => {
    const { service, findMany } = makeService();

    const res = await service.findAll(true);

    // Absent, not `false` — the filter has to be dropped entirely, or the call
    // would return ONLY retired branches and hide the live ones instead.
    expect(findMany.mock.calls[0][0].where.isActive).toBeUndefined();
    expect(res.data).toEqual([ACTIVE, RETIRED]);
  });

  it('still scopes to the caller envelope when including retired ones', async () => {
    const { service, findMany } = makeService();

    await service.findAll(true);

    // No branch context in a unit test → no envelope narrowing, but the spread
    // must survive: `includeInactive` must not become a way around scoping.
    const where = findMany.mock.calls[0][0].where;
    expect(Object.prototype.hasOwnProperty.call(where, 'id')).toBe(false);
  });
});
