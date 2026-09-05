import { paginated, resolvePagination } from './pagination.util';

describe('resolvePagination', () => {
  it('defaults to page 1, limit 20', () => {
    expect(resolvePagination({})).toEqual({
      page: 1,
      limit: 20,
      skip: 0,
      take: 20,
    });
  });

  it('computes skip from page and limit', () => {
    expect(resolvePagination({ page: 3, limit: 25 })).toMatchObject({
      skip: 50,
      take: 25,
    });
  });

  it('clamps a limit that would pull the whole table', () => {
    expect(resolvePagination({ limit: 100000 }).limit).toBe(200);
  });

  it('clamps a non-positive page to the first one', () => {
    expect(resolvePagination({ page: 0 }).page).toBe(1);
    expect(resolvePagination({ page: -5 }).page).toBe(1);
  });

  it('falls back to defaults for unparseable values', () => {
    expect(
      resolvePagination({
        page: 'x' as unknown as number,
        limit: 'y' as unknown as number,
      }),
    ).toMatchObject({ page: 1, limit: 20 });
  });
});

describe('paginated', () => {
  it('rounds totalPages up', () => {
    expect(paginated([], 21, 1, 20).meta.totalPages).toBe(2);
  });

  it('reports one page when there are no rows at all', () => {
    expect(paginated([], 0, 1, 20).meta.totalPages).toBe(1);
  });
});
