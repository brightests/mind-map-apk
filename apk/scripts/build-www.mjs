#!/usr/bin/env node
/**
 * 把仓库根的 index.html + dist/ 合并成 Capacitor 的 webDir（apk/www/）。
 *
 * 为什么需要这一步：Vue CLI 的 copy.js 把 index.html 从 dist/ 移到了仓库根，
 * dist/ 内反而没有入口文件，所以 Capacitor 的 webDir 不能直接指向 dist/。
 *
 * 对仓库根 index.html 与 dist/ 一律只读，保留已提交的离线补丁；唯一的写入
 * 发生在生成物 apk/www/ 里：复制 APK 专用的 mobile.css，并在 www/index.html
 * 的 </head> 前插一个 <link>，让窄屏覆盖层只作用于 Android WebView。
 */
import { cp, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const selfDir = path.dirname(fileURLToPath(import.meta.url))
const apkDir = path.resolve(selfDir, '..')
const repoRoot = path.resolve(apkDir, '..')
const wwwDir = path.join(apkDir, 'www')
const srcIndex = path.join(repoRoot, 'index.html')
const srcDist = path.join(repoRoot, 'dist')
const srcMobileCss = path.join(apkDir, 'mobile.css')

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
  if (!(await exists(srcMobileCss))) throw new Error(`缺少窄屏覆盖层：${srcMobileCss}`)

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
  await copyFile(srcMobileCss, path.join(wwwDir, 'mobile.css'))

  // 幂等注入：只改 www 产物，仓库根 index.html 保持原样（桌面 / Docker 不受影响）。
  const wwwIndex = path.join(wwwDir, 'index.html')
  let outHtml = await readFile(wwwIndex, 'utf8')
  outHtml = outHtml.replace(
    /<link\b[^>]*href=["'](?:\.\/)?mobile\.css["'][^>]*>\s*/gi,
    ''
  )
  if (!/<\/head>/i.test(outHtml)) {
    throw new Error('www/index.html 缺少 </head>，无法注入窄屏覆盖层')
  }
  outHtml = outHtml.replace(
    /<\/head>/i,
    '<link rel="stylesheet" href="./mobile.css"></head>'
  )
  await writeFile(wwwIndex, outHtml, 'utf8')

  console.log(`[build-www] OK -> ${path.relative(repoRoot, wwwDir)}`)
  console.log(`[build-www] 入口资源校验通过：${refs.length} 个本地引用`)
  console.log('[build-www] 已注入 APK 专用窄屏覆盖层 mobile.css')
}

main().catch(err => {
  console.error(`[build-www] FAILED: ${err.message}`)
  process.exit(1)
})
