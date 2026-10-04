// 交接链路的端到端逻辑校验：先用纯 JS 版 tsc 编译 src/data、src/api 到临时目录，
// 再用内存版 localStorage 运行真实的 local-store / handover 服务。
// 运行：node scripts/handover-e2e.mjs <编译产物根目录>
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = process.argv[2]
if (!root) {
  console.error('用法：node scripts/handover-e2e.mjs <编译产物根目录>')
  process.exit(2)
}

const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
}

const {
  listRows,
  HANDOVER_REMINDER_KEY,
  HANDOVER_CHECKLIST_KEY,
  commitAll,
} = require(join(root, 'data/local-store.js'))
const { buildLedger } = require(join(root, 'data/handover.js'))
const {
  confirmHandover,
  runDutyAction,
} = require(join(root, 'api/handover-service.js'))

const out = []
const log = (...a) => out.push(a.join(' '))
const assert = (cond, msg) => {
  if (!cond) throw new Error('断言失败：' + msg)
}

// 1. 台账归纳：未封存接班链推导 + 末班待补 + 历史缺项沿用
const ledger = buildLedger(listRows('duty'))
const find = (id) => ledger.find((x) => x.sourceId === id)
const l4 = find(4) // 青松岭早班，下一班=郑海峰
assert(l4 && !l4.封存, 'DUTY-0004 未封存')
assert(l4.接班人员 === '郑海峰', 'DUTY-0004 应沿接班链推出郑海峰，实际=' + l4?.接班人员)
assert(l4.交接未完成, 'DUTY-0004 无交接记录应属未完成')
const l5 = find(5) // 青松岭晚班，后续无排班
assert(l5 && l5.接班人员 === '待补' && l5.接班人缺项, 'DUTY-0005 末班无接班应标待补')
const l2 = find(2) // 历史已确认且接班为空
assert(l2 && l2.封存 && l2.接班人员 === '待补（原记录缺项）', 'DUTY-0002 历史缺项应沿用并标注，实际=' + l2?.接班人员)
const l1 = find(1)
assert(l1 && l1.封存 && l1.口径 === '历史沿用', 'DUTY-0001 已封存历史沿用')
const l6 = find(6)
assert(l6 && l6.接班人员 === '何立群', 'DUTY-0006 原栏有接班应采信')
log('台账归纳：通过（接班链/待补/历史缺项/口径标注）')

// 2. 无同检查站 -> 确认失败且不落任何一侧
const beforeRem = listRows(HANDOVER_REMINDER_KEY).length
const r9 = await confirmHandover(9) // 黑松林瞭望口，无对应检查站
assert(!r9.ok, '无同检查站应拒绝确认')
assert(listRows(HANDOVER_REMINDER_KEY).length === beforeRem, '失败时提醒侧不得落库')
assert(listRows(HANDOVER_CHECKLIST_KEY).length === beforeRem, '失败时清单侧不得落库')
assert(listRows('duty').find((x) => Number(x.id) === 9).status === '待确认', '失败时排班不得封存')
log('无同站整体回退：通过')

// 3. 待补确认 -> 三处同事务落库，封存为已确认
const r8 = await confirmHandover(8) // 南天门，吴建平->赵敏，无交接记录 => 接班已到人但记录待补
assert(r8.ok, r8.message)
assert(listRows('duty').find((x) => Number(x.id) === 8).status === '已确认', '待闭环班次封存为已确认')
const rem8 = listRows(HANDOVER_REMINDER_KEY).find((x) => Number(x['来源排班Id']) === 8)
const cl8 = listRows(HANDOVER_CHECKLIST_KEY).find((x) => Number(x['来源排班Id']) === 8)
assert(rem8 && rem8.status === '待换岗', '提醒应为待换岗，实际=' + rem8?.status)
assert(cl8 && cl8.清单状态 === '待交接', '清单应为待交接，实际=' + cl8?.清单状态)
log('记录待补确认三处落库：通过')

// 3b. 接班待补 -> 青松岭晚班（末班无后续排班）
const r5 = await confirmHandover(5)
assert(r5.ok, r5.message)
const rem5 = listRows(HANDOVER_REMINDER_KEY).find((x) => Number(x['来源排班Id']) === 5)
assert(rem5 && rem5.status === '接班待补', '提醒应为接班待补')
log('接班待补确认三处落库：通过')

