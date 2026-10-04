import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 跨站交接相关的派生台账，沿用同一份本地库、同一个取数路径，只多占几个键。
export const HANDOVER_REMINDER_KEY = 'handover-reminder'
export const HANDOVER_CHECKLIST_KEY = 'handover-checklist'

export type StoreChange = { key: string; rows: EntryRow[] }

export function saveRows(key: string, rows: EntryRow[]): void {
  commitAll([{ key, rows }])
}

// 多键一次落库：先在内存里拼出整库并整体序列化校验，
// 再写 localStorage，最后才切换内存缓存——
// 任一侧序列化或配额写入失败，缓存与已存数据都保持原样，即整体回退。
export function commitAll(changes: StoreChange[]): void {
  const next: Record<string, EntryRow[]> = { ...allRows() }
  for (const change of changes) {
    next[change.key] = change.rows
  }
  const encoded = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, encoded)
    } catch (error) {
      // 落库失败：不切换 cache，调用方与后续读取看到的仍是旧数据。
      throw new Error(
        `交接数据落库失败，已整体回退：${error instanceof Error ? error.message : '存储不可用'}`,
      )
    }
  }
  cache = next
}

export function nextRowId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
