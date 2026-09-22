import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  CreateDepartmentDto,
  UpdateDepartmentDto,
} from './dto/department.dto';

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.department.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { teams: true } } },
    });
  }

  async getOrThrow(id: number) {
    const department = await this.prisma.department.findUnique({
      where: { id },
      include: {
        teams: { orderBy: { name: 'asc' } },
        _count: { select: { teams: true } },
      },
    });
    if (!department) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy phòng ban',
        HttpStatus.NOT_FOUND,
      );
    }
    return department;
  }

  async create(dto: CreateDepartmentDto) {
    const latest = await this.prisma.department.aggregate({
      _max: { id: true },
    });
    const code = `DEPT-${String((latest._max.id ?? 0) + 1).padStart(4, '0')}`;

    return this.prisma.department.create({
      data: { code, name: dto.name.trim(), status: dto.status },
    });
  }

  async update(id: number, dto: UpdateDepartmentDto) {
    await this.getOrThrow(id);
    return this.prisma.department.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        status: dto.status,
      },
    });
  }

  async remove(id: number) {
    await this.getOrThrow(id);
    const teamCount = await this.prisma.team.count({
      where: { departmentId: id },
    });
    if (teamCount > 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `Phòng ban còn ${teamCount} team nên không thể xóa. Hãy chuyển các team sang phòng ban khác trước.`,
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.department.delete({ where: { id } });
  }
}
