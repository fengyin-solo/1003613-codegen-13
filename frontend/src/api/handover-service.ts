import { moduleMeta } from './local-service'
import {
  HANDOVER_CHECKLIST_KEY,
  HANDOVER_REMINDER_KEY,
  commitAll,
  listRows,
  nextRowId,
} from '@/data/local-store'
import {
  buildLedger,
  matchCheckpoint,
  slotKey,
} from '@/data/handover'
import type { ActionResult, EntryRow } from '@/data/types'

// 跨站交接的应用服务：
// 视图确认时在同一事务里落三处——排班封存、检查站换岗提醒、巡护任务交接清单；
// 任一侧校验或落库失败整体回退。写操作全局串行，同班次并发确认只落一个结果。

const DUTY_KEY = 'duty'
const CHECKPOINT_KEY = 'checkpoint'

type ConfirmKind = '已完成换岗' | '接班待补' | '待换岗'

function kindOf(ledger: ReturnType<typeof buildLedger>[number]): ConfirmKind {
  // 接班人缺项（含“待补”与历史缺项标注）一律不闭环；
  // 未封存班次再叠加“交接事项未齐”时为待换岗。
  if (ledger.接班人缺项) return '接班待补'
  if (!ledger.封存 && ledger.交接未完成) return '待换岗'
  return '已完成换岗'
}

function isCompleteKind(kind: ConfirmKind): boolean {
  return kind === '已完成换岗'
}

function nextIdentity(rows: EntryRow[], prefix: string): { id: number; code: string } {
  const id = nextRowId(rows)
  return { id, code: `${prefix}-${String(id).padStart(4, '0')}` }
}

function reminderFrom(
  ledger: ReturnType<typeof buildLedger>[number],
  checkpoint: EntryRow,
  kind: ConfirmKind,
  reminders: EntryRow[],
): EntryRow {
  const complete = isCompleteKind(kind)
  const identity = nextIdentity(reminders, 'REM')
  const content =
    kind === '已完成换岗'
      ? `${ledger.值勤岗位}${slotKey(ledger.值勤时段)}换岗已闭环，请检查站核放通行。`
      : kind === '接班待补'
        ? `${ledger.值勤岗位}${slotKey(ledger.值勤时段)}接班人员待补，请检查站暂缓离岗、保持在岗值守。`
        : `${ledger.值勤岗位}${slotKey(ledger.值勤时段)}接班已到人、交接事项待现场确认，请检查站安排逐项移交。`
  return {
    id: identity.id,
    status: kind,
    pending: !complete,
    abnormal: kind === '接班待补',
    提醒编号: identity.code,
    来源排班Id: ledger.sourceId,
    来源排班: ledger.排班编号,
    检查站编号: String(checkpoint['站点编号'] ?? ''),
    站点位置: ledger.值勤岗位,
    值班日期: ledger.值勤日期,
    换岗时段: ledger.值勤时段,
    交班人员: ledger.值勤人员,
    接班人员: ledger.接班人员,
    交接进度: kind,
    提醒内容: content,
  }
}

function checklistFrom(
  ledger: ReturnType<typeof buildLedger>[number],
  kind: ConfirmKind,
  checklists: EntryRow[],
): EntryRow {
  const complete = isCompleteKind(kind)
  const checklistStatus = kind === '已完成换岗' ? '已交接' : kind === '接班待补' ? '接班待补' : '待交接'
  const identity = nextIdentity(checklists, 'PATR-H')
  return {
    id: identity.id,
    status: checklistStatus,
    pending: !complete,
    abnormal: kind === '接班待补',
    清单编号: identity.code,
    来源排班Id: ledger.sourceId,
    来源排班: ledger.排班编号,
    巡护区域: ledger.值勤岗位,
    巡护日期: ledger.值勤日期,
    交接时段: ledger.值勤时段,
    交班巡护员: ledger.值勤人员,
    接班巡护员: ledger.接班人员,
    交接事项: ledger.交接记录,
    清单状态: checklistStatus,
  }
}

function findBySource(rows: EntryRow[], sourceId: number): EntryRow | undefined {
  return rows.find((row) => Number(row['来源排班Id']) === sourceId)
}

