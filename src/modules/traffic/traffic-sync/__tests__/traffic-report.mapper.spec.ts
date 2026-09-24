import type { AutomationGenVideoTrafficRow } from '../../../../common/clients/automation-gen-video.client';
import {
  selectLatestRowPerPerson,
  trafficRowKey,
} from '../traffic-report.mapper';

function row(
  overrides: Partial<AutomationGenVideoTrafficRow> = {},
): AutomationGenVideoTrafficRow {
  return {
    date: '2026-09-10',
    email: 'an@vcb.vn',
    name: 'Quý An',
    team: 'Team K2',
    fb: 0,
    ig: 0,
    tiktok: 0,
    yt: 0,
    thread: 0,
    zalo: 0,
    total: 0,
    details: [],
    ...overrides,
  };
}

const viewsOf = (
  people: ReturnType<typeof selectLatestRowPerPerson>,
  platform: string,
) => people[0].platforms.find((item) => item.platform === platform)?.views;

describe('selectLatestRowPerPerson', () => {
  it('lấy dòng ngày gần nhất chứ không cộng dồn các ngày', () => {
    const people = selectLatestRowPerPerson([
      row({ date: '2026-09-05', fb: 1_000, total: 1_000 }),
      row({ date: '2026-09-20', fb: 7_500, total: 7_500 }),
      row({ date: '2026-09-12', fb: 4_000, total: 4_000 }),
    ]);

    expect(people).toHaveLength(1);
    expect(people[0].reportDate).toBe('2026-09-20');
    // 7.500 chứ không phải 12.500: traffic là số luỹ kế, cộng nhiều ngày sẽ thổi phồng.
    expect(viewsOf(people, 'FACEBOOK')).toBe(7_500n);
    expect(people[0].total).toBe(7_500n);
  });

  it('cộng gộp nhiều dòng cùng người trong cùng một ngày', () => {
    const people = selectLatestRowPerPerson([
      row({ date: '2026-09-20', fb: 1_000, total: 1_000 }),
      row({ date: '2026-09-20', ig: 500, total: 500 }),
    ]);

    expect(people).toHaveLength(1);
    expect(viewsOf(people, 'FACEBOOK')).toBe(1_000n);
    expect(viewsOf(people, 'INSTAGRAM')).toBe(500n);
    expect(people[0].total).toBe(1_500n);
  });

  it('map đủ bốn nền tảng hệ thống lương hỗ trợ', () => {
    const people = selectLatestRowPerPerson([
      row({ fb: 1, ig: 2, tiktok: 3, yt: 4, total: 10 }),
    ]);

    expect(
      Object.fromEntries(
        people[0].platforms.map((item) => [item.platform, item.views]),
      ),
    ).toEqual({
      FACEBOOK: 1n,
      INSTAGRAM: 2n,
      TIKTOK: 3n,
      YOUTUBE: 4n,
    });
  });

  it('tách riêng thread/zalo vào unmappedPlatforms thay vì bỏ im lặng', () => {
    const people = selectLatestRowPerPerson([
      row({ fb: 100, thread: 30, zalo: 0, total: 130 }),
    ]);

    expect(people[0].unmappedPlatforms).toEqual([
      { platform: 'thread', views: 30n },
    ]);
  });

  it('giữ tên kênh của từng nền tảng để còn đối chiếu', () => {
    const people = selectLatestRowPerPerson([
      row({
        fb: 100,
        total: 100,
        details: [{ platform: 'fb', channel: 'VCB Reels', value: 100 }],
      }),
    ]);

    expect(
      people[0].platforms.find((item) => item.platform === 'FACEBOOK')?.channel,
    ).toBe('VCB Reels');
  });

  it('gộp theo email không phân biệt hoa thường và khoảng trắng', () => {
    const people = selectLatestRowPerPerson([
      row({ email: ' An@VCB.vn ', date: '2026-09-05', fb: 10, total: 10 }),
      row({ email: 'an@vcb.vn', date: '2026-09-06', fb: 20, total: 20 }),
    ]);

    expect(people).toHaveLength(1);
    expect(people[0].email).toBe('an@vcb.vn');
    expect(viewsOf(people, 'FACEBOOK')).toBe(20n);
  });

  it('rơi về tên khi bản ghi nguồn thiếu email', () => {
    const people = selectLatestRowPerPerson([
      row({ email: null, name: 'Quý  An', fb: 10, total: 10 }),
    ]);

    expect(people).toHaveLength(1);
    expect(people[0].email).toBeNull();
    expect(trafficRowKey({ email: null, name: 'Quý  An' })).toBe('name:quý an');
  });

  it('bỏ qua dòng không có cả email lẫn tên', () => {
    expect(
      selectLatestRowPerPerson([row({ email: null, name: null, fb: 10 })]),
    ).toEqual([]);
  });

  it('coi số âm và giá trị không hợp lệ là 0', () => {
    const people = selectLatestRowPerPerson([
      row({ fb: -5, ig: Number.NaN, total: 0 }),
    ]);

    expect(viewsOf(people, 'FACEBOOK')).toBe(0n);
    expect(viewsOf(people, 'INSTAGRAM')).toBe(0n);
  });
});
