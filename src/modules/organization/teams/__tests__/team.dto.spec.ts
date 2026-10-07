import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateTeamDto, UpdateTeamDto } from '../dto/team.dto';

describe('Team DTO — departmentId', () => {
  it('ép chuỗi id từ FE về number khi tạo team', () => {
    const dto = plainToInstance(CreateTeamDto, {
      name: 'Team Content',
      departmentId: '12',
    });
    expect(dto.departmentId).toBe(12);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('ép chuỗi id từ FE về number khi sửa team', () => {
    const dto = plainToInstance(UpdateTeamDto, { departmentId: '3' });
    expect(dto.departmentId).toBe(3);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('vẫn chặn departmentId không hợp lệ', () => {
    const dto = plainToInstance(CreateTeamDto, {
      name: 'Team Content',
      departmentId: 'abc',
    });
    expect(validateSync(dto).map((error) => error.property)).toContain(
      'departmentId',
    );
  });
});
