import { EmployeeOkrsService } from '../employee-okrs.service';

interface PrismaMock {
  payrollPeriod: { findUnique: jest.Mock };
  employee: { findUnique: jest.Mock };
  payrollPeriodEmployeeSnapshot: { findUnique: jest.Mock };
  employeeOkr: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
  };
  $transaction: jest.Mock;
}

function decimal(value: number) {
  return { toNumber: () => value };
}

/**
 * `periodStatus` quyết định giai đoạn kỳ lương: tạo/sửa/xoá OKR chạy ở OPEN, còn tự xác nhận và
 * duyệt cấp Leader chỉ chạy ở IN_REVIEW (xem `period-stage.util.ts`).
 */
function makePrismaMock(
  periodStatus: 'OPEN' | 'IN_REVIEW' = 'OPEN',
): PrismaMock {
  const mock: PrismaMock = {
    payrollPeriod: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'p1', status: periodStatus }),
    },
    employee: {
      findUnique: jest.fn().mockResolvedValue({ id: 'e1' }),
    },
    payrollPeriodEmployeeSnapshot: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ payrollPeriodId: 'p1', employeeId: 'e1' }),
    },
    employeeOkr: {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: PrismaMock) => unknown)(mock);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
  return mock;
}

function makeAuthorizationMock(
  scope:
    | { type: 'ALL' }
    | { type: 'TEAM'; teamIds: string[] }
    | { type: 'SELF' }
    | { type: 'NONE' } = { type: 'ALL' },
  employeeId: string | null = null,
) {
  return {
    resolveScope: jest.fn().mockResolvedValue(scope),
    resolvePermissionScope: jest.fn().mockResolvedValue(scope),
    getEmployeeId: jest.fn().mockResolvedValue(employeeId),
  };
}

function makeAuditLogMock() {
  return { record: jest.fn().mockResolvedValue({}) };
}

