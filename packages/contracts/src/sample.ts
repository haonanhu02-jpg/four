import { normalizeDocument, type TransferDocument } from './data-transfer';
export function sampleDocument(date: string): TransferDocument {
  const year = Number(date.slice(0, 4)),
    month = date.slice(0, 7);
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const start = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 6);
  const end = d.toISOString().slice(0, 10);
  const due = new Date(Date.UTC(year, Number(date.slice(5, 7)), 0, 12)).toISOString().slice(0, 10);
  const roots = [
    ['财务基础工程：系统与结转能力成型', 35, 30],
    ['财务效率提升：AI 与信息化落地', 26, 25],
    ['组织与团队能力建设', 40, 20],
    ['政策与资金：补助及税务事项推进', 23, 25],
  ] as const;
  const years = roots.map(([title, progress, weight]) => ({
    id: crypto.randomUUID(),
    year,
    title,
    note: '明确交付成果，持续推进并复盘',
    progress,
    weight,
  }));
  const monthly = [
    ['泰国固定资料结转项目', 0, 86, 20],
    ['信息化提效-AI：项目落地', 1, 60, 20],
    ['赋能投效：完成大伟财务的效率问题', 2, 54, 20],
    ['GR工作-补助事项', 3, 70, 15],
    ['团队能力建设：完成 1 次内部分享', 2, 73, 15],
    ['会议（经营会 / 条线例会）', 2, 50, 10],
  ] as const;
  const months = monthly.map(([title, parent, progress, weight]) => ({
    id: crypto.randomUUID(),
    yearId: years[parent]!.id,
    month,
    title,
    note: '围绕年度方向，明确本月交付与本周推进动作',
    progress,
    weight,
    due,
  }));
  const titles = [
    '按窗口正式导入系统，跑通首轮结转并核对结果',
    '与大伟财务对齐诊断结论，报告定稿并提交',
    '分享彩排一轮，按彩排反馈把材料定稿',
    '5→4 重组：交接清单打勾，排出试运行计划',
    '工作台用法沉淀成推广清单，圈定 1 个试点组',
    '例会前复盘跟踪表，超期项点对点催办',
    'GR 节点月度提醒一次，填渣款跟进挂起',
  ];
  const weeks = [0, 2, 4, 4, 1, 5, 3].map((parent, i) => ({
    id: crypto.randomUUID(),
    monthId: months[parent]!.id,
    wkStart: start,
    wkEnd: end,
    title: titles[i],
    note: '保留本周推进事项和可核验结果',
    priority: i < 2 || i === 3 ? 'P0' : i > 4 ? 'P2' : 'P1',
    status: 'doing',
  }));
  const actions = [
    '按窗口启动正式结转导入，跑完第一批并抽查差异',
    '与大伟财务开对齐会，会后按结论改稿',
    '交接清单逐项打勾，排出试运行计划',
    '列工作台推广清单骨架，圈 3 个候选试点组',
    '分享材料自己彩排一轮，记录卡点',
    '例会前过跟踪表，把超期项点对点催办',
    'GR 节点过一遍，后续提醒挂上',
  ];
  const days = [
    [0, 60],
    [1, 45],
    [3, 40],
    [4, 30],
    [2, 30],
    [5, 20],
    [6, 10],
  ].map(([parent, minutes], i) => ({
    id: crypto.randomUUID(),
    weekId: weeks[parent!]!.id,
    date,
    title: actions[i],
    minutes,
    done: false,
  }));
  return normalizeDocument({ version: 2, years, months, weeks, days }).document;
}