// 4. 完整交接确认 -> 已完成换岗 / 已交接
const r6 = await confirmHandover(6) // 白桦坡白班，孙岚->何立群，原排班已填接班且重算口径完整
assert(r6.ok, r6.message)
assert(listRows('duty').find((x) => Number(x.id) === 6).status === '已交接', '完整交接应封存为已交接')
const rem6 = listRows(HANDOVER_REMINDER_KEY).find((x) => Number(x['来源排班Id']) === 6)
assert(rem6 && rem6.status === '已完成换岗', '提醒应为已完成换岗')
log('完整交接三处落库：通过')

// 5. 重复确认幂等
const remCount = listRows(HANDOVER_REMINDER_KEY).length
const r6again = await confirmHandover(6)
assert(!r6again.ok && listRows(HANDOVER_REMINDER_KEY).length === remCount, '重复确认不得重复建项')
log('重复确认幂等：通过')

// 6. 并发确认同一班次：只落一个结果
const [a, b] = await Promise.all([confirmHandover(4), confirmHandover(4)])
const hits4 = listRows(HANDOVER_REMINDER_KEY).filter((x) => Number(x['来源排班Id']) === 4).length
assert(hits4 === 1, '并发确认只应生成一条提醒，实际=' + hits4)
assert(a.ok || b.ok, '并发中至少一个成功')
log('并发确认只落一个结果：通过')

// 7. 记录交接动作 -> 检查站提醒交接进度同步刷新
const waitRow = listRows(HANDOVER_REMINDER_KEY).find((x) => Number(x['来源排班Id']) === 8)
assert(waitRow.status === '待换岗', '前置：8号提醒为待换岗，实际=' + waitRow.status)
const duty = listRows('duty').map((x) =>
  Number(x.id) === 8 ? { ...x, 交接记录: '重点车辆核查设备完好，台账已移交。' } : x,
)
commitAll([{ key: 'duty', rows: duty }])
const act = runDutyAction('记录交接', 8)
assert(act.ok, act.message)
const synced = listRows(HANDOVER_REMINDER_KEY).find((x) => Number(x['来源排班Id']) === 8)
assert(synced.status === '已完成换岗', '记录交接后提醒应刷新为已完成换岗，实际=' + synced.status)
const syncedCl = listRows(HANDOVER_CHECKLIST_KEY).find((x) => Number(x['来源排班Id']) === 8)
assert(syncedCl.清单状态 === '已交接', '清单应同步为已交接')
log('检查站提醒同步刷新交接进度：通过')

// 7b. 历史封存缺项班次补做交接后，提醒同样能闭环（不因历史缺项卡在待补）
const r2 = await confirmHandover(2) // 已确认、接班为空（原记录缺项）
assert(r2.ok, r2.message)
const rem2 = listRows(HANDOVER_REMINDER_KEY).find((x) => Number(x['来源排班Id']) === 2)
assert(rem2 && rem2.status === '接班待补', '历史缺项确认后提醒应为接班待补，实际=' + rem2?.status)
const duty2 = listRows('duty').map((x) =>
  Number(x.id) === 2
    ? { ...x, 接班人员: '马长青', 交接记录: '补登：夜间值守与设备清点已完成。' }
    : x,
)
commitAll([{ key: 'duty', rows: duty2 }])
const act2 = runDutyAction('记录交接', 2)
assert(act2.ok, act2.message)
const rem2done = listRows(HANDOVER_REMINDER_KEY).find((x) => Number(x['来源排班Id']) === 2)
assert(rem2done.status === '已完成换岗', '历史缺项补齐交接后提醒应闭环，实际=' + rem2done.status)
log('历史缺项补交接闭环：通过')

// 8. 落库失败整体回退：让 setItem 抛配额错，缓存与两侧数据保持失败前一致
const dutyBefore = JSON.stringify(listRows('duty'))
const remBefore = JSON.stringify(listRows(HANDOVER_REMINDER_KEY))
const clBefore = JSON.stringify(listRows(HANDOVER_CHECKLIST_KEY))
globalThis.window.localStorage.setItem = () => {
  throw new DOMException('QuotaExceededError')
}
const fail = await confirmHandover(7)
assert(!fail.ok && fail.message.includes('整体回退'), '配额失败应回退并提示')
assert(JSON.stringify(listRows('duty')) === dutyBefore, '回退后排班与失败前一致')
assert(JSON.stringify(listRows(HANDOVER_REMINDER_KEY)) === remBefore, '回退后提醒与失败前一致')
assert(JSON.stringify(listRows(HANDOVER_CHECKLIST_KEY)) === clBefore, '回退后清单与失败前一致')
log('落库失败整体回退：通过')

console.log(out.join('\n'))
