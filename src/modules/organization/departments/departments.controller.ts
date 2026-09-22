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
} from '@nestjs/common';
import { RequirePermission } from '../../access-control/decorators/require-permission.decorator';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';
import { DepartmentsService } from './departments.service';

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get()
  list() {
    return this.departmentsService.list();
  }

  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.departmentsService.getOrThrow(id);
  }

  @RequirePermission('employee.manage')
  @Post()
  create(@Body() dto: CreateDepartmentDto) {
    return this.departmentsService.create(dto);
  }

  @RequirePermission('employee.manage')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.departmentsService.update(id, dto);
  }

  @RequirePermission('employee.manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.departmentsService.remove(id);
  }
}
