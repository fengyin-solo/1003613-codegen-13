import type { EntryRow } from './types'

// 跨站交接台账的领域口径：
// 已封存班次沿用原记录，未封存班次按新规则（NEW_RULE_VERSION）重算。
// 取数路径与值勤排班、检查站一致，全部来自本地库的 EntryRow。

export const NEW_RULE_VERSION = 'v2-跨站交接'

// 已确认历史：这些状态视为已封存，台账不再重算，只沿用原记录。
export const SEALED_STATUSES = ['已确认', '已交接', '已调班']

// 换岗时段的标准顺序，用于在同一岗位内串出接班链。
export const SHIFT_SLOTS = [
  { key: '早班', start: '06:00' },
  { key: '白班', start: '08:00' },
  { key: '午班', start: '12:00' },
  { key: '晚班', start: '16:00' },
  { key: '夜班', start: '20:00' },
  { key: '零点班', start: '00:00' },
] as const

export const PENDING_SUPPLY = '待补'

export type HandoverLedgerItem = {
  sourceId: number
  排班编号: string
  值勤日期: string
  值勤时段: string
  值勤岗位: string
  值勤人员: string
  接班人员: string
  交接记录: string
  交接状态: string
  封存: boolean
  口径: string
  接班人缺项: boolean
  交接未完成: boolean
  记录待补: boolean
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

// 样例占位内容与空白一样视为缺项；「待补」是显式有效标注，不能再当空值处理。
export function isMeaningful(value: unknown): boolean {
  const raw = text(value)
  return raw !== '' && !raw.includes('样例')
}

export function isSealed(status: unknown): boolean {
  return SEALED_STATUSES.includes(text(status))
}

// 从“晚班（16:00-20:00）”这类时段文案里识别标准班次键。
export function slotKey(slotText: string): string {
  const raw = text(slotText)
  const hit = SHIFT_SLOTS.find((slot) => raw.startsWith(slot.key) || raw.includes(slot.key))
  return hit ? hit.key : raw || '未排时段'
}

export function slotOrder(slotText: string): number {
  const key = slotKey(slotText)
  const index = SHIFT_SLOTS.findIndex((slot) => slot.key === key)
  // 识别不出的标准班次排到已知班次之前，避免把末班的下一班误判成某个未排时段记录。
  return index >= 0 ? index : -1
}

type DutySlim = {
  id: number
  code: string
  date: string
  slot: string
  post: string
  person: string
  successor: string
  handover: string
  status: string
  row: EntryRow
}

function slim(row: EntryRow): DutySlim {
  return {
    id: Number(row.id),
    code: text(row['排班编号']),
    date: text(row['值勤日期']),
    slot: text(row['值勤时段']),
    post: text(row['值勤岗位']),
    person: text(row['值勤人员']),
    successor: text(row['接班人员']),
    handover: text(row['交接记录']),
    status: text(row.status),
    row,
  }
}

function nextShiftSuccessor(target: DutySlim, all: DutySlim[]): string {
  // 同值勤日期、同岗位（检查站），按时段顺序取本班的下一班值勤人员做接班人。
  const later = all
    .filter((item) => item.date === target.date && item.post === target.post && item.id !== target.id)
    .filter((item) => slotOrder(item.slot) > slotOrder(target.slot))
    .sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot) || a.id - b.id)
  return later.length ? later[0].person : ''
}

// 未完成交接记录的归纳：未封存按新口径核对接班人与交接事项；已封存沿用历史状态。
function resolveHandoverStatus(sealed: boolean, hasSuccessor: boolean, hasNote: boolean): string {
  if (!hasSuccessor) {
    return sealed ? '未完成交接（历史缺项）' : '未完成交接·接班待补'
  }
  if (!hasNote) {
    return sealed ? '交接记录不全（历史沿用）' : '未完成交接·记录待补'
  }
  return sealed ? '已交接（历史沿用）' : '已完成交接'
}

// 接班栏是否真实缺项：空/样例占位为缺，纯「待补」也是缺（它是缺项标注，不是人名）。
function successorMissing(value: string): boolean {
  const raw = value.trim()
  return raw === '' || raw === PENDING_SUPPLY || raw.includes('样例')
}

