import { HttpStatus } from '@nestjs/common';
import type { PayrollPeriodStatus } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * Vòng đời kỳ lương (Phần 4 đặc tả) chia dữ liệu KPI/OKR thành hai giai đoạn tách bạch, và mọi
 * module ghi dữ liệu theo kỳ dùng chung 3 guard dưới đây thay vì tự kiểm tra status:
 *
 * - `OPEN` — giai đoạn nhập liệu: đồng bộ KPI, gán nhóm KPI, đặt/override target, nhập & sửa
 *   actual, tạo/sửa/xoá OKR. Chưa có thao tác xác nhận hay duyệt nào.
 * - `IN_REVIEW` — giai đoạn chốt: nhân sự sửa bản ghi còn nháp trước khi tự xác nhận; Leader
 *   điều chỉnh kết quả kèm lý do trước khi duyệt/từ chối. Bản ghi đã duyệt bị khoá.
 * - `DRAFT` — kỳ chưa mở nên chưa nhận thao tác nào; `CLOSED` — bất biến.
 */

const STATUS_LABEL: Record<PayrollPeriodStatus, string> = {
  DRAFT: 'chưa mở',
  OPEN: 'đang mở',
  IN_REVIEW: 'đang duyệt',
  CLOSED: 'đã đóng',
};

export type PeriodStageInput = { status: PayrollPeriodStatus };

function reject(period: PeriodStageInput, message: string): never {
  throw new AppException(
    ErrorCode.VALIDATION_ERROR,
    `${message} (kỳ lương ${STATUS_LABEL[period.status]}).`,
    HttpStatus.BAD_REQUEST,
  );
}

/**
 * Thao tác nhập liệu thuần — chỉ chạy khi kỳ đang mở. Dùng cho đồng bộ KPI, gán nhóm KPI và đặt
 * target, những thứ không gắn với một bản ghi có thể bị Leader từ chối.
 */
export function assertPeriodOpenForDataEntry(
  period: PeriodStageInput,
  subject: string,
): void {
  if (period.status !== 'OPEN') {
    reject(period, `Chỉ ${subject} khi kỳ lương đang mở`);
  }
}

/**
 * Sửa một bản ghi actual/OKR: mở tự do khi kỳ đang mở; khi kỳ đang duyệt chỉ mở lại cho bản ghi
 * Leader đã từ chối để nhân sự sửa rồi gửi duyệt lại.
 */
export function assertRecordEditableInPeriod(
  period: PeriodStageInput,
  isRejected: boolean,
  subject: string,
): void {
  if (period.status === 'OPEN') return;
  if (period.status === 'IN_REVIEW' && isRejected) return;
  if (period.status === 'IN_REVIEW') {
    reject(
      period,
      `Kỳ lương đang duyệt nên chỉ ${subject} với bản ghi Leader đã từ chối`,
    );
  }
  reject(period, `Chỉ ${subject} khi kỳ lương đang mở`);
}

/** Số liệu nháp và điều chỉnh của Leader được cập nhật trong cả giai đoạn duyệt. */
export function assertPeriodOpenOrInReview(
  period: PeriodStageInput,
  subject: string,
): void {
  if (period.status === 'OPEN' || period.status === 'IN_REVIEW') return;
  reject(period, `Chỉ ${subject} khi kỳ lương đang mở hoặc đang duyệt`);
}

/** Tự xác nhận và duyệt/từ chối cấp Leader — chỉ chạy khi kỳ đã chuyển sang giai đoạn duyệt. */
export function assertPeriodInReview(
  period: PeriodStageInput,
  subject: string,
): void {
  if (period.status !== 'IN_REVIEW') {
    reject(period, `Chỉ ${subject} khi kỳ lương đang ở giai đoạn duyệt`);
  }
}
