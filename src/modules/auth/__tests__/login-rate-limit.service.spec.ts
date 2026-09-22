import { LoginRateLimitService } from '../login-rate-limit.service';

function makeConfig(values: Record<string, string> = {}) {
  return { get: jest.fn((key: string) => values[key]) };
}

describe('LoginRateLimitService', () => {
  it('blocks a key after the configured number of failures', () => {
    const service = new LoginRateLimitService(
      makeConfig({
        LOGIN_MAX_ATTEMPTS: '2',
        LOGIN_WINDOW_SECONDS: '60',
      }) as never,
    );
    service.recordFailure('ip:user', 1_000);
    service.recordFailure('ip:user', 2_000);

    expect(() => service.assertAllowed('ip:user', 3_000)).toThrow(
      'Đăng nhập thất bại quá nhiều lần',
    );
  });

  it('allows login again after reset or expiry', () => {
    const service = new LoginRateLimitService(
      makeConfig({
        LOGIN_MAX_ATTEMPTS: '1',
        LOGIN_WINDOW_SECONDS: '10',
      }) as never,
    );
    service.recordFailure('ip:user', 1_000);
    service.reset('ip:user');
    expect(() => service.assertAllowed('ip:user', 2_000)).not.toThrow();

    service.recordFailure('ip:user', 3_000);
    expect(() => service.assertAllowed('ip:user', 13_001)).not.toThrow();
  });

  it('does not share counters between different IP/email keys', () => {
    const service = new LoginRateLimitService(
      makeConfig({ LOGIN_MAX_ATTEMPTS: '1' }) as never,
    );
    service.recordFailure('ip-a:user', 1_000);

    expect(() => service.assertAllowed('ip-b:user', 2_000)).not.toThrow();
  });
});