// 检查站提醒同步刷新交接进度：排班后续动作（记录交接、申请调班）后回写派生台账。
function progressOf(
  dutyStatus: string,
  ledger: ReturnType<typeof buildLedger>[number] | undefined,
): { progress: ConfirmKind | '调班关闭'; complete: boolean; missing: boolean; closed: boolean } {
  if (dutyStatus === '已调班') {
    return { progress: '调班关闭', complete: false, missing: false, closed: true }
  }
  if (dutyStatus === '已交接') {
    return { progress: '已完成换岗', complete: true, missing: false, closed: false }
  }
  // 封存态的历史缺项允许后补交接：状态进入已交接即闭环；已确认则只反映是否还有真实缺项。
  const missing = ledger ? ledger.接班人缺项 : false
  const waiting = !missing && (dutyStatus === '已确认' ? Boolean(ledger?.交接未完成) : true)
  const progress = missing ? '接班待补' : waiting ? '待换岗' : '已完成换岗'
  return { progress, complete: progress === '已完成换岗', missing, closed: false }
}

function syncReminderRow(
  row: EntryRow,
  duty: EntryRow | undefined,
  ledger: ReturnType<typeof buildLedger>[number] | undefined,
): EntryRow {
  if (!duty) {
    return row
  }
  const { progress, complete, missing, closed } = progressOf(String(duty.status), ledger)
  return {
    ...row,
    status: progress,
    交接进度: progress,
    交班人员: ledger?.值勤人员 ?? row['交班人员'],
    接班人员: ledger?.接班人员 ?? row['接班人员'],
    pending: !complete && !closed,
    abnormal: missing || closed,
  }
}

function syncChecklistRow(
  row: EntryRow,
  duty: EntryRow | undefined,
  ledger: ReturnType<typeof buildLedger>[number] | undefined,
): EntryRow {
  if (!duty) {
    return row
  }
  const { complete, missing, closed } = progressOf(String(duty.status), ledger)
  const nextStatus = closed ? '调班关闭' : complete ? '已交接' : missing ? '接班待补' : '待交接'
  return {
    ...row,
    status: nextStatus,
    清单状态: nextStatus,
    交班巡护员: ledger?.值勤人员 ?? row['交班巡护员'],
    接班巡护员: ledger?.接班人员 ?? row['接班巡护员'],
    交接事项: ledger?.交接记录 ?? row['交接事项'],
    pending: !complete && !closed,
    abnormal: missing || closed,
  }
}

export function syncHandoverProgress(): void {
  const dutyRows = listRows(DUTY_KEY)
  const dutyById = new Map(dutyRows.map((row) => [Number(row.id), row]))
  const ledgerMap = new Map(buildLedger(dutyRows).map((item) => [item.sourceId, item]))
  const reminders = listRows(HANDOVER_REMINDER_KEY)
  const checklists = listRows(HANDOVER_CHECKLIST_KEY)
  const nextReminders = reminders.map((row) => {
    const sourceId = Number(row['来源排班Id'])
    return syncReminderRow(row, dutyById.get(sourceId), ledgerMap.get(sourceId))
  })
  const nextChecklists = checklists.map((row) => {
    const sourceId = Number(row['来源排班Id'])
    return syncChecklistRow(row, dutyById.get(sourceId), ledgerMap.get(sourceId))
  })
  const changed =
    JSON.stringify(nextReminders) !== JSON.stringify(reminders) ||
    JSON.stringify(nextChecklists) !== JSON.stringify(checklists)
  if (changed) {
    commitAll([
      { key: HANDOVER_REMINDER_KEY, rows: nextReminders },
      { key: HANDOVER_CHECKLIST_KEY, rows: nextChecklists },
    ])
  }
}

// 写操作全局串行：任一确认都排在链尾执行，杜绝两个确认交错写导致的重复建项。
let writeChain: Promise<ActionResult> = Promise.resolve({ ok: true, message: '' })
const inflight = new Map<number, Promise<ActionResult>>()

function enqueue(task: () => ActionResult): Promise<ActionResult> {
  const run = writeChain.then(
    () =>
      new Promise<ActionResult>((resolve) => {
        // 让出一个宏任务，使并发点击能先全部进入在途合并表。
        setTimeout(() => {
          let result: ActionResult
          try {
            result = task()
          } catch (error) {
            result = {
              ok: false,
              message: error instanceof Error ? error.message : '交接确认失败，已整体回退',
            }
          }
          resolve(result)
        }, 120)
      }),
  )
  writeChain = run.then(
    () => ({ ok: true, message: '' }),
    () => ({ ok: true, message: '' }),
  )
  return run
}

