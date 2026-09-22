import { DepartmentsService } from '../departments.service';

function makePrismaMock() {
  return {
    department: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      aggregate: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    team: { count: jest.fn() },
  };
}

describe('DepartmentsService', () => {
  it('creates a department with a generated code', async () => {
    const prisma = makePrismaMock();
    prisma.department.aggregate.mockResolvedValue({ _max: { id: 4 } });
    prisma.department.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 5, ...data }),
    );
    const service = new DepartmentsService(prisma as never);

    await expect(
      service.create({ name: '  Kinh doanh  ' }),
    ).resolves.toMatchObject({ code: 'DEPT-0005', name: 'Kinh doanh' });
  });

  it('does not delete a department that still contains teams', async () => {
    const prisma = makePrismaMock();
    prisma.department.findUnique.mockResolvedValue({
      id: 2,
      code: 'SALES',
      name: 'Kinh doanh',
      teams: [],
      _count: { teams: 1 },
    });
    prisma.team.count.mockResolvedValue(1);
    const service = new DepartmentsService(prisma as never);

    await expect(service.remove(2)).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
    expect(prisma.department.delete).not.toHaveBeenCalled();
  });

  it('deletes an empty department', async () => {
    const prisma = makePrismaMock();
    prisma.department.findUnique.mockResolvedValue({
      id: 3,
      code: 'EMPTY',
      name: 'Phòng trống',
      teams: [],
      _count: { teams: 0 },
    });
    prisma.team.count.mockResolvedValue(0);
    prisma.department.delete.mockResolvedValue({ id: 3 });
    const service = new DepartmentsService(prisma as never);

    await expect(service.remove(3)).resolves.toBeUndefined();
    expect(prisma.department.delete).toHaveBeenCalledWith({ where: { id: 3 } });
  });
});
