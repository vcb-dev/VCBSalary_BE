import { AuditLogService } from '../audit-log.service';

function makeDbMock() {
  return {
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        employeeId: null,
        employee: null,
      }),
    },
    employee: { findUnique: jest.fn().mockResolvedValue(null) },
    payrollPeriodEmployeeSnapshot: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

function makeNotificationsMock() {
  return { fromAuditEvents: jest.fn().mockResolvedValue({ count: 0 }) };
}

describe('AuditLogService', () => {
  it('forwards the input straight to auditLog.create on the given db/tx client', async () => {
    const db = makeDbMock();
    const service = new AuditLogService(makeNotificationsMock() as never);

    await service.record(db as never, {
      actorUserId: 'user-1',
      action: 'PAYROLL_PERIOD_OPENED',
      entityType: 'PayrollPeriod',
      entityId: 'p1',
      payrollPeriodId: 'p1',
      beforeData: { status: 'DRAFT' },
      afterData: { status: 'OPEN' },
    });

    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: 'user-1',
        action: 'PAYROLL_PERIOD_OPENED',
        entityType: 'PayrollPeriod',
        entityId: 'p1',
        targetEmployeeId: undefined,
        payrollPeriodId: 'p1',
        actorTeamIdSnapshot: null,
        targetTeamIdSnapshot: null,
        beforeData: { status: 'DRAFT' },
        afterData: { status: 'OPEN' },
        reason: undefined,
      },
    });
  });

  it('does not persist KPI events outside the audit policy', async () => {
    const db = makeDbMock();
    const notifications = { fromAuditEvents: jest.fn().mockResolvedValue(1) };
    const service = new AuditLogService(notifications as never);

    const result = await service.record(db as never, {
      actorUserId: 'user-1',
      action: 'KPI_ACTUAL_UPDATED',
      entityType: 'EmployeeKpiActual',
      entityId: 14,
      targetEmployeeId: 7,
    });

    expect(result).toBeNull();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(notifications.fromAuditEvents).toHaveBeenCalledWith(db, [
      expect.objectContaining({ action: 'KPI_ACTUAL_UPDATED' }),
    ]);
  });

  it('only persists allowed events in a batch while notifying from all events', async () => {
    const db = makeDbMock();
    db.auditLog.createMany.mockResolvedValue({ count: 1 });
    const notifications = { fromAuditEvents: jest.fn().mockResolvedValue(1) };
    const service = new AuditLogService(notifications as never);
    const inputs = [
      {
        actorUserId: 'user-1',
        action: 'TRAFFIC_UPDATED',
        entityType: 'EmployeeTrafficRecord',
        entityId: 1,
      },
      {
        actorUserId: 'user-1',
        action: 'OKR_UPDATED',
        entityType: 'EmployeeOkr',
        entityId: 2,
      },
    ];

    await service.recordMany(db as never, inputs);

    expect(db.auditLog.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ action: 'TRAFFIC_UPDATED' })],
    });
    expect(notifications.fromAuditEvents).toHaveBeenCalledWith(db, inputs);
  });

  it('reuses team snapshots for audit events with the same actor, target and period', async () => {
    const db = makeDbMock();
    db.user.findUnique.mockResolvedValue({
      employeeId: 5,
      employee: { teamId: 8 },
    });
    db.employee.findUnique.mockResolvedValue({ teamId: 9 });
    db.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
      teamIdSnapshot: 10,
    });
    const service = new AuditLogService(makeNotificationsMock() as never);
    const common = {
      actorUserId: 'manager-1',
      entityType: 'SalaryRecord',
      entityId: 30,
      targetEmployeeId: 7,
      payrollPeriodId: 2,
    };

    await service.recordMany(db as never, [
      { ...common, action: 'SALARY_APPROVED' },
      { ...common, action: 'SALARY_LOCKED' },
    ]);

    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
    expect(db.employee.findUnique).toHaveBeenCalledTimes(1);
    expect(db.payrollPeriodEmployeeSnapshot.findUnique).toHaveBeenCalledTimes(
      2,
    );
    expect(db.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          action: 'SALARY_APPROVED',
          actorTeamIdSnapshot: 10,
          targetTeamIdSnapshot: 10,
        }),
        expect.objectContaining({
          action: 'SALARY_LOCKED',
          actorTeamIdSnapshot: 10,
          targetTeamIdSnapshot: 10,
        }),
      ],
    });
  });
});
