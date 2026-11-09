#!/usr/bin/env node
/**
 * 把仓库根的 index.html + dist/ 合并成 Capacitor 的 webDir（apk/www/）。
 *
 * 为什么需要这一步：Vue CLI 的 copy.js 把 index.html 从 dist/ 移到了仓库根，
 * dist/ 内反而没有入口文件，所以 Capacitor 的 webDir 不能直接指向 dist/。
 * 该脚本只做复制，不重写任何字节（保留已提交的 dist/ 里的离线补丁）。
 */
import { cp, copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const selfDir = path.dirname(fileURLToPath(import.meta.url))
const apkDir = path.resolve(selfDir, '..')
const repoRoot = path.resolve(apkDir, '..')
const wwwDir = path.join(apkDir, 'www')
const srcIndex = path.join(repoRoot, 'index.html')
const srcDist = path.join(repoRoot, 'dist')

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (!(await exists(srcIndex))) throw new Error(`缺少入口文件：${srcIndex}`)
  if (!(await exists(srcDist))) throw new Error(`缺少静态资源目录：${srcDist}`)

  const html = await readFile(srcIndex, 'utf8')
  const refs = [
    ...new Set(
      [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
        .map(m => m[1].split('?')[0].split('#')[0])
        .filter(u => u && !/^(?:https?:)?\/\//i.test(u) && !/^(?:data|blob|javascript):/i.test(u))
    ),
  ]
  const missing = []
  for (const ref of refs) {
    const rel = ref.replace(/^\.?\//, '')
    if (!(await exists(path.join(repoRoot, rel)))) missing.push(ref)
  }
  if (missing.length) {
    throw new Error(`index.html 引用了不存在的资源：${missing.join(', ')}`)
  }

  await rm(wwwDir, { recursive: true, force: true })
  await mkdir(wwwDir, { recursive: true })
  await copyFile(srcIndex, path.join(wwwDir, 'index.html'))
  await cp(srcDist, path.join(wwwDir, 'dist'), { recursive: true })

  console.log(`[build-www] OK -> ${path.relative(repoRoot, wwwDir)}`)
  console.log(`[build-www] 入口资源校验通过：${refs.length} 个本地引用`)
}

main().catch(err => {
  console.error(`[build-www] FAILED: ${err.message}`)
  process.exit(1)
})
