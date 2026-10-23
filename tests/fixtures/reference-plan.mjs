import { randomUUID } from 'node:crypto';

// Values and associations transcribed from the supplied HTML sampleState().
// Fixture only: this does not add sample data to application accounts.
export async function seedReferencePlan(pool, userId, date = '2026-10-21') {
  const month = date.slice(0, 7);
  const year = Number(date.slice(0, 4));
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  const start = day.toISOString().slice(0, 10);
  day.setUTCDate(day.getUTCDate() + 6);
  const end = day.toISOString().slice(0, 10);
  const annual = [];
  for (const [title, progress, weight] of [
    ['财务基础工程：系统与结转能力成型', 35, 30],
    ['财务效率提升：AI 与信息化落地', 26, 25],
    ['组织与团队能力建设', 40, 20],
    ['政策与资金：补助及税务事项推进', 23, 25],
  ]) {
    const result = await pool.query(
      'INSERT INTO annual_goals(id,user_id,year,title,progress,weight) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [randomUUID(), userId, year, title, progress, weight],
    );
    annual.push(result.rows[0]);
  }
  const monthly = [];
  for (const [title, root, progress, weight] of [
    ['泰国固定资料结转项目', 0, 86, 20],
    ['信息化提效-AI：项目落地', 1, 60, 20],
    ['赋能投效：完成大伟财务的效率问题', 2, 54, 20],
    ['GR工作-补助事项', 3, 70, 15],
    ['团队能力建设：完成 1 次内部分享', 2, 73, 15],
    ['会议（经营会 / 条线例会）', 2, 50, 10],
  ]) {
    const result = await pool.query(
      'INSERT INTO monthly_goals(id,user_id,annual_goal_id,title,original_month,current_month,progress,weight) VALUES ($1,$2,$3,$4,$5,$5,$6,$7) RETURNING *',
      [randomUUID(), userId, annual[root].id, title, `${month}-01`, progress, weight],
    );
    monthly.push(result.rows[0]);
  }
  const weekly = [];
  for (const [index, parent] of [0, 2, 4, 4, 1, 5, 3].entries()) {
    const result = await pool.query(
      "INSERT INTO weekly_tasks(id,user_id,monthly_goal_id,title,original_start,original_end,current_start,current_end,status) VALUES ($1,$2,$3,$4,$5,$6,$5,$6,'doing') RETURNING *",
      [randomUUID(), userId, monthly[parent].id, `示例周任务 ${index + 1}`, start, end],
    );
    weekly.push(result.rows[0]);
  }
  const daily = [];
  for (const [index, [parent, minutes]] of [
    [0, 60],
    [1, 45],
    [3, 40],
    [4, 30],
    [2, 30],
    [5, 20],
    [6, 10],
  ].entries()) {
    const result = await pool.query(
      'INSERT INTO daily_tasks(id,user_id,weekly_task_id,title,original_date,scheduled_date,minutes) VALUES ($1,$2,$3,$4,$5,$5,$6) RETURNING *',
      [
        randomUUID(),
        userId,
        weekly[parent].id,
        index === 0 ? '按窗口启动正式结转导入，跑完第一批并抽查差异' : `示例日待办 ${index + 1}`,
        date,
        minutes,
      ],
    );
    daily.push(result.rows[0]);
  }
  return { annual, monthly, weekly, daily, selection: { year, month, start, end, date } };
}
