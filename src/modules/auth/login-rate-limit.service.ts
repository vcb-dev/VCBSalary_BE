import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

type AttemptWindow = { failures: number; resetAt: number };

/**
 * Giới hạn brute-force theo cặp IP + email. Với triển khai nhiều instance, thay Map bằng một
 * rate-limit store dùng chung (Redis/API gateway) để giới hạn có hiệu lực trên toàn cụm.
 */
@Injectable()
export class LoginRateLimitService {
  private readonly attempts = new Map<string, AttemptWindow>();

  constructor(private readonly config: ConfigService) {}

  assertAllowed(key: string, now = Date.now()) {
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    if (attempt.resetAt <= now) {
      this.attempts.delete(key);
      return;
    }
    if (attempt.failures >= this.maxAttempts()) {
      throw new AppException(
        ErrorCode.AUTH_RATE_LIMITED,
        'Đăng nhập thất bại quá nhiều lần, vui lòng thử lại sau',
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfterSeconds: Math.ceil((attempt.resetAt - now) / 1000) },
      );
    }
  }

  recordFailure(key: string, now = Date.now()) {
    const current = this.attempts.get(key);
    const resetAt =
      current && current.resetAt > now
        ? current.resetAt
        : now + this.windowMs();
    const failures =
      current && current.resetAt > now ? current.failures + 1 : 1;
    this.attempts.set(key, { failures, resetAt });
    if (this.attempts.size > 10_000) this.prune(now);
  }

  reset(key: string) {
    this.attempts.delete(key);
  }

  private maxAttempts() {
    return this.positiveInteger('LOGIN_MAX_ATTEMPTS', 5);
  }

  private windowMs() {
    return this.positiveInteger('LOGIN_WINDOW_SECONDS', 900) * 1000;
  }

  private positiveInteger(name: string, fallback: number) {
    const value = Number(this.config.get<string>(name));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private prune(now: number) {
    for (const [key, value] of this.attempts) {
      if (value.resetAt <= now) this.attempts.delete(key);
    }
  }
}