export function buildLedger(dutyRows: EntryRow[]): HandoverLedgerItem[] {
  const all = dutyRows.map(slim)
  return all
    .map((item) => {
      const sealed = isSealed(item.status)
      const hadSuccessor = !successorMissing(item.successor)
      let successor = item.successor
      let note = item.handover

      if (sealed) {
        // 已确认历史沿用原记录：缺接班人员只做缺项标注，不改写原排班。
        if (!hadSuccessor) {
          successor = `${PENDING_SUPPLY}（原记录缺项）`
        }
        if (!isMeaningful(note) && item.status === '已调班') {
          note = '调班：原班次人员已调整，待下一班确认'
        }
      } else {
        // 未封存按新规则重算：原接班栏有效则采信，否则沿接班链推一班，推不出标待补。
        if (!hadSuccessor) {
          const inferred = nextShiftSuccessor(item, all)
          successor = isMeaningful(inferred) && !successorMissing(inferred) ? inferred : PENDING_SUPPLY
        }
        if (!isMeaningful(note)) {
          note = successorMissing(successor)
            ? '未封存：接班人员待补，交接事项暂挂'
            : `未封存：待与${successor}现场交接`
        }
      }

      // 缺项以原始接班栏为准：重算补注出的「待补」「待补（原记录缺项）」都算缺项。
      const missingSuccessor = sealed ? !hadSuccessor : successorMissing(successor)
      // 未封存班次的交接事项由新规则补注，属于待办提示，不计为已完成交接。
      const missingNote = sealed ? !isMeaningful(note) : !isMeaningful(item.handover)
      const status = resolveHandoverStatus(sealed, !missingSuccessor, !missingNote)

      return {
        sourceId: item.id,
        排班编号: item.code,
        值勤日期: item.date,
        值勤时段: item.slot,
        值勤岗位: item.post,
        值勤人员: item.person,
        接班人员: successor,
        交接记录: note,
        交接状态: status,
        封存: sealed,
        口径: sealed ? '历史沿用' : `新规则重算（${NEW_RULE_VERSION}）`,
        接班人缺项: missingSuccessor,
        交接未完成: missingSuccessor || missingNote,
        记录待补: !sealed && !missingSuccessor && missingNote,
      }
    })
    .sort(
      (a, b) =>
        a.值勤日期.localeCompare(b.值勤日期) ||
        a.值勤岗位.localeCompare(b.值勤岗位) ||
        slotOrder(a.值勤时段) - slotOrder(b.值勤时段) ||
        a.sourceId - b.sourceId,
    )
}

export type LedgerGroup = {
  key: string
  值勤日期: string
  值勤时段: string
  值勤岗位: string
  items: HandoverLedgerItem[]
  交接未完成: boolean
  接班人缺项: boolean
  全部封存: boolean
}

// 按值勤日期、时段、岗位归纳成跨站交接台账分组。
export function groupLedger(items: HandoverLedgerItem[]): LedgerGroup[] {
  const map = new Map<string, LedgerGroup>()
  for (const item of items) {
    const key = `${item.值勤日期}|${item.值勤时段}|${item.值勤岗位}`
    const existed = map.get(key)
    if (existed) {
      existed.items.push(item)
      existed.交接未完成 = existed.交接未完成 || item.交接未完成
      existed.接班人缺项 = existed.接班人缺项 || item.接班人缺项
      existed.全部封存 = existed.全部封存 && item.封存
      continue
    }
    map.set(key, {
      key,
      值勤日期: item.值勤日期,
      值勤时段: item.值勤时段,
      值勤岗位: item.值勤岗位,
      items: [item],
      交接未完成: item.交接未完成,
      接班人缺项: item.接班人缺项,
      全部封存: item.封存,
    })
  }
  return [...map.values()].sort(
    (a, b) =>
      a.值勤日期.localeCompare(b.值勤日期) ||
      slotOrder(a.值勤时段) - slotOrder(b.值勤时段) ||
      a.值勤岗位.localeCompare(b.值勤岗位),
  )
}

// 检查站取数路径：排班岗位与检查站“站点位置”同名即视为同站，
// 与排班页共用 listRows('checkpoint')，不另开取数口径。
export function matchCheckpoint(post: string, checkpointRows: EntryRow[]): EntryRow | undefined {
  const target = text(post)
  return checkpointRows.find((row) => text(row['站点位置']) === target)
}
