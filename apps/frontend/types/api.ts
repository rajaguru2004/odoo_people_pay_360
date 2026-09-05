// API Response Types — mirrors the backend's TransformInterceptor envelope.
export interface ApiResponse<T = any> {
  success: boolean;
  data: T;
  message?: string;
  meta?: PaginationMeta;
  errors?: any;
}

export interface PaginationMeta {
  total: number;
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
   * The axios interceptor flattens an error into the fields above, which
   * silently drops anything else the endpoint attached. Keeping the original
   * here means an endpoint that returns a structured report alongside its
   * message loses nothing on the way to the screen.
   */
  details?: any;
}
