import type { EntryRow } from './types'

// 交接口径：判断一条值勤排班的交接是否闭环的规则，按版本留存。
// 口径调整 = 在这里加一个新版本并把 CURRENT_RULE 指过去；
// 未封存的台账条目会按现行口径重算，已封存（已确认的历史）条目沿用原记录不动。
export type HandoverRule = {
  version: string
  label: string
  // 返回 null 表示交接闭环；否则返回缺口说明，台账按缺口归纳状态。
  gapOf(row: EntryRow): string | null
}

// 历史口径 v1：交接记录填了就算完成，不核对接班人员。
const RULE_V1: HandoverRule = {
  version: 'v1',
  label: '旧口径：交接记录非空即算交接完成',
  gapOf(row) {
    return String(row['交接记录'] ?? '').trim() ? null : '交接记录缺失'
  },
}

// 现行口径 v2：接班人员与交接记录都要落实才算闭环。
// 缺失接班人员的旧排班一律标「待补」，不沿用上一班——沿用会凭空捏造
// 并未发生的接班安排，标待补才能把缺口摆到台账上等补录。
const RULE_V2: HandoverRule = {
  version: 'v2',
  label: '现行口径：接班人员与交接记录均落实才算交接闭环',
  gapOf(row) {
    const gaps: string[] = []
    if (!String(row['接班人员'] ?? '').trim()) gaps.push('接班人员缺失')
    if (!String(row['交接记录'] ?? '').trim()) gaps.push('交接记录缺失')
    return gaps.length ? gaps.join('、') : null
  },
}

export const HANDOVER_RULES: HandoverRule[] = [RULE_V1, RULE_V2]

// 现行口径：调口径只改这一处，台账重算、新建台账都走它。
export const CURRENT_RULE: HandoverRule = RULE_V2

// 台账条目的封存标记：已交接（交接闭环）即封存，之后的口径调整不再动它。
export function isSealed(entry: EntryRow): boolean {
  return entry['封存'] === true
}
