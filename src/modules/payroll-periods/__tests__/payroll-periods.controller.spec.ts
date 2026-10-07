import { PayrollPeriodsController } from '../payroll-periods.controller';

describe('PayrollPeriodsController global state transitions', () => {
  function makeController(
    scope: { type: 'ALL' } | { type: 'TEAM'; teamIds: number[] },
  ) {
    const payrollPeriodsService = {
      startReview: jest.fn().mockResolvedValue({ status: 'IN_REVIEW' }),
      close: jest.fn().mockResolvedValue({ status: 'CLOSED' }),
    };
    const authorization = {
      resolvePermissionScope: jest.fn().mockResolvedValue(scope),
    };
    const controller = new PayrollPeriodsController(
      payrollPeriodsService as never,
      authorization as never,
    );
    return { controller, payrollPeriodsService, authorization };
  }

  it('allows an ALL-scoped period manager to start review and close', async () => {
    const { controller, payrollPeriodsService, authorization } = makeController(
      { type: 'ALL' },
    );
    const user = { id: 'admin-user', email: 'admin@example.com' };

    await expect(controller.startReview(user, 2)).resolves.toEqual({
      status: 'IN_REVIEW',
    });
    await expect(controller.close(user, 2)).resolves.toEqual({
      status: 'CLOSED',
    });

    expect(authorization.resolvePermissionScope).toHaveBeenCalledWith(
      'admin-user',
      'payroll_period.manage',
    );
    expect(payrollPeriodsService.startReview).toHaveBeenCalledWith(
      2,
      'admin-user',
    );
    expect(payrollPeriodsService.close).toHaveBeenCalledWith(2, 'admin-user');
  });

  it('rejects a TEAM-scoped manager before changing the global period state', async () => {
    const { controller, payrollPeriodsService } = makeController({
      type: 'TEAM',
      teamIds: [10],
    });
    const user = { id: 'leader-user', email: 'leader@example.com' };

    await expect(controller.startReview(user, 2)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(controller.close(user, 2)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(payrollPeriodsService.startReview).not.toHaveBeenCalled();
    expect(payrollPeriodsService.close).not.toHaveBeenCalled();
  });
});