describe('EmployeeOkrsService', () => {
  describe('listForEmployee — progress calculation', () => {
    it('caps progress at 100% (target 10, actual 12)', async () => {
      const prisma = makePrismaMock();
      prisma.employeeOkr.findMany.mockResolvedValue([
        { id: 'o1', targetValue: decimal(10), actualValue: decimal(12) },
      ]);
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      const result = await service.listForEmployee('user-admin', 'p1', 'e1');

      expect(result[0].progressPercent).toBe(100);
    });

    it('computes progress = actual/target * 100 when under target', async () => {
      const prisma = makePrismaMock();
      prisma.employeeOkr.findMany.mockResolvedValue([
        { id: 'o1', targetValue: decimal(10), actualValue: decimal(5) },
      ]);
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      const result = await service.listForEmployee('user-admin', 'p1', 'e1');

      expect(result[0].progressPercent).toBe(50);
    });

    it('rejects viewing an employee outside the leader team scope', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-other',
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({
          type: 'TEAM',
          teamIds: ['team-mine'],
        }) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.listForEmployee('user-leader', 'p1', 'e1'),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    });
  });

  describe('create', () => {
    it('rejects when the period is already CLOSED', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'CLOSED',
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-admin', 'p1', 'e1', {
          title: 'x',
          targetValue: 10,
          rewardAmount: 100,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects an employee without a snapshot in this period', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue(null);
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-admin', 'p1', 'e1', {
          title: 'x',
          targetValue: 10,
          rewardAmount: 100,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('creates the OKR and records an audit entry', async () => {
      const prisma = makePrismaMock();
      prisma.employeeOkr.create.mockResolvedValue({
        id: 'o1',
        targetValue: decimal(10),
        actualValue: decimal(0),
      });
      const auditLog = makeAuditLogMock();
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock() as never,
        auditLog as never,
      );

      await service.create('user-admin', 'p1', 'e1', {
        title: 'Tăng view kênh',
        targetValue: 10,
        rewardAmount: 500000,
      });

      const createArg = (
        prisma.employeeOkr.create.mock.calls[0] as [
          { data: { employeeId: string; title: string } },
        ]
      )[0];
      expect(createArg.data.employeeId).toBe('e1');
      expect(createArg.data.title).toBe('Tăng view kênh');
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'OKR_CREATED' }),
      );
    });
  });

  describe('update', () => {
    it('allows editing a draft OKR during review before self-confirmation', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'DRAFT',
        leaderReviewStatus: 'PENDING',
        actualValue: decimal(2),
        selfAssessment: null,
      });
      prisma.employeeOkr.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        targetValue: decimal(10),
        actualValue: decimal(8),
        overrideValue: null,
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e1') as never,
        makeAuditLogMock() as never,
      );

      await service.update('user-e1', 'o1', { actualValue: 8 });
      const updateArg = (
        prisma.employeeOkr.updateMany.mock.calls[0] as [
          {
            data: { actualValue: number; overrideValue: number | null };
          },
        ]
      )[0];
      expect(updateArg.data).toMatchObject({
        actualValue: 8,
        overrideValue: null,
      });
    });

    it('rejects an employee editing another employee OKR', async () => {
      const prisma = makePrismaMock();
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'DRAFT',
        actualValue: decimal(0),
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e2') as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.update('user-e2', 'o1', { actualValue: 5 }),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    });

    it('blocks editing once approved (approved data protected)', async () => {
      const prisma = makePrismaMock();
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'APPROVED',
        actualValue: decimal(10),
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e1') as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.update('user-e1', 'o1', { actualValue: 5 }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('remove — xóa OKR tạo nhầm', () => {
    it('rejects deleting once already confirmed/approved (only DRAFT deletable)', async () => {
      const prisma = makePrismaMock();
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'CONFIRMED',
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }) as never,
        makeAuditLogMock() as never,
      );

      await expect(service.remove('user-admin', 'o1')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(prisma.employeeOkr.delete).not.toHaveBeenCalled();
    });

    it('rejects a leader deleting an OKR outside their team scope', async () => {
      const prisma = makePrismaMock();
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'DRAFT',
      });
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-other',
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({
          type: 'TEAM',
          teamIds: ['team-mine'],
        }) as never,
        makeAuditLogMock() as never,
      );

      await expect(service.remove('user-leader', 'o1')).rejects.toMatchObject({
        code: 'OUT_OF_SCOPE',
      });
      expect(prisma.employeeOkr.delete).not.toHaveBeenCalled();
    });

    it('deletes the OKR and records an audit entry when DRAFT and in scope', async () => {
      const prisma = makePrismaMock();
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        title: 'OKR tạo nhầm',
        selfConfirmationStatus: 'DRAFT',
        targetValue: decimal(10),
        rewardAmount: decimal(200000),
      });
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-mine',
      });
      const auditLog = makeAuditLogMock();
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({
          type: 'TEAM',
          teamIds: ['team-mine'],
        }) as never,
        auditLog as never,
      );

      await service.remove('user-leader', 'o1');

      const deleteArg = prisma.employeeOkr.deleteMany.mock.calls[0] as [
        { where: { id: string } },
      ];
      expect(deleteArg[0].where.id).toBe('o1');
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'OKR_DELETED', entityId: 'o1' }),
      );
    });
  });

  describe('selfConfirm', () => {
    it('draft => confirmed', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'DRAFT',
      });
      prisma.employeeOkr.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        selfConfirmationStatus: 'CONFIRMED',
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e1') as never,
        makeAuditLogMock() as never,
      );

      await service.selfConfirm('user-e1', 'o1');

      const updateArg = (
        prisma.employeeOkr.updateMany.mock.calls[0] as [
          {
            data: {
              selfConfirmationStatus: string;
              leaderReviewStatus: string;
            };
          },
        ]
      )[0];
      expect(updateArg.data.selfConfirmationStatus).toBe('CONFIRMED');
      expect(updateArg.data.leaderReviewStatus).toBe('PENDING');
    });
  });

  describe('leaderApprove / leaderReject — permission & workflow', () => {
    it('rejects approving before self-confirmation', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'DRAFT',
      });
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-mine',
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.leaderApprove('user-leader', 'o1'),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('leader cannot approve their own OKR', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'leader-1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'CONFIRMED',
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.leaderApprove('user-leader', 'o1'),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('admin can approve (ALL scope, no self-block) when confirmed', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'admin-employee',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'PENDING',
      });
      prisma.employeeOkr.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        leaderReviewStatus: 'APPROVED',
      });
      const auditLog = makeAuditLogMock();
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }, 'admin-employee') as never,
        auditLog as never,
      );

      await service.leaderApprove('user-admin', 'o1');

      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'OKR_LEADER_APPROVED' }),
      );
    });

    it('rejects reviewing an OKR that has already been approved', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'APPROVED',
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.leaderReject('user-admin', 'o1', { reason: 'Sửa lại' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.employeeOkr.update).not.toHaveBeenCalled();
    });

    it('rejected => editable => resubmit (resets self-confirmation, keeps rejection reason)', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'PENDING',
      });
      prisma.employeeOkr.findUniqueOrThrow.mockResolvedValue({ id: 'o1' });
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-mine',
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await service.leaderReject('user-leader', 'o1', {
        reason: 'Chưa đủ minh chứng',
      });

      const updateArg = (
        prisma.employeeOkr.updateMany.mock.calls[0] as [
          {
            data: {
              leaderReviewStatus: string;
              leaderRejectionReason: string;
              selfConfirmationStatus: string;
            };
          },
        ]
      )[0];
      expect(updateArg.data.leaderReviewStatus).toBe('REJECTED');
      expect(updateArg.data.leaderRejectionReason).toBe('Chưa đủ minh chứng');
      expect(updateArg.data.selfConfirmationStatus).toBe('DRAFT');
    });
  });

  describe('leader override', () => {
    it('keeps the employee value and uses the adjusted value for progress', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'PENDING',
        actualValue: decimal(4),
        overrideValue: null,
      });
      prisma.employeeOkr.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        targetValue: decimal(10),
        actualValue: decimal(4),
        overrideValue: decimal(8),
      });
      const auditLog = makeAuditLogMock();
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }) as never,
        auditLog as never,
      );

      const result = await service.override('user-admin', 'o1', {
        overrideValue: 8,
        reason: 'Đối soát',
      });
      expect(result.progressPercent).toBe(80);
      const updateArg = (
        prisma.employeeOkr.updateMany.mock.calls[0] as [
          {
            where: {
              selfConfirmationStatus: string;
              leaderReviewStatus: string;
            };
            data: { overrideValue: number; overrideReason: string };
          },
        ]
      )[0];
      expect(updateArg.where).toMatchObject({
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'PENDING',
      });
      expect(updateArg.data).toMatchObject({
        overrideValue: 8,
        overrideReason: 'Đối soát',
      });
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          action: 'OKR_ACTUAL_OVERRIDE',
          reason: 'Đối soát',
        }),
      );
    });

    it('blocks adjusting an approved OKR', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeOkr.findUnique.mockResolvedValue({
        id: 'o1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'APPROVED',
      });
      const service = new EmployeeOkrsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }) as never,
        makeAuditLogMock() as never,
      );
      await expect(
        service.override('user-admin', 'o1', { overrideValue: 8, reason: 'x' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });
});
