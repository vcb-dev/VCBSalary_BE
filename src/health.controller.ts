import { Controller, Get } from '@nestjs/common';
import { Public } from './modules/auth/decorators';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check() {
    return { status: 'ok', service: 'vcb-salary-api' };
  }
}
