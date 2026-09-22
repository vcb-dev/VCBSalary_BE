import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { RequirePermission } from '../../access-control/decorators/require-permission.decorator';
import { CurrentUser } from '../../auth/decorators';
import type { AuthUserPayload } from '../../auth/types';
import {
  CreateRevenueRewardBracketDto,
  UpdateRevenueRewardBracketDto,
} from './dto/revenue-reward-bracket.dto';
import { CreateRewardRuleSetDto } from './dto/reward-rule-set.dto';
import { RewardRuleSetsService } from './reward-rule-sets.service';

/**
 * Không đặt prefix ở cấp class: bộ quy tắc thưởng có 2 nhóm đường dẫn — theo bộ quy tắc
 * (`reward-rule-sets/...`, gồm cả bậc thưởng lồng bên trong) và theo id của một bậc
 * (`revenue-reward-brackets/:id`) — nhưng dùng chung một service, nên gom về một controller và để
 * mỗi route khai báo đường dẫn đầy đủ. Đường dẫn công khai giữ nguyên như trước.
 */
@Controller()
export class RewardRuleSetsController {
  constructor(private readonly rewardRuleSetsService: RewardRuleSetsService) {}

  @RequirePermission('reward_rules.view')
  @Get('reward-rule-sets')
  list() {
    return this.rewardRuleSetsService.list();
  }

  @RequirePermission('reward_rules.view')
  @Get('reward-rule-sets/:id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.rewardRuleSetsService.getOrThrow(id);
  }

  @RequirePermission('reward_rules.manage')
  @Post('reward-rule-sets')
  create(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: CreateRewardRuleSetDto,
  ) {
    return this.rewardRuleSetsService.create(dto, user.id);
  }

  @RequirePermission('reward_rules.manage')
  @Post('reward-rule-sets/:id/activate')
  activate(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.rewardRuleSetsService.activate(id, user.id);
  }

  @RequirePermission('reward_rules.manage')
  @Post('reward-rule-sets/:id/archive')
  archive(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.rewardRuleSetsService.archive(id, user.id);
  }

  @RequirePermission('reward_rules.view')
  @Get('reward-rule-sets/:id/revenue-brackets')
  listBrackets(@Param('id', ParseIntPipe) id: number) {
    return this.rewardRuleSetsService.listBrackets(id);
  }

  @RequirePermission('reward_rules.manage')
  @Post('reward-rule-sets/:id/revenue-brackets')
  createBracket(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateRevenueRewardBracketDto,
  ) {
    return this.rewardRuleSetsService.createBracket(id, dto, user.id);
  }

  // Sửa/xoá một bậc thưởng thì chỉ cần id của chính bậc đó, không cần id bộ quy tắc cha.
  @RequirePermission('reward_rules.manage')
  @Patch('revenue-reward-brackets/:id')
  updateBracket(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRevenueRewardBracketDto,
  ) {
    return this.rewardRuleSetsService.updateBracket(id, dto, user.id);
  }

  @RequirePermission('reward_rules.manage')
  @Delete('revenue-reward-brackets/:id')
  removeBracket(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.rewardRuleSetsService.deleteBracket(id, user.id);
  }
}
