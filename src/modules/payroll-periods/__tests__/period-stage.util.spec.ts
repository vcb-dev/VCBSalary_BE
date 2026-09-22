import type { PayrollPeriodStatus } from '@prisma/client';
import {
  assertPeriodInReview,
  assertPeriodOpenForDataEntry,
  assertRecordEditableInPeriod,
} from '../period-stage.util';

const ALL_STATUSES: PayrollPeriodStatus[] = [
  'DRAFT',
  'OPEN',
  'IN_REVIEW',
  'CLOSED',
];

function period(status: PayrollPeriodStatus) {
  return { status };
}

describe('period-stage.util', () => {
  describe('assertPeriodOpenForDataEntry', () => {
    it('cho phép khi kỳ đang mở', () => {
      expect(() =>
        assertPeriodOpenForDataEntry(period('OPEN'), 'gán nhóm KPI'),
      ).not.toThrow();
    });

    it.each(ALL_STATUSES.filter((status) => status !== 'OPEN'))(
      'chặn khi kỳ ở trạng thái %s',
      (status) => {
        expect(() =>
          assertPeriodOpenForDataEntry(period(status), 'gán nhóm KPI'),
        ).toThrow(/Chỉ gán nhóm KPI khi kỳ lương đang mở/);
      },
    );
  });

  describe('assertPeriodInReview', () => {
    it('cho phép khi kỳ đang duyệt', () => {
      expect(() =>
        assertPeriodInReview(period('IN_REVIEW'), 'tự xác nhận KPI'),
      ).not.toThrow();
    });

    // OPEN là giai đoạn nhập liệu — nút xác nhận/duyệt chưa được mở ở đó.
    it.each(ALL_STATUSES.filter((status) => status !== 'IN_REVIEW'))(
      'chặn khi kỳ ở trạng thái %s',
      (status) => {
        expect(() =>
          assertPeriodInReview(period(status), 'tự xác nhận KPI'),
        ).toThrow(/giai đoạn duyệt/);
      },
    );
  });

  describe('assertRecordEditableInPeriod', () => {
    it('cho phép sửa tự do khi kỳ đang mở, kể cả bản ghi chưa bị từ chối', () => {
      expect(() =>
        assertRecordEditableInPeriod(period('OPEN'), false, 'nhập actual KPI'),
      ).not.toThrow();
    });

    it('mở lại cho bản ghi Leader đã từ chối khi kỳ đang duyệt (resubmit)', () => {
      expect(() =>
        assertRecordEditableInPeriod(
          period('IN_REVIEW'),
          true,
          'nhập actual KPI',
        ),
      ).not.toThrow();
    });

    it('chặn sửa bản ghi chưa bị từ chối khi kỳ đang duyệt', () => {
      expect(() =>
        assertRecordEditableInPeriod(
          period('IN_REVIEW'),
          false,
          'nhập actual KPI',
        ),
      ).toThrow(/Leader đã từ chối/);
    });

    // Bị từ chối cũng không cứu được kỳ chưa mở hoặc đã đóng.
    it.each(['DRAFT', 'CLOSED'] as PayrollPeriodStatus[])(
      'chặn khi kỳ ở trạng thái %s dù bản ghi đã bị từ chối',
      (status) => {
        expect(() =>
          assertRecordEditableInPeriod(period(status), true, 'nhập actual KPI'),
        ).toThrow(/Chỉ nhập actual KPI khi kỳ lương đang mở/);
      },
    );
  });
});
