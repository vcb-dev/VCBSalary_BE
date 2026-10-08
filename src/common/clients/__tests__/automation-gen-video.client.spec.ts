import { AutomationGenVideoClient } from '../automation-gen-video.client';

const SHORT_LINE = {
  id: 'line-1',
  user_id: 'user-1',
  employee_id: 'K2_07',
  user_name: 'Nguyễn Văn A',
  team_id: 'team-1',
  work_date: '2026-09-15',
  content_line: { id: 'cl-a4', name: 'A4' },
  source: 'AUTO_A4',
  expected_count: 3,
  completed_count: 1,
  missing_count: 2,
  deadline: '2026-09-15T10:00:00.000Z',
  evaluated_at: '2026-09-16T00:05:00.000Z',
  untracked_missing: 1,
  tasks: [
    {
      id: 'task-1',
      title: null,
      product_name: 'Nhẫn bạc',
      status: 'ASSIGNED',
      deadline: '2026-09-15T10:00:00.000Z',
      submitted_at: null,
      on_time: false,
    },
  ],
};

const VALID_RESPONSE = {
  contract_version: '1.1',
  generated_at: '2026-10-02T03:00:00.000Z',
  timezone: 'Asia/Ho_Chi_Minh',
  range: { from: '2026-09-01', to: '2026-09-30' },
  team: { id: 'team-1', name: 'Content' },
  filters: { user_id: 'user-1', group_by: 'person_day' },
  coverage: {
    snapshot_count: 30,
    evaluated_from: '2026-09-01',
    evaluated_through: '2026-09-30',
  },
  summary: {
    expected: 60,
    completed_on_time: 55,
    missing: 5,
    affected_days: 3,
    affected_records: 3,
  },
  shortfall_summary: {
    person_days: 1,
    lines: 1,
    expected: 3,
    completed: 1,
    missing: 2,
  },
  records: [SHORT_LINE],
  days: [
    {
      key: 'user-1|2026-09-15',
      work_date: '2026-09-15',
      user_id: 'user-1',
      employee_id: 'K2_07',
      user_name: 'Nguyễn Văn A',
      expected_count: 3,
      completed_count: 1,
      missing_count: 2,
      day_total: { expected: 5, completed: 3, missing: 2 },
      lines: [
        SHORT_LINE,
        {
          ...SHORT_LINE,
          id: 'line-2',
          content_line: { id: 'cl-a1', name: 'A1' },
          source: 'DAILY_PLAN',
          expected_count: 2,
          completed_count: 2,
          missing_count: 0,
          untracked_missing: 0,
          tasks: [],
        },
      ],
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, total_pages: 1 },
  warnings: [],
};

const QUERY = {
  dateFrom: '2026-09-01',
  dateTo: '2026-09-30',
  externalUserId: 'user-1',
  page: 1,
  limit: 20,
};

function makeClient() {
  const config = {
    get: jest.fn((key: string) =>
      key === 'AUTOMATION_GEN_VIDEO_BASE_URL'
        ? 'http://localhost:3000/api/'
        : 'secret-key',
    ),
  };
  return new AutomationGenVideoClient(config as never);
}

describe('AutomationGenVideoClient task compliance', () => {
  afterEach(() => jest.restoreAllMocks());

  it('calls the payroll-sync route grouped by person-day with the API key', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }),
      );

    const result = await makeClient().fetchTaskComplianceForPayrollSync(
      'team-1',
      QUERY,
    );

    expect(result.summary.missing).toBe(5);
    expect(result.days[0].lines).toHaveLength(2);
    expect(result.days[0].lines[0].tasks[0].product_name).toBe('Nhẫn bạc');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/task-auto/teams/team-1/task-compliance/payroll-sync?from=2026-09-01&to=2026-09-30&user_id=user-1&group_by=person_day&page=1&limit=20',
      expect.objectContaining({ headers: { 'x-api-key': 'secret-key' } }),
    );
  });

  it('rejects an invalid source contract as a bad gateway error', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ records: [] }), { status: 200 }),
      );

    await expect(
      makeClient().fetchTaskComplianceForPayrollSync('team-1', QUERY),
    ).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
  });

  it('rejects a day whose task list is malformed', async () => {
    const [day] = VALID_RESPONSE.days;
    const broken = {
      ...VALID_RESPONSE,
      days: [{ ...day, lines: [{ ...SHORT_LINE, tasks: [{ id: 'task-1' }] }] }],
    };
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(broken), { status: 200 }));

    await expect(
      makeClient().fetchTaskComplianceForPayrollSync('team-1', QUERY),
    ).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
  });

  it('names the outdated 1.0 contract instead of calling it invalid data', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ...VALID_RESPONSE, contract_version: '1.0' }),
          { status: 200 },
        ),
      );

    await expect(
      makeClient().fetchTaskComplianceForPayrollSync('team-1', QUERY),
    ).rejects.toThrow('cần cập nhật lên 1.1');
  });

  it('describes a missing source route as an integration error', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      makeClient().fetchTaskComplianceForPayrollSync('team-1', QUERY),
    ).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
  });
});
