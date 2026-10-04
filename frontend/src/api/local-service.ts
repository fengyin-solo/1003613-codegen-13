import { CURRENT_RULE, isSealed } from '@/data/handover-rules'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, transact } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function pad(num: number): string {
  return String(num).padStart(4, '0')
}

// 接班人员缺失时的台账展示口径：标「待补」，不沿用上一班（详见 handover-rules.ts）。
function successorOf(schedule: EntryRow): string {
  return String(schedule['接班人员'] ?? '').trim() || '待补'
}

function handoverStatusOf(gap: string | null, progressed: boolean): string {
  if (gap) {
    return gap.includes('接班人员') ? '待补充' : '待交接'
  }
  return progressed ? '交接中' : '待交接'
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  let failure = ''
  let committed = false
  try {
    committed = transact((base) => {
      const rows = base[key] ?? []
      const index = rows.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        failure = `没有找到编号为 ${id} 的${meta.entity}`
        return null
      }
      const current = String(rows[index].status)
      if (current === target) {
        failure = `${meta.entity}已经是「${target}」，不用重复操作`
        return null
      }
      const lastStatus = meta.statuses[meta.statuses.length - 1]
      const updated: EntryRow = {
        ...rows[index],
        status: target,
        pending: target !== lastStatus,
        abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
      }
      // 台账条目在交接闭环时封存，之后的口径调整不再动它
      if (key === 'handover') {
        updated['封存'] = target === '已交接'
        updated.pending = target !== '已交接'
      }
      const next = [...rows]
      next[index] = updated
      const updates: Record<string, EntryRow[]> = { [key]: next }
      // 检查站换岗提醒办结后，同步刷新关联台账的交接进度
      if (key === 'checkpoint') {
        const synced = syncHandoverProgress(base, updated, target)
        if (synced) {
          updates['handover'] = synced
        }
      }
      return updates
    })
  } catch {
    return { ok: false, message: `${meta.entity}落库失败，本次操作已整体回退` }
  }
  if (!committed) {
    return { ok: false, message: failure }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 检查站提醒 → 交接台账：按提醒上挂的台账编号找到条目，刷新交接进度。
// 换岗完成（回到正常检查）且现行口径无缺口时交接闭环并封存；有缺口只记进度不闭环。
function syncHandoverProgress(
  base: Record<string, EntryRow[]>,
  reminder: EntryRow,
  target: string,
): EntryRow[] | null {
  const ledgerCode = String(reminder['关联台账'] ?? '')
  if (!ledgerCode) {
    return null
  }
  const ledger = base['handover'] ?? []
  const index = ledger.findIndex((row) => String(row['台账编号'] ?? '') === ledgerCode)
  if (index < 0 || isSealed(ledger[index])) {
    return null
  }
  const scheduleCode = String(ledger[index]['关联排班'] ?? '')
  const schedule = (base['duty'] ?? []).find((row) => String(row['排班编号'] ?? '') === scheduleCode)
  const gap = schedule ? CURRENT_RULE.gapOf(schedule) : null
  const closed = target === '正常检查' && !gap
  const synced: EntryRow = closed
    ? {
        ...ledger[index],
        status: '已交接',
        pending: false,
        交接进度: '检查站换岗完成，交接闭环',
        封存: true,
      }
    : {
        ...ledger[index],
        交接进度: gap ? `检查站已换岗，${gap}，待补录` : `检查站提醒已处理（${target}）`,
      }
  const next = [...ledger]
  next[index] = synced
  return next
}

// 确认排班：排班状态流转 + 交接台账建档 + 检查站换岗提醒 + 巡护任务交接清单，
// 四件事在一个事务里落库，任何一侧写不进去就整体回退。
// 台账、提醒、清单都按「关联排班」去重，重复确认不重复建项；
// 状态检查在事务内基于最新存储做，并发确认只落一个结果。
export function confirmDutySchedule(id: number): ActionResult {
  const meta = moduleMeta('duty')
  const target = meta.actionTargets['确认排班']
  let failure = ''
  let committed = false
  try {
    committed = transact((base) => {
      const dutyRows = base['duty'] ?? []
      const index = dutyRows.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        failure = `没有找到编号为 ${id} 的${meta.entity}`
        return null
      }
      const current = String(dutyRows[index].status)
      if (current === target) {
        failure = `${meta.entity}已经是「${target}」，重复确认不会重复建项`
        return null
      }
      if (current !== '待确认') {
        failure = `只有「待确认」的${meta.entity}能确认，当前状态「${current}」`
        return null
      }
      const confirmed: EntryRow = { ...dutyRows[index], status: target, pending: true, abnormal: false }
      const dutyNext = [...dutyRows]
      dutyNext[index] = confirmed
      const ledger = upsertHandoverEntry(base['handover'] ?? [], confirmed)
      return {
        duty: dutyNext,
        handover: ledger.rows,
        checkpoint: upsertCheckpointReminder(base['checkpoint'] ?? [], confirmed, ledger.entry),
        patrol: upsertPatrolHandover(base['patrol'] ?? [], confirmed),
      }
    })
  } catch {
    return { ok: false, message: '确认排班落库失败，排班、台账、换岗提醒与巡护交接清单已整体回退' }
  }
  if (!committed) {
    return { ok: false, message: failure }
  }
  return { ok: true, message: `${meta.entity}已确认，交接台账、检查站换岗提醒与巡护任务交接清单已同步生成` }
}

