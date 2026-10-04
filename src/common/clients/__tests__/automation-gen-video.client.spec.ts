import { AutomationGenVideoClient } from '../automation-gen-video.client';

const VALID_RESPONSE = {
  contract_version: '1.0',
  generated_at: '2026-10-02T03:00:00.000Z',
  timezone: 'Asia/Ho_Chi_Minh',
  range: { from: '2026-09-01', to: '2026-09-30' },
  team: { id: 'team-1', name: 'Content' },
  filters: { user_id: 'user-1' },
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
  records: [],
  pagination: { page: 1, limit: 20, total: 0, total_pages: 0 },
  warnings: [],
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

  it('calls the payroll-sync route with the API key and encoded filters', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(VALID_RESPONSE), { status: 200 }),
      );

    const result = await makeClient().fetchTaskComplianceForPayrollSync(
      'team-1',
      {
        dateFrom: '2026-09-01',
        dateTo: '2026-09-30',
        externalUserId: 'user-1',
        page: 1,
        limit: 20,
      },
    );

    expect(result.summary.missing).toBe(5);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/task-auto/teams/team-1/task-compliance/payroll-sync?from=2026-09-01&to=2026-09-30&user_id=user-1&page=1&limit=20',
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
      makeClient().fetchTaskComplianceForPayrollSync('team-1', {
        dateFrom: '2026-09-01',
        dateTo: '2026-09-30',
        externalUserId: 'user-1',
        page: 1,
        limit: 20,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
  });

  it('describes a missing source route as an integration error', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      makeClient().fetchTaskComplianceForPayrollSync('team-1', {
        dateFrom: '2026-09-01',
        dateTo: '2026-09-30',
        externalUserId: 'user-1',
        page: 1,
        limit: 20,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
  });
});