function doConfirm(sourceId: number): ActionResult {
  const dutyRows = listRows(DUTY_KEY)
  const target = dutyRows.find((row) => Number(row.id) === sourceId)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${sourceId} 的值勤排班，已终止确认` }
  }

  // 幂等：派生台账已建过项的，重复确认直接拒绝，不再重复落库。
  if (findBySource(listRows(HANDOVER_REMINDER_KEY), sourceId)) {
    return { ok: false, message: '该班次已完成视图确认，未重复生成提醒与交接清单' }
  }

  const ledger = buildLedger(dutyRows).find((item) => item.sourceId === sourceId)
  if (!ledger) {
    return { ok: false, message: '跨站交接台账归纳失败，已终止确认' }
  }

  // 顺着排班同检查站的取数路径校验：岗位必须能在检查站取到同站记录。
  const checkpoint = matchCheckpoint(ledger.值勤岗位, listRows(CHECKPOINT_KEY))
  if (!checkpoint) {
    return {
      ok: false,
      message: `岗位「${ledger.值勤岗位}」未匹配到同检查站记录，确认已整体回退（提醒与清单均未落库）`,
    }
  }

  const kind = kindOf(ledger)
  // 已完成换岗才封存为「已交接」；接班待补/事项待补先封存为「已确认」，
  // 补齐后由排班“记录交接”动作闭环（已确认历史自此沿用）。
  const sealedStatus = kind === '已完成换岗' ? '已交接' : '已确认'

  // 先在副本上构造三处变更，全部就绪后才一次性提交。
  const nextDuty = dutyRows.map((row) =>
    Number(row.id) === sourceId
      ? { ...row, status: sealedStatus, pending: true, abnormal: kind === '接班待补' }
      : row,
  )
  // 提醒与清单按封存前（新规则重算）的台账快照建项，
  // 确保推导出的接班人与待补提示不被“封存即沿用”口径覆盖。
  const reminders = [...listRows(HANDOVER_REMINDER_KEY)]
  const checklists = [...listRows(HANDOVER_CHECKLIST_KEY)]
  reminders.push(reminderFrom(ledger, checkpoint, kind, reminders))
  checklists.push(checklistFrom(ledger, kind, checklists))

  // commitAll 任一侧失败会抛错且不动缓存，由 enqueue 捕获后按整体回退回传。
  commitAll([
    { key: DUTY_KEY, rows: nextDuty },
    { key: HANDOVER_REMINDER_KEY, rows: reminders },
    { key: HANDOVER_CHECKLIST_KEY, rows: checklists },
  ])

  const suffix = '检查站换岗提醒、巡护任务交接清单已在同一事务生成。'
  const message =
    kind === '已完成换岗'
      ? `「${ledger.排班编号}」已封存为「已交接」，跨站交接闭环。${suffix}`
      : kind === '接班待补'
        ? `「${ledger.排班编号}」已按现状封存为「已确认」：接班人员待补，已生成检查站待补提醒与待交接清单，补齐后执行“记录交接”闭环。`
        : `「${ledger.排班编号}」已封存为「已确认」：接班已到人、交接事项待现场确认，已生成待换岗提醒与待交接清单。`
  return { ok: true, message }
}

// 视图确认：同一班次的并发确认复用同一个在途 Promise，只落一个结果。
export function confirmHandover(sourceId: number): Promise<ActionResult> {
  const existed = inflight.get(sourceId)
  if (existed) {
    return existed
  }
  const pending = enqueue(() => doConfirm(sourceId))
  inflight.set(sourceId, pending)
  pending.finally(() => inflight.delete(sourceId))
  return pending
}

// 值勤排班页原有动作改走同一事务口径：动作落库后同步刷新检查站提醒的交接进度。
export function runDutyAction(action: string, sourceId: number): ActionResult {
  const meta = moduleMeta(DUTY_KEY)
  const targetStatus = meta.actionTargets[action]
  if (!targetStatus) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(DUTY_KEY)
  const index = rows.findIndex((row) => Number(row.id) === sourceId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${sourceId} 的${meta.entity}` }
  }
  if (String(rows[index].status) === targetStatus) {
    return { ok: false, message: `${meta.entity}已经是「${targetStatus}」，不用重复操作` }
  }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    status: targetStatus,
    pending: targetStatus !== meta.statuses[meta.statuses.length - 1],
    abnormal: ['申请调班'].includes(action),
  }
  try {
    commitAll([{ key: DUTY_KEY, rows: next }])
    syncHandoverProgress()
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '排班动作落库失败，已整体回退' }
  }
  return { ok: true, message: `${meta.entity}已${action}，检查站换岗提醒的交接进度已同步刷新` }
}
