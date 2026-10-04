// 一键跑跨站交接链路校验：编译 -> 执行断言。
import { execFileSync } from 'node:child_process'

const buildDir = execFileSync('node', ['scripts/handover-compile.mjs'], { encoding: 'utf8' }).trim()
execFileSync('node', ['scripts/handover-e2e.mjs', buildDir], { stdio: 'inherit' })
