import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import {
  CreateEmployeeGroupDto,
  ListEmployeeGroupsQueryDto,
  UpdateEmployeeGroupDto,
} from './dto/employee-group.dto';
import { EmployeeGroupsService } from './employee-groups.service';

@Controller('employee-groups')
export class EmployeeGroupsController {
  constructor(private readonly employeeGroupsService: EmployeeGroupsService) {}

  @Get()
  list(@Query() query: ListEmployeeGroupsQueryDto) {
    return this.employeeGroupsService.list(query);
  }

  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.employeeGroupsService.getOrThrow(id);
  }

  @RequirePermission('employee.manage')
  @Post()
  create(@Body() dto: CreateEmployeeGroupDto) {
    return this.employeeGroupsService.create(dto);
  }

  @RequirePermission('employee.manage')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeGroupDto,
  ) {
    return this.employeeGroupsService.update(id, dto);
  }

  @RequirePermission('employee.manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.employeeGroupsService.remove(id);
  }
}
