import { matchEmployeesByEmailOrName as matchKpiEmployees } from '../employee-identity-matcher';

describe('Employee identity mapping: email rồi tên', () => {
  it('ưu tiên email hơn tên, bỏ khoảng trắng và không phân biệt hoa thường ở email', () => {
    const result = matchKpiEmployees(
      [
        { id: 1, fullName: 'Tên cũ', user: { email: 'AN@vcbi.test' } },
        { id: 2, fullName: 'Nguyễn Văn An', user: null },
      ],
      [
        {
          user_id: 'source-1',
          email: ' an@VCBI.test ',
          full_name: 'Nguyễn Văn An',
        },
      ],
    );
    expect(result.get('source-1')).toEqual({ employeeId: 1 });
  });

  it('fallback tên khi email không khớp, chuẩn hóa hoa thường, Unicode và khoảng trắng', () => {
    const result = matchKpiEmployees(
      [{ id: 2, fullName: 'Nguyễn Văn An', user: null }],
      [
        {
          user_id: 'source-1',
          email: 'other@vcbi.test',
          full_name: '  NGUYỄN   VĂN AN '.normalize('NFD'),
        },
      ],
    );
    expect(result.get('source-1')).toEqual({ employeeId: 2 });
  });

  it('không tự chọn nhân sự khi trùng tên', () => {
    const result = matchKpiEmployees(
      [
        { id: 1, fullName: 'Nguyễn Văn An', user: null },
        { id: 2, fullName: 'Nguyễn Văn An', user: null },
      ],
      [{ user_id: 'source-1', email: '', full_name: 'Nguyễn Văn An' }],
    );
    expect(result.get('source-1')?.employeeId).toBeUndefined();
    expect(result.get('source-1')?.reason).toContain('Tên khớp nhiều');
  });

  it('email trùng phải bỏ qua, không fallback tên để né sự mơ hồ', () => {
    const result = matchKpiEmployees(
      [
        { id: 1, fullName: 'Nguyễn Văn An', user: { email: 'an@vcbi.test' } },
        { id: 2, fullName: 'Trần Văn Bình', user: { email: 'an@vcbi.test' } },
      ],
      [
        {
          user_id: 'source-1',
          email: 'an@vcbi.test',
          full_name: 'Nguyễn Văn An',
        },
      ],
    );
    expect(result.get('source-1')?.employeeId).toBeUndefined();
    expect(result.get('source-1')?.reason).toContain('Email khớp nhiều');
  });

  it('không fuzzy-match tên không dấu và không nhận diện khi thiếu danh tính', () => {
    const result = matchKpiEmployees(
      [{ id: 1, fullName: 'Nguyễn Văn An', user: null }],
      [
        { user_id: 'source-1', email: '', full_name: 'Nguyen Van An' },
        { user_id: 'source-2', email: '', full_name: '' },
      ],
    );
    expect(result.get('source-1')?.employeeId).toBeUndefined();
    expect(result.get('source-2')?.employeeId).toBeUndefined();
  });

  it('bỏ qua nếu hai tài khoản nguồn cùng khớp một nhân sự', () => {
    const result = matchKpiEmployees(
      [{ id: 1, fullName: 'Nguyễn Văn An', user: { email: 'an@vcbi.test' } }],
      [
        {
          user_id: 'source-1',
          email: 'an@vcbi.test',
          full_name: 'Nguyễn Văn An',
        },
        {
          user_id: 'source-2',
          email: 'other@vcbi.test',
          full_name: 'Nguyễn Văn An',
        },
      ],
    );
    expect(result.get('source-1')?.reason).toContain('Nhiều tài khoản nguồn');
    expect(result.get('source-2')?.reason).toContain('Nhiều tài khoản nguồn');
  });
});
