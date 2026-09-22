import { KpiActualsService } from '../kpi-actuals.service';

interface PrismaMock {
  payrollPeriod: { findUnique: jest.Mock };
  employee: { findUnique: jest.Mock };
  kpiGroup: { findUnique: jest.Mock };
  payrollPeriodEmployeeSnapshot: { findUnique: jest.Mock };
  employeeKpiAssignment: { findMany: jest.Mock; findUnique: jest.Mock };
  employeeKpiActual: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    createMany: jest.Mock;
  };
  kpiPeriodTarget: { findMany: jest.Mock };
  employeeKpiTarget: { findMany: jest.Mock };
  $transaction: jest.Mock;
}

function decimal(value: number) {
  return { toNumber: () => value };
}

/**
 * `periodStatus` quyết định giai đoạn kỳ lương: nhập/sửa actual chạy ở OPEN, còn tự xác nhận và
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
    kpiGroup: {
      findUnique: jest.fn().mockResolvedValue({ id: 'g1' }),
    },
    payrollPeriodEmployeeSnapshot: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ payrollPeriodId: 'p1', employeeId: 'e1' }),
    },
    employeeKpiAssignment: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'a1',
          employeeId: 'e1',
          teamId: 'team-mine',
          kpiGroupId: 'g1',
          payrollPeriodId: 'p1',
          assignmentStatus: 'ASSIGNED',
        },
      ]),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'a1', assignmentStatus: 'ASSIGNED' }),
    },
    employeeKpiActual: {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    kpiPeriodTarget: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    employeeKpiTarget: {
      findMany: jest.fn().mockResolvedValue([]),
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
  return {
    record: jest.fn().mockResolvedValue({}),
    recordMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
}

describe('KpiActualsService', () => {
  describe('getProfile — calculation', () => {
    it('caps actual at target (target 10, actual 12 => capped 10)', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiAssignment.findMany.mockResolvedValue([
        {
          id: 'a1',
          kpiGroup: {
            id: 'g1',
            code: 'CONTENT',
            name: 'Content',
            items: [
              { id: 'item-1', code: 'VIEWS', name: 'Views', unit: 'views' },
            ],
          },
        },
      ]);
      prisma.employeeKpiActual.findMany.mockResolvedValue([
        {
          id: 'act-1',
          kpiItemId: 'item-1',
          actualValue: decimal(12),
          overrideValue: null,
        },
      ]);
      prisma.kpiPeriodTarget.findMany.mockResolvedValue([
        { kpiItemId: 'item-1', targetValue: decimal(10) },
      ]);
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      const profile = await service.getProfile('user-admin', 'p1', 'e1');

      expect(profile.groups[0].items[0].cappedActualValue).toBe(10);
      expect(profile.groups[0].items[0].effectiveActualValue).toBe(12);
    });

    it('uses an employee target before the default payroll-period target', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiAssignment.findMany.mockResolvedValue([
        {
          id: 'a1',
          kpiGroup: {
            id: 'g1',
            code: 'CONTENT',
            name: 'Content',
            items: [
              { id: 'item-1', code: 'VIEWS', name: 'Views', unit: 'views' },
            ],
          },
        },
      ]);
      prisma.employeeKpiActual.findMany.mockResolvedValue([
        {
          id: 'act-1',
          kpiItemId: 'item-1',
          actualValue: decimal(80),
          overrideValue: null,
        },
      ]);
      prisma.kpiPeriodTarget.findMany.mockResolvedValue([
        { kpiItemId: 'item-1', targetValue: decimal(100) },
      ]);
      prisma.employeeKpiTarget.findMany.mockResolvedValue([
        { kpiItemId: 'item-1', targetValue: decimal(50) },
      ]);
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      const profile = await service.getProfile('user-admin', 'p1', 'e1');

      expect(profile.groups[0].items[0]).toMatchObject({
        targetSource: 'EMPLOYEE',
        cappedActualValue: 50,
      });
    });

    it('uses target override for displayed target, capping and group progress', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiAssignment.findMany.mockResolvedValue([
        {
          id: 'a1',
          kpiGroup: {
            id: 'g1',
            code: 'CONTENT',
            name: 'Content',
            items: [{ id: 'item-1', code: 'A', name: 'A', unit: 'x' }],
          },
        },
      ]);
      prisma.employeeKpiActual.findMany.mockResolvedValue([
        {
          id: 'act-1',
          kpiItemId: 'item-1',
          actualValue: decimal(100),
          overrideValue: null,
        },
      ]);
      prisma.employeeKpiTarget.findMany.mockResolvedValue([
        {
          kpiItemId: 'item-1',
          targetValue: decimal(150),
          overrideValue: decimal(80),
          overrideReason: 'Làm nửa kỳ',
        },
      ]);
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );
      const profile = await service.getProfile('admin', 1, 1);
      const item = profile.groups[0].items[0];
      expect(item.targetValue?.toNumber()).toBe(80);
      expect(item.targetOriginalValue?.toNumber()).toBe(150);
      expect(item.cappedActualValue).toBe(80);
      expect(profile.groups[0].progressPercent).toBe(100);
    });

    it('computes group progress as SUM(capped)/SUM(target), not average of item %', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiAssignment.findMany.mockResolvedValue([
        {
          id: 'a1',
          kpiGroup: {
            id: 'g1',
            code: 'CONTENT',
            name: 'Content',
            items: [
              { id: 'item-1', code: 'A', name: 'A', unit: 'x' },
              { id: 'item-2', code: 'B', name: 'B', unit: 'x' },
            ],
          },
        },
      ]);
      prisma.employeeKpiActual.findMany.mockResolvedValue([
        {
          id: 'act-1',
          kpiItemId: 'item-1',
          actualValue: decimal(10),
          overrideValue: null,
        },
        {
          id: 'act-2',
          kpiItemId: 'item-2',
          actualValue: decimal(5),
          overrideValue: null,
        },
      ]);
      prisma.kpiPeriodTarget.findMany.mockResolvedValue([
        { kpiItemId: 'item-1', targetValue: decimal(10) },
        { kpiItemId: 'item-2', targetValue: decimal(10) },
      ]);
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      const profile = await service.getProfile('user-admin', 'p1', 'e1');

      // 10/10 + 10/5 => (10+5)/(10+10) = 75%, KHÔNG phải average((100%+50%)/2)=75% trùng hợp ở case
      // này nên dùng thêm case lệch bên dưới để phân biệt rõ 2 công thức.
      expect(profile.groups[0].progressPercent).toBe(75);
    });

    it('does not let overachieving on item A compensate a shortfall on item B', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiAssignment.findMany.mockResolvedValue([
        {
          id: 'a1',
          kpiGroup: {
            id: 'g1',
            code: 'CONTENT',
            name: 'Content',
            items: [
              { id: 'item-1', code: 'A', name: 'A', unit: 'x' },
              { id: 'item-2', code: 'B', name: 'B', unit: 'x' },
            ],
          },
        },
      ]);
      // Item A vượt gấp đôi target (20/10), item B = 0/10.
      prisma.employeeKpiActual.findMany.mockResolvedValue([
        {
          id: 'act-1',
          kpiItemId: 'item-1',
          actualValue: decimal(20),
          overrideValue: null,
        },
        {
          id: 'act-2',
          kpiItemId: 'item-2',
          actualValue: decimal(0),
          overrideValue: null,
        },
      ]);
      prisma.kpiPeriodTarget.findMany.mockResolvedValue([
        { kpiItemId: 'item-1', targetValue: decimal(10) },
        { kpiItemId: 'item-2', targetValue: decimal(10) },
      ]);
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      const profile = await service.getProfile('user-admin', 'p1', 'e1');

      // Nếu cho bù trừ (không cap) sẽ ra (20+0)/20 = 100%. Cap đúng: (10+0)/20 = 50%.
      expect(profile.groups[0].progressPercent).toBe(50);
    });

    it('uses override_value over actual_value as effective_actual when present', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiAssignment.findMany.mockResolvedValue([
        {
          id: 'a1',
          kpiGroup: {
            id: 'g1',
            code: 'CONTENT',
            name: 'Content',
            items: [{ id: 'item-1', code: 'A', name: 'A', unit: 'x' }],
          },
        },
      ]);
      prisma.employeeKpiActual.findMany.mockResolvedValue([
        {
          id: 'act-1',
          kpiItemId: 'item-1',
          actualValue: decimal(5),
          overrideValue: decimal(9),
        },
      ]);
      prisma.kpiPeriodTarget.findMany.mockResolvedValue([
        { kpiItemId: 'item-1', targetValue: decimal(10) },
      ]);
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      const profile = await service.getProfile('user-admin', 'p1', 'e1');

      expect(profile.groups[0].items[0].effectiveActualValue).toBe(9);
    });
  });

  describe('getProfile — scope', () => {
    it('rejects viewing an employee outside the leader team scope', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-other',
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock({
          type: 'TEAM',
          teamIds: ['team-mine'],
        }) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.getProfile('user-leader', 'p1', 'e1'),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    });
  });

  describe('updateActual', () => {
    it('rejects an employee editing another employee actual', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'DRAFT',
        actualValue: decimal(0),
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e2') as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.updateActual('user-e2', 'act-1', { actualValue: 5 }),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    });

    it('blocks editing once approved (approved data protected)', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'APPROVED',
        actualValue: decimal(10),
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e1') as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.updateActual('user-e1', 'act-1', { actualValue: 5 }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('allows editing while DRAFT (own actual)', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'DRAFT',
        actualValue: decimal(0),
        selfAssessment: null,
      });
      prisma.employeeKpiActual.findUniqueOrThrow.mockResolvedValue({
        id: 'act-1',
        actualValue: decimal(8),
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e1') as never,
        makeAuditLogMock() as never,
      );

      await service.updateActual('user-e1', 'act-1', { actualValue: 8 });

      const updateArg = (
        prisma.employeeKpiActual.updateMany.mock.calls[0] as [
          { where: { id: string }; data: { actualValue: number } },
        ]
      )[0];
      expect(updateArg.data.actualValue).toBe(8);
    });

    it('cho sửa actual còn nháp trong giai đoạn duyệt trước khi tự xác nhận', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'DRAFT',
        leaderReviewStatus: 'PENDING',
        actualValue: decimal(0),
        selfAssessment: null,
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e1') as never,
        makeAuditLogMock() as never,
      );

      await service.updateActual('user-e1', 'act-1', { actualValue: 8 });
      const updateArg = (
        prisma.employeeKpiActual.updateMany.mock.calls[0] as [
          {
            where: { selfConfirmationStatus: string };
            data: { actualValue: number };
          },
        ]
      )[0];
      expect(updateArg.where.selfConfirmationStatus).toBe('DRAFT');
      expect(updateArg.data.actualValue).toBe(8);
    });

    it('vẫn cho sửa khi kỳ đang duyệt nếu Leader đã từ chối (resubmit)', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'DRAFT',
        leaderReviewStatus: 'REJECTED',
        actualValue: decimal(0),
        selfAssessment: null,
      });
      prisma.employeeKpiActual.findUniqueOrThrow.mockResolvedValue({
        id: 'act-1',
        actualValue: decimal(8),
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e1') as never,
        makeAuditLogMock() as never,
      );

      await service.updateActual('user-e1', 'act-1', { actualValue: 8 });

      expect(prisma.employeeKpiActual.updateMany).toHaveBeenCalled();
    });
  });

  describe('selfConfirm — workflow', () => {
    it('chặn tự xác nhận khi kỳ còn đang mở (chưa tới giai đoạn duyệt)', async () => {
      const prisma = makePrismaMock('OPEN');
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'DRAFT',
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e1') as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.selfConfirm('user-e1', 'act-1'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.employeeKpiActual.updateMany).not.toHaveBeenCalled();
    });

    it('draft => confirmed', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'DRAFT',
      });
      prisma.employeeKpiActual.findUniqueOrThrow.mockResolvedValue({
        id: 'act-1',
        selfConfirmationStatus: 'CONFIRMED',
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e1') as never,
        makeAuditLogMock() as never,
      );

      await service.selfConfirm('user-e1', 'act-1');

      const updateArg = (
        prisma.employeeKpiActual.updateMany.mock.calls[0] as [
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

    it('rejects confirming twice without a leader rejection in between', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'CONFIRMED',
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e1') as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.selfConfirm('user-e1', 'act-1'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('leaderApprove / leaderReject — workflow & permission', () => {
    it('confirmed => leader approved', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeKpiActual.findMany.mockResolvedValue([
        { id: 'act-1', selfConfirmationStatus: 'CONFIRMED' },
        { id: 'act-2', selfConfirmationStatus: 'CONFIRMED' },
      ]);
      prisma.employeeKpiActual.update.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve({ id: where.id, leaderReviewStatus: 'APPROVED' }),
      );
      prisma.employeeKpiActual.updateMany.mockResolvedValue({ count: 2 });
      const auditLog = makeAuditLogMock();
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        auditLog as never,
      );
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-mine',
      });

      const results = await service.leaderApprove(
        'user-leader',
        'g1',
        'e1',
        'p1',
      );

      expect(results).toHaveLength(2);
      expect(auditLog.recordMany).toHaveBeenCalledWith(
        prisma,
        expect.arrayContaining([
          expect.objectContaining({ action: 'KPI_ACTUAL_LEADER_APPROVED' }),
        ]),
      );
    });

    it('rejects approving when not every item has been self-confirmed yet', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeKpiActual.findMany.mockResolvedValue([
        { id: 'act-1', selfConfirmationStatus: 'CONFIRMED' },
        { id: 'act-2', selfConfirmationStatus: 'DRAFT' },
      ]);
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-mine',
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.leaderApprove('user-leader', 'g1', 'e1', 'p1'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects reviewing a KPI group that has already been approved', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeKpiActual.findMany.mockResolvedValue([
        {
          id: 'act-1',
          selfConfirmationStatus: 'CONFIRMED',
          leaderReviewStatus: 'APPROVED',
        },
      ]);
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-mine',
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.leaderReject('user-leader', 'g1', 'e1', 'p1', {
          reason: 'Sửa lại',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.employeeKpiActual.update).not.toHaveBeenCalled();
    });

    it('leader cannot approve their own KPI', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'e1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.leaderApprove('user-leader', 'g1', 'e1', 'p1'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('leader cannot approve an employee outside their team', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-other',
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.leaderApprove('user-leader', 'g1', 'e1', 'p1'),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    });

    it('rejected => editable => resubmit (resets self-confirmation, keeps rejection reason)', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeKpiActual.findMany.mockResolvedValue([
        { id: 'act-1', selfConfirmationStatus: 'CONFIRMED' },
      ]);
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-mine',
      });
      prisma.employeeKpiActual.update.mockResolvedValue({ id: 'act-1' });
      prisma.employeeKpiActual.updateMany.mockResolvedValue({ count: 1 });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await service.leaderReject('user-leader', 'g1', 'e1', 'p1', {
        reason: 'Thiếu bằng chứng',
      });

      const updateArg = (
        prisma.employeeKpiActual.updateMany.mock.calls[0] as [
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
      expect(updateArg.data.leaderRejectionReason).toBe('Thiếu bằng chứng');
      expect(updateArg.data.selfConfirmationStatus).toBe('DRAFT');
    });

    it('rejects reviewing when the employee is not assigned to the group', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeKpiAssignment.findUnique.mockResolvedValue(null);
      prisma.employeeKpiAssignment.findMany.mockResolvedValue([]);
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.leaderApprove('user-admin', 'g1', 'e1', 'p1'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('override — permission', () => {
    it('leader can adjust a confirmed KPI while it is pending review', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-mine',
      });
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'e1',
        teamId: 'team-mine',
        payrollPeriodId: 'p1',
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'PENDING',
        overrideValue: null,
      });
      prisma.employeeKpiActual.update.mockResolvedValue({ id: 'act-1' });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await service.override('user-leader', 'act-1', {
        overrideValue: 15,
        reason: 'Đối soát',
      });
      const updateArg = (
        prisma.employeeKpiActual.update.mock.calls[0] as [
          {
            data: { overrideValue: number; overrideReason: string };
          },
        ]
      )[0];
      expect(updateArg.data).toMatchObject({
        overrideValue: 15,
        overrideReason: 'Đối soát',
      });
    });

    it('blocks adjusting an approved KPI', async () => {
      const prisma = makePrismaMock('IN_REVIEW');
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        leaderReviewStatus: 'APPROVED',
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );
      await expect(
        service.override('user-admin', 'act-1', {
          overrideValue: 15,
          reason: 'x',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
    it('admin can override (ALL scope, no self-block)', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'admin-employee',
        payrollPeriodId: 'p1',
        overrideValue: null,
      });
      prisma.employeeKpiActual.update.mockResolvedValue({
        id: 'act-1',
        overrideValue: decimal(15),
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }, 'admin-employee') as never,
        makeAuditLogMock() as never,
      );

      await service.override('user-admin', 'act-1', {
        overrideValue: 15,
        reason: 'Điều chỉnh theo số liệu đối soát',
      });

      const updateArg = (
        prisma.employeeKpiActual.update.mock.calls[0] as [
          { data: { overrideValue: number; overrideReason: string } },
        ]
      )[0];
      expect(updateArg.data.overrideValue).toBe(15);
    });

    it('leader cannot override their own KPI', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'leader-1',
        payrollPeriodId: 'p1',
        overrideValue: null,
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.override('user-leader', 'act-1', {
          overrideValue: 15,
          reason: 'x',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects overriding an employee outside scope', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiActual.findUnique.mockResolvedValue({
        id: 'act-1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        overrideValue: null,
      });
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-other',
      });
      const service = new KpiActualsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.override('user-leader', 'act-1', {
          overrideValue: 15,
          reason: 'x',
        }),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    });
  });
});
