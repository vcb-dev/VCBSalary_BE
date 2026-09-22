import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateEmployeeGroupDto,
  UpdateEmployeeGroupDto,
} from '../dto/employee-group.dto';

describe('EmployeeGroup DTO — null departmentId', () => {
  it('giữ null cho departmentId/defaultRoleId (nhóm dùng chung)', () => {
    const dto = plainToInstance(CreateEmployeeGroupDto, {
      name: 'Kế toán viên',
      departmentId: null,
      defaultRoleId: null,
    });
    expect(dto.departmentId).toBeNull();
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('ép chuỗi id từ FE về number', () => {
    const dto = plainToInstance(UpdateEmployeeGroupDto, {
      departmentId: '7',
      jobTitleKeywords: ['Kế toán'],
    });
    expect(dto.departmentId).toBe(7);
    expect(validateSync(dto)).toHaveLength(0);
  });
});
