/**
 * Phạm vi dữ liệu đã phân giải từ các role của user (AuthorizationService tạo ra); các module
 * dùng nó để lọc dữ liệu được phép xem/ghi.
 */
export type ResolvedScope =
  | { type: 'NONE' }
  | { type: 'SELF' }
  | { type: 'TEAM'; teamIds: number[] }
  | { type: 'ALL' };