// 台账按排班编号建档：已存在且未封存就按现行口径刷新，已封存沿用原记录，不存在才新建。
function upsertHandoverEntry(
  entries: EntryRow[],
  schedule: EntryRow,
): { rows: EntryRow[]; entry: EntryRow } {
  const scheduleCode = String(schedule['排班编号'] ?? '')
  const gap = CURRENT_RULE.gapOf(schedule)
  const existing = entries.find((row) => String(row['关联排班'] ?? '') === scheduleCode)
  if (existing) {
    if (isSealed(existing)) {
      return { rows: entries, entry: existing }
    }
    const updated: EntryRow = {
      ...existing,
      status: handoverStatusOf(gap, true),
      pending: true,
      值勤人员: schedule['值勤人员'],
      接班人员: successorOf(schedule),
      交接进度: gap ? `${gap}，待补录` : '换岗提醒已发至检查站',
      口径版本: CURRENT_RULE.version,
    }
    return { rows: entries.map((row) => (row === existing ? updated : row)), entry: updated }
  }
  const id = nextId(entries)
  const entry: EntryRow = {
    id,
    status: handoverStatusOf(gap, true),
    pending: true,
    abnormal: false,
    台账编号: `HAND-${pad(id)}`,
    值勤日期: schedule['值勤日期'],
    值勤时段: schedule['值勤时段'],
    值勤岗位: schedule['值勤岗位'],
    值勤人员: schedule['值勤人员'],
    接班人员: successorOf(schedule),
    交接进度: gap ? `${gap}，待补录` : '换岗提醒已发至检查站',
    口径版本: CURRENT_RULE.version,
    关联排班: scheduleCode,
    封存: false,
  }
  return { rows: [...entries, entry], entry }
}

// 检查站换岗提醒：同一排班只建一条，重复确认时只同步人员与日期。
function upsertCheckpointReminder(
  rows: EntryRow[],
  schedule: EntryRow,
  ledgerEntry: EntryRow,
): EntryRow[] {
  const scheduleCode = String(schedule['排班编号'] ?? '')
  const existing = rows.find((row) => String(row['关联排班'] ?? '') === scheduleCode)
  if (existing) {
    const updated: EntryRow = {
      ...existing,
      值守人员: successorOf(schedule),
      值班日期: schedule['值勤日期'],
      关联台账: ledgerEntry['台账编号'],
    }
    return rows.map((row) => (row === existing ? updated : row))
  }
  const id = nextId(rows)
  const reminder: EntryRow = {
    id,
    status: '等待换岗',
    pending: true,
    abnormal: false,
    站点编号: `CHEC-REM-${pad(id)}`,
    站点位置: schedule['值勤岗位'],
    值守人员: successorOf(schedule),
    检查项目: '换岗提醒',
    通行车辆数: '0',
    收缴火种数: '0',
    值班日期: schedule['值勤日期'],
    运行状态: '等待换岗',
    关联排班: scheduleCode,
    关联台账: ledgerEntry['台账编号'],
  }
  return [...rows, reminder]
}

// 巡护任务交接清单：同一排班只建一条，重复确认时只同步人员与日期。
function upsertPatrolHandover(rows: EntryRow[], schedule: EntryRow): EntryRow[] {
  const scheduleCode = String(schedule['排班编号'] ?? '')
  const successor = successorOf(schedule)
  const existing = rows.find((row) => String(row['关联排班'] ?? '') === scheduleCode)
  if (existing) {
    const updated: EntryRow = {
      ...existing,
      巡护员: successor,
      巡护日期: schedule['值勤日期'],
      巡护时段: schedule['值勤时段'],
    }
    return rows.map((row) => (row === existing ? updated : row))
  }
  const id = nextId(rows)
  const item: EntryRow = {
    id,
    status: '待执行',
    pending: true,
    abnormal: false,
    任务编号: `PATR-HO-${pad(id)}`,
    巡护区域: schedule['值勤岗位'],
    巡护路线: `交接：${String(schedule['值勤人员'] ?? '')} → ${successor}`,
    巡护员: successor,
    巡护日期: schedule['值勤日期'],
    巡护时段: schedule['值勤时段'],
    发现火情数: '0',
    任务状态: '待执行',
    关联排班: scheduleCode,
  }
  return [...rows, item]
}

// 交接口径调整后重算：未封存条目按现行口径重算状态与缺口并刷新口径版本，
// 已封存（已确认的历史）条目沿用原记录不动。
export function recalcHandoverLedger(): ActionResult {
  let recalced = 0
  let sealed = 0
  let committed = false
  try {
    committed = transact((base) => {
      const ledger = base['handover'] ?? []
      const byCode = new Map(
        (base['duty'] ?? []).map((row) => [String(row['排班编号'] ?? ''), row] as const),
      )
      const next = ledger.map((entry) => {
        if (isSealed(entry)) {
          sealed += 1
          return entry
        }
        const schedule = byCode.get(String(entry['关联排班'] ?? ''))
        if (!schedule) {
          return entry
        }
        const gap = CURRENT_RULE.gapOf(schedule)
        recalced += 1
        return {
          ...entry,
          status: handoverStatusOf(gap, entry.status === '交接中'),
          接班人员: successorOf(schedule),
          交接进度: gap
            ? `${gap}，待补录`
            : entry.status === '交接中'
              ? '换岗提醒已发至检查站'
              : '交接条件已具备，待登记交接',
          口径版本: CURRENT_RULE.version,
        }
      })
      return recalced > 0 ? { handover: next } : null
    })
  } catch {
    return { ok: false, message: '台账重算落库失败，已整体回退' }
  }
  if (!committed) {
    return { ok: false, message: '没有需要重算的未封存台账条目' }
  }
  return {
    ok: true,
    message: `已按${CURRENT_RULE.label}重算 ${recalced} 条未封存台账，${sealed} 条已封存历史沿用原记录`,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
