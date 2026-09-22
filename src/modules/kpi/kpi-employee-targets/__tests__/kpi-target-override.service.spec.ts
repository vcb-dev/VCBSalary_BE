import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  OverrideEmployeeKpiTargetDto,
  PutEmployeeKpiTargetDto,
} from '../dto/employee-kpi-target.dto';
import { EmployeeKpiTargetsService } from '../kpi-employee-targets.service';

function setup(
  scope: { type: 'ALL' | 'SELF' } | { type: 'TEAM'; teamIds: number[] } = {
    type: 'ALL',
  },
) {
  const prisma = {
    payrollPeriod: {
      findUnique: jest.fn().mockResolvedValue({ id: 1, status: 'OPEN' }),
    },
    payrollPeriodEmployeeSnapshot: {
      findUnique: jest.fn().mockResolvedValue({
        employeeId: 2,
        payrollPeriodId: 1,
        teamIdSnapshot: 3,
      }),
    },
    kpiItem: {
      findUnique: jest.fn().mockResolvedValue({ id: 4, kpiGroupId: 5 }),
    },
    employeeKpiAssignment: {
      findUnique: jest.fn().mockResolvedValue({ assignmentStatus: 'ASSIGNED' }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ teamId: 3, assignmentStatus: 'ASSIGNED' }]),
    },
    employeeKpiTarget: {
      findUnique: jest.fn().mockResolvedValue({
        id: 42,
        targetValue: new Prisma.Decimal(150),
        overrideValue: null,
        dataSource: 'AUTOMATION_GEN_VIDEO',
      }),
      upsert: jest.fn().mockResolvedValue({ id: 42 }),
      update: jest.fn().mockResolvedValue({ id: 42 }),
    },
    kpiPeriodTarget: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
  );
  const audit = { record: jest.fn().mockResolvedValue({}) };
  const service = new EmployeeKpiTargetsService(
    prisma as never,
    {
      resolveScope: jest.fn().mockResolvedValue(scope),
      resolvePermissionScope: jest.fn().mockResolvedValue(scope),
    } as never,
    audit as never,
  );
  return { prisma, audit, service };
}

