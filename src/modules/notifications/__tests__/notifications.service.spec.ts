/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { NotificationsService } from '../notifications.service';

function makePrismaMock() {
  const mock = {
    notification: {
      create: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 1, isRead: true }),
    },
    employee: { findUnique: jest.fn() },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((ops: Promise<unknown>[]) =>
    Promise.all(ops),
  );
  return mock;
}

describe('NotificationsService', () => {
  it('always limits the inbox and unread count to the current recipient', async () => {
    const prisma = makePrismaMock();
    prisma.notification.findMany.mockResolvedValue([
      { id: 1, notificationType: 'KPI_REJECTED' },
    ]);
    prisma.notification.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    const service = new NotificationsService(prisma as never);

    const result = await service.list('user-1', {
      page: 1,
      pageSize: 20,
      unread: true,
    });

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { recipientUserId: 'user-1', isRead: false },
      }),
    );
    expect(prisma.notification.count).toHaveBeenLastCalledWith({
      where: { recipientUserId: 'user-1', isRead: false },
    });
    expect(result.unreadCount).toBe(1);
    expect(result.data[0]).toMatchObject({ href: '/kpi-okr' });
  });

  it('does not let a user mark another recipient notification as read', async () => {
    const prisma = makePrismaMock();
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });
    const service = new NotificationsService(prisma as never);

    await expect(service.markRead('user-other', 9)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 9, recipientUserId: 'user-other' },
      }),
    );
  });

  it('groups a batch KPI rejection into one notification for the employee', async () => {
    const prisma = makePrismaMock();
    prisma.employee.findUnique.mockResolvedValue({
      fullName: 'Nguyễn Văn A',
      user: { id: 'employee-user' },
      leader: null,
    });
    const service = new NotificationsService(prisma as never);

    await service.fromAuditEvents(prisma as never, [
      {
        actorUserId: 'leader-user',
        action: 'KPI_ACTUAL_LEADER_REJECTED',
        entityType: 'EmployeeKpiActual',
        entityId: 11,
        targetEmployeeId: 2,
        payrollPeriodId: 3,
        reason: 'Thiếu minh chứng',
      },
      {
        actorUserId: 'leader-user',
        action: 'KPI_ACTUAL_LEADER_REJECTED',
        entityType: 'EmployeeKpiActual',
        entityId: 12,
        targetEmployeeId: 2,
        payrollPeriodId: 3,
        reason: 'Thiếu minh chứng',
      },
    ]);

    const input = prisma.notification.createMany.mock.calls[0][0] as {
      data: Array<{ recipientUserId: string; notificationType: string }>;
    };
    expect(input.data).toHaveLength(1);
    expect(input.data[0]).toMatchObject({
      recipientUserId: 'employee-user',
      notificationType: 'KPI_REJECTED',
    });
  });

  it('notifies the leader when a member self-confirms traffic', async () => {
    const prisma = makePrismaMock();
    prisma.employee.findUnique.mockResolvedValue({
      fullName: 'Nguyễn Văn A',
      user: { id: 'employee-user' },
      leader: { user: { id: 'leader-user' } },
    });
    const service = new NotificationsService(prisma as never);

    await service.fromAuditEvents(prisma as never, [
      {
        actorUserId: 'employee-user',
        action: 'TRAFFIC_SELF_CONFIRMED',
        entityType: 'EmployeeTrafficRecord',
        entityId: 5,
        targetEmployeeId: 2,
        payrollPeriodId: 3,
      },
    ]);

    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          recipientUserId: 'leader-user',
          notificationType: 'TRAFFIC_WAITING_REVIEW',
        }),
      ],
    });
  });

  it('notifies the employee when their salary is approved and locked', async () => {
    const prisma = makePrismaMock();
    prisma.employee.findUnique.mockResolvedValue({
      fullName: 'Nguyễn Văn A',
      user: { id: 'employee-user' },
      leader: null,
    });
    const service = new NotificationsService(prisma as never);

    await service.fromAuditEvents(prisma as never, [
      {
        actorUserId: 'manager-user',
        action: 'SALARY_LOCKED',
        entityType: 'SalaryRecord',
        entityId: 30,
        targetEmployeeId: 2,
        payrollPeriodId: 3,
      },
    ]);

    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          recipientUserId: 'employee-user',
          notificationType: 'SALARY_LOCKED',
          referenceEntityId: '30',
        }),
      ],
    });
  });

  it('notifies salary approvers when a revision is created', async () => {
    const prisma = makePrismaMock();
    prisma.user.findMany.mockResolvedValue([
      { id: 'manager-user' },
      { id: 'admin-user' },
    ]);
    const service = new NotificationsService(prisma as never);

    await service.fromAuditEvents(prisma as never, [
      {
        actorUserId: 'admin-user',
        action: 'SALARY_REVISION_CREATED',
        entityType: 'SalaryRecord',
        entityId: 31,
        targetEmployeeId: 2,
        payrollPeriodId: 3,
        afterData: { status: 'PENDING', versionNumber: 2 },
      },
    ]);

    const input = prisma.notification.createMany.mock.calls[0][0] as {
      data: Array<{ recipientUserId: string; notificationType: string }>;
    };
    expect(input.data).toHaveLength(2);
    expect(input.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientUserId: 'manager-user',
          notificationType: 'SALARY_WAITING_APPROVAL',
        }),
        expect.objectContaining({
          recipientUserId: 'admin-user',
          notificationType: 'SALARY_WAITING_APPROVAL',
        }),
      ]),
    );
  });

  it('sends one summarized notification per approver for a salary batch', async () => {
    const prisma = makePrismaMock();
    prisma.user.findMany.mockResolvedValue([{ id: 'manager-user' }]);
    const service = new NotificationsService(prisma as never);

    await service.fromAuditEvents(prisma as never, [
      {
        actorUserId: 'accountant-user',
        action: 'SALARY_BATCH_CALCULATED',
        entityType: 'PayrollPeriod',
        entityId: 3,
        payrollPeriodId: 3,
        afterData: { status: 'PENDING', count: 42 },
      },
    ]);

    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          recipientUserId: 'manager-user',
          notificationType: 'SALARY_WAITING_APPROVAL',
          message: '42 bản lương đã sẵn sàng để kiểm tra và duyệt cuối cùng.',
        }),
      ],
    });
  });
});
