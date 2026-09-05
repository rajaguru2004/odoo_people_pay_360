// API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  data: T;
  message?: string;
  meta?: PaginationMeta;
  errors?: any;
}

export interface PaginationMeta {
  total: number;
  totalUnfiltered?: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ApiError {
  success: false;
  statusCode: number;
  message: string;
  errors?: any;
  timestamp: string;
  path: string;
  /**
   * The untouched response body.
   *
   * The interceptor flattens an error into the fields above, which silently drops
   * anything else the endpoint attached — a route that answers with a per-row
   * report alongside its message lets the screen re-render it without a second
   * round trip. Keep the original here so nothing is lost.
   */
  details?: any;
}