describe('Điều chỉnh mục tiêu KPI', () => {
  it('cho phép điều chỉnh target đồng bộ, không ghi đè target gốc hoặc dataSource', async () => {
    const { prisma, audit, service } = setup();
    await service.overrideTarget('admin', 1, 2, 4, {
      overrideValue: 80,
      reason: 'Điều chỉnh theo ngày làm việc',
    });
    const calls = prisma.employeeKpiTarget.upsert.mock.calls as [
      { update: Record<string, unknown> },
    ][];
    expect(calls[0][0].update.overrideValue).toBe(80);
    expect(calls[0][0].update).not.toHaveProperty('targetValue');
    expect(calls[0][0].update).not.toHaveProperty('dataSource');
    const audits = audit.record.mock.calls as [
      unknown,
      { action: string; reason: string },
    ][];
    expect(audits[0][1].action).toBe('KPI_TARGET_OVERRIDE');
    expect(audits[0][1].reason).toBe('Điều chỉnh theo ngày làm việc');
  });

  it('tạo target riêng khi điều chỉnh mục tiêu mặc định của kỳ, không sửa mục tiêu chung', async () => {
    const { prisma, service } = setup();
    prisma.employeeKpiTarget.findUnique.mockResolvedValue(null);
    prisma.kpiPeriodTarget.findUnique.mockResolvedValue({
      targetValue: new Prisma.Decimal(120),
    });
    await service.overrideTarget('admin', 1, 2, 4, {
      overrideValue: 60,
      reason: 'Làm nửa tháng',
    });
    const calls = prisma.employeeKpiTarget.upsert.mock.calls as [
      {
        create: {
          employeeId: number;
          targetValue: Prisma.Decimal;
          overrideValue: number;
        };
      },
    ][];
    expect(calls[0][0].create.employeeId).toBe(2);
    expect(calls[0][0].create.targetValue.toNumber()).toBe(120);
    expect(calls[0][0].create.overrideValue).toBe(60);
  });

  it('yêu cầu nhập mục tiêu trước nếu chưa có mục tiêu gốc', async () => {
    const { prisma, service } = setup();
    prisma.employeeKpiTarget.findUnique.mockResolvedValue(null);
    await expect(
      service.overrideTarget('admin', 1, 2, 4, {
        overrideValue: 60,
        reason: 'Lý do',
      }),
    ).rejects.toThrow('Chưa có mục tiêu gốc');
    expect(prisma.employeeKpiTarget.upsert).not.toHaveBeenCalled();
  });

  it('chặn scope SELF', async () => {
    const { prisma, service } = setup({ type: 'SELF' });
    await expect(
      service.overrideTarget('employee', 1, 2, 4, {
        overrideValue: 60,
        reason: 'Lý do',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.employeeKpiTarget.upsert).not.toHaveBeenCalled();
  });

  it('chặn nhân sự ngoài team của Leader', async () => {
    const { service } = setup({ type: 'TEAM', teamIds: [99] });
    await expect(
      service.overrideTarget('leader', 1, 2, 4, {
        overrideValue: 60,
        reason: 'Lý do',
      }),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
  });

  it('chặn thay đổi khi kỳ đã CLOSED', async () => {
    const { prisma, service } = setup();
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 1,
      status: 'CLOSED',
    });
    await expect(
      service.overrideTarget('admin', 1, 2, 4, {
        overrideValue: 60,
        reason: 'Lý do',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.clearOverride('admin', 1, 2, 4)).rejects.toMatchObject(
      { code: 'VALIDATION_ERROR' },
    );
  });

  it('bỏ điều chỉnh về mục tiêu gốc và ghi audit', async () => {
    const { prisma, audit, service } = setup();
    prisma.employeeKpiTarget.findUnique.mockResolvedValue({
      id: 42,
      targetValue: new Prisma.Decimal(150),
      overrideValue: new Prisma.Decimal(0),
    });
    await service.clearOverride('admin', 1, 2, 4);
    const calls = prisma.employeeKpiTarget.update.mock.calls as [
      { data: Record<string, unknown> },
    ][];
    expect(calls[0][0].data.overrideValue).toBeNull();
    expect(calls[0][0].data).not.toHaveProperty('targetValue');
    const audits = audit.record.mock.calls as [unknown, { action: string }][];
    expect(audits[0][1].action).toBe('KPI_TARGET_OVERRIDE_CLEARED');
  });

  it('không bỏ điều chỉnh khi chưa có override', async () => {
    const { prisma, service } = setup();
    await expect(service.clearOverride('admin', 1, 2, 4)).rejects.toThrow(
      'chưa có giá trị điều chỉnh',
    );
    expect(prisma.employeeKpiTarget.update).not.toHaveBeenCalled();
  });
});

describe('Validation mục tiêu KPI', () => {
  it('cho phép mục tiêu điều chỉnh bằng 0', async () => {
    const dto = plainToInstance(OverrideEmployeeKpiTargetDto, {
      overrideValue: 0,
      reason: 'Không áp dụng kỳ này',
    });
    expect(await validate(dto)).toHaveLength(0);
  });
  it('chặn số âm', async () => {
    const dto = plainToInstance(OverrideEmployeeKpiTargetDto, {
      overrideValue: -1,
      reason: 'Lý do',
    });
    expect((await validate(dto)).map((error) => error.property)).toContain(
      'overrideValue',
    );
  });
  it('chặn lý do trống hoặc chỉ có khoảng trắng', async () => {
    const dto = plainToInstance(OverrideEmployeeKpiTargetDto, {
      overrideValue: 80,
      reason: '   ',
    });
    expect((await validate(dto)).map((error) => error.property)).toContain(
      'reason',
    );
  });
  it('cho phép nhập tay mục tiêu 0 khi nguồn thiếu', async () => {
    expect(
      await validate(
        plainToInstance(PutEmployeeKpiTargetDto, { targetValue: 0 }),
      ),
    ).toHaveLength(0);
  });
});
