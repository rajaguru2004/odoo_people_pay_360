export interface PaginationQuery {
  page?: number;
  limit?: number;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Clamped so a caller cannot ask for `limit=100000` and pull the whole table. */
export function resolvePagination(q: PaginationQuery) {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 20));
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function paginated<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
) {
  const meta: PaginationMeta = {
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
  return { success: true as const, data, meta };
}
