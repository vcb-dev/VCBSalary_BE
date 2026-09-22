import { TeamsService } from '../teams.service';

function makePrismaMock() {
  return {
    team: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _max: { id: 0 } }),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    department: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    employee: { count: jest.fn().mockResolvedValue(0) },
    userRole: { count: jest.fn().mockResolvedValue(0) },
    kpiGroup: { count: jest.fn().mockResolvedValue(0) },
  };
}

function makeTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    code: 'TEAM-0001',
    name: 'Team K4',
    departmentId: 1,
    status: 'ACTIVE',
    sourceSystem: null,
    ...overrides,
  };
}

describe('TeamsService — xóa team', () => {
  it('xóa được team rỗng', async () => {
    const prisma = makePrismaMock();
    prisma.team.findUnique.mockResolvedValue(makeTeam());
    const service = new TeamsService(prisma as never);

    await service.remove(1);

    expect(prisma.team.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('chặn khi team còn nhân sự', async () => {
    const prisma = makePrismaMock();
    prisma.team.findUnique.mockResolvedValue(makeTeam());
    prisma.employee.count.mockResolvedValue(4);
    const service = new TeamsService(prisma as never);

    await expect(service.remove(1)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prisma.team.delete).not.toHaveBeenCalled();
  });

  // scope_team_id là cột nullable: nếu để database xử lý, vai trò scope TEAM sẽ bị set NULL âm thầm.
  it('chặn khi còn phân quyền lấy team làm phạm vi', async () => {
    const prisma = makePrismaMock();
    prisma.team.findUnique.mockResolvedValue(makeTeam());
    prisma.userRole.count.mockResolvedValue(2);
    const service = new TeamsService(prisma as never);

    await expect(service.remove(1)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prisma.team.delete).not.toHaveBeenCalled();
  });

  // Nhóm KPI còn 0 team bị hệ thống hiểu là "áp dụng mọi team" — phải chặn trước khi tới nước đó.
  it('chặn khi còn nhóm KPI áp dụng cho team', async () => {
    const prisma = makePrismaMock();
    prisma.team.findUnique.mockResolvedValue(makeTeam());
    prisma.kpiGroup.count.mockResolvedValue(1);
    const service = new TeamsService(prisma as never);

    await expect(service.remove(1)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prisma.team.delete).not.toHaveBeenCalled();
  });

  it('chặn team đồng bộ từ AutomationGenVideo vì sync sẽ tạo lại', async () => {
    const prisma = makePrismaMock();
    prisma.team.findUnique.mockResolvedValue(
      makeTeam({ sourceSystem: 'AUTOMATION_GEN_VIDEO' }),
    );
    const service = new TeamsService(prisma as never);

    await expect(service.remove(1)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(prisma.employee.count).not.toHaveBeenCalled();
    expect(prisma.team.delete).not.toHaveBeenCalled();
  });

  it('báo NOT_FOUND khi team không tồn tại', async () => {
    const prisma = makePrismaMock();
    prisma.team.findUnique.mockResolvedValue(null);
    const service = new TeamsService(prisma as never);

    await expect(service.remove(99)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
