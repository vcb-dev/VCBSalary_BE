/**
 * Xoá toàn bộ dữ liệu nghiệp vụ của MỘT kỳ lương.
 *
 *   node scripts/purge-payroll-period.cjs --period 1 --dry-run   # chỉ đếm, không xoá
 *   node scripts/purge-payroll-period.cjs --period 1 --yes       # xoá thật
 *
 * Giữ nguyên: nhân sự, team, membership, external identity, cấu hình thưởng,
 * lương cơ bản, nhóm/chỉ tiêu KPI, user/role/permission, lịch sử đồng bộ cơ cấu.
 *
 * Xoá: snapshot kỳ, KPI assignment/target/actual, OKR, traffic, revenue,
 * salary record + các dòng con, KPI sync run + item, audit log gắn kỳ,
 * notification, và bản ghi kỳ lương.
 *
 * Thao tác chạy trong MỘT transaction: lỗi ở bất kỳ bước nào thì rollback toàn bộ.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const args = process.argv.slice(2);
const periodArg = args[args.indexOf('--period') + 1];
const PID = Number(periodArg);
const DRY_RUN = args.includes('--dry-run');
const CONFIRMED = args.includes('--yes');

if (!Number.isInteger(PID) || PID < 1) {
  console.error('Thiếu --period <id>. Ví dụ: --period 1');
  process.exit(1);
}
if (!DRY_RUN && !CONFIRMED) {
  console.error('Đây là thao tác không hoàn tác được. Thêm --yes để xác nhận, hoặc --dry-run để xem trước.');
  process.exit(1);
}

const prisma = new PrismaClient();

// Thứ tự tôn trọng FK: con trước, cha sau.
// RESTRICT bắt buộc xoá salary_record_okr_items trước employee_okrs,
// và kpi_sync_run_items trước kpi_sync_runs.
const steps = (pid) => [
  ['salary_record_components', `salary_record_components WHERE salary_record_id IN (SELECT id FROM salary_records WHERE payroll_period_id=${pid})`],
  ['salary_record_kpi_items', `salary_record_kpi_items WHERE salary_record_id IN (SELECT id FROM salary_records WHERE payroll_period_id=${pid})`],
  ['salary_record_okr_items', `salary_record_okr_items WHERE salary_record_id IN (SELECT id FROM salary_records WHERE payroll_period_id=${pid})`],
  ['salary_records', `salary_records WHERE payroll_period_id=${pid}`],
  ['kpi_sync_run_items', `kpi_sync_run_items WHERE kpi_sync_run_id IN (SELECT id FROM kpi_sync_runs WHERE payroll_period_id=${pid})`],
  ['kpi_sync_runs', `kpi_sync_runs WHERE payroll_period_id=${pid}`],
  ['employee_kpi_actuals', `employee_kpi_actuals WHERE payroll_period_id=${pid}`],
  ['employee_kpi_targets', `employee_kpi_targets WHERE payroll_period_id=${pid}`],
  ['employee_kpi_assignments', `employee_kpi_assignments WHERE payroll_period_id=${pid}`],
  ['employee_okrs', `employee_okrs WHERE payroll_period_id=${pid}`],
  ['kpi_okr_proposals', `kpi_okr_proposals WHERE payroll_period_id=${pid}`],
  ['kpi_period_targets', `kpi_period_targets WHERE payroll_period_id=${pid}`],
  ['traffic_record_attachments', `traffic_record_attachments WHERE employee_traffic_record_id IN (SELECT id FROM employee_traffic_records WHERE payroll_period_id=${pid})`],
  ['employee_traffic_records', `employee_traffic_records WHERE payroll_period_id=${pid}`],
  ['employee_revenue_records', `employee_revenue_records WHERE payroll_period_id=${pid}`],
  ['payroll_period_employee_team_snapshots', `payroll_period_employee_team_snapshots WHERE payroll_period_id=${pid}`],
  ['payroll_period_employee_snapshots', `payroll_period_employee_snapshots WHERE payroll_period_id=${pid}`],
  ['audit_logs (gắn kỳ)', `audit_logs WHERE payroll_period_id=${pid}`],
  ['notifications', `notifications`],
  ['payroll_periods', `payroll_periods WHERE id=${pid}`],
];

(async () => {
  const period = await prisma.$queryRawUnsafe(
    `SELECT id, code, name, status FROM payroll_periods WHERE id=${PID}`,
  );
  if (period.length === 0) {
    console.error(`Không tìm thấy kỳ lương id=${PID}.`);
    process.exit(1);
  }
  console.log(`Kỳ lương: ${period[0].code} — ${period[0].name} (status ${period[0].status})\n`);

  const plan = steps(PID);

  if (DRY_RUN) {
    let total = 0;
    for (const [name, target] of plan) {
      const r = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM ${target}`);
      total += r[0].n;
      console.log(String(r[0].n).padStart(6), name);
    }
    console.log('-'.repeat(46));
    console.log(String(total).padStart(6), 'dòng SẼ bị xoá (chưa xoá gì)');
    await prisma.$disconnect();
    return;
  }

  const results = await prisma.$transaction(
    plan.map(([, target]) => prisma.$executeRawUnsafe(`DELETE FROM ${target}`)),
    { timeout: 120000 },
  );

  let total = 0;
  plan.forEach(([name], i) => {
    total += results[i];
    console.log(String(results[i]).padStart(6), name);
  });
  console.log('-'.repeat(46));
  console.log(String(total).padStart(6), 'dòng đã xoá');
  await prisma.$disconnect();
})().catch((e) => {
  console.error('ĐÃ ROLLBACK, không có gì bị xoá —', e.message);
  process.exit(1);
});
