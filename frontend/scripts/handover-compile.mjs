// 用纯 JS 版 TypeScript 把交接相关源码即时编译为 CJS 到临时目录，
// 绕开本机 esbuild 二进制不匹配的问题；仅用于端到端逻辑校验。
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = new URL('../src/', import.meta.url).pathname
const out = mkdtempSync(join(tmpdir(), 'handover-build-'))

const targets = ['data', 'api']
mkdirSync(join(out, 'data'), { recursive: true })
mkdirSync(join(out, 'api'), { recursive: true })

for (const dir of targets) {
  for (const name of readdirSync(join(root, dir)).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(root, dir, name), 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: name,
    })
    // api 目录产物里把 '@/data/...' 别名改写成相对路径。
    const fixed =
      dir === 'api' ? outputText.replaceAll('require("@/data/', 'require("../data/') : outputText
    writeFileSync(join(out, dir, name.replace(/\.ts$/, '.js')), fixed, 'utf8')
  }
}

// types.js 是纯类型模块，CJS 下给一个空文件即可被 require 解析。
writeFileSync(join(out, 'data', 'types.js'), 'module.exports = {}\n', 'utf8')
console.log(out)
