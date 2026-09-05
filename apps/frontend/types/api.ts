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
   * anything else the endpoint attached — some routes return a full pre-flight
   * report alongside their message so the screen can refresh without a second
   * round trip. Keep the original here so nothing is lost.
   */
  details?: any;
}
