export const APP_TIMEZONE = 'Asia/Ho_Chi_Minh';

export function formatDateTimeVN(date: Date): string {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: APP_TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

/**
 * Ngày nghiệp vụ hiện tại theo giờ VN, trả về Date ở 00:00 UTC — đúng cách Prisma map cột
 * `@db.Date`. Các khoảng hiệu lực so sánh theo NGÀY, nếu dùng thẳng `new Date()` thì server chạy
 * giờ UTC sẽ lệch một ngày trong khung 00:00–07:00 giờ VN.
 */
export function currentBusinessDate(now: Date = new Date()): Date {
  // en-CA cho định dạng YYYY-MM-DD.
  const isoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/** Cộng/trừ ngày trên trục UTC, dùng cho các cột ngày nghiệp vụ (`@db.Date`). */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}
