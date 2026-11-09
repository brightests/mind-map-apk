/*
 * APK 专用移动端补丁（三个独立 IIFE，按顺序执行）：
 *   ① 给 Android WebView 补一个「退出全屏」入口；
 *   ② 补回被上游 isMobile 隐藏的「新建」按钮；
 *   ③ 原生文件 IO：拦截导出下载 + 注入「保存 / 打开」按钮。
 *
 * ① 给 Android WebView 补一个「退出全屏」入口。
 *
 * 上游 Fullscreen.vue 的两个按钮只调用 fullScreen(mindMap.el) / fullScreen(document.body)，
 * 退出完全依赖浏览器原生 Esc；手机没有物理 Esc，返回键在部分 WebView 里也不会先退出
 * DOM 全屏，用户会被卡在全屏里。
 *
 * 为什么不改 web/src 或 dist/：改业务源码要重建 Vue2（Node 22 老栈有风险），改 dist/
 * 又要同步 Docker 镜像，还会波及桌面网页。本文件由 build-www.mjs 只复制到 apk/www/
 * 并注入 www/index.html，桌面 / Docker / 业务源码零影响，删掉即可整体回退。
 *
 * 关键约束：Fullscreen API 会把全屏元素提升到 top layer，此时只有该元素及其后代可见，
 * 挂在 body 上的普通浮层按钮是看不见的。所以按钮必须 append 到 document.fullscreenElement
 * 内部；检测到退出后立刻移除，不在正常编辑界面留下任何 UI。
 *
 * 兼容：Android WebView 的 Fullscreen API 前缀不统一（webkit / moz / ms），且个别版本
 * 不派发 fullscreenchange，因此同时监听多种事件名 + 1.2s 低频轮询兜底。若 WebView 用
 * 非标准方式全屏（fullscreenElement 恒为 null），且本次点击确实触发过 fullscreenchange，
 * 才额外挂一个 body 级按钮作为最后入口，避免在「点了没进全屏」时误弹按钮。
 */
;(function () {
  'use strict'

  if (window.__apkExitFullscreenInstalled) return
  window.__apkExitFullscreenInstalled = true

  var BTN_ID = 'apkExitFullscreenBtn'
  var FS_ELEMENT_KEYS = [
    'fullscreenElement',
    'webkitFullscreenElement',
    'mozFullScreenElement',
    'msFullscreenElement'
  ]
  var FS_CHANGE_EVENTS = [
    'fullscreenchange',
    'webkitfullscreenchange',
    'mozfullscreenchange',
    'MSFullscreenChange'
  ]
  var EXIT_METHODS = [
    'exitFullscreen',
    'webkitExitFullscreen',
    'webkitCancelFullScreen',
    'mozCancelFullScreen',
    'msExitFullscreen'
  ]
  var SVG_NS = 'http://www.w3.org/2000/svg'

  var btn = null
  var forced = false
  var sawFsChange = false

  function fsElement() {
    for (var i = 0; i < FS_ELEMENT_KEYS.length; i++) {
      var el = document[FS_ELEMENT_KEYS[i]]
      if (el) return el
    }
    return null
  }

  function exitFullscreen() {
    for (var i = 0; i < EXIT_METHODS.length; i++) {
      var name = EXIT_METHODS[i]
      if (typeof document[name] === 'function') {
        try {
          var result = document[name]()
          if (result && typeof result.catch === 'function') {
            result.catch(function () {})
          }
          return true
        } catch (e) {
          // 换下一个前缀再试
        }
      }
    }
    return false
  }

  // 某些 WebView 用宿主全屏而非标准 DOM 全屏，合成 Esc 作为最后尝试。
  // 浏览器原生全屏出于安全限制不会响应合成事件，所以这只是兜底，不作主路径。
  function dispatchEscape() {
    try {
      var ev = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true
      })
      document.dispatchEvent(ev)
    } catch (e) {
      // 老 WebView 不支持 KeyboardEvent 构造函数，忽略
    }
  }

  function unmount() {
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn)
    btn = null
  }

  function createButton() {
    var b = document.createElement('button')
    b.type = 'button'
    b.id = BTN_ID
    b.setAttribute('aria-label', '退出全屏')
    b.textContent = '退出全屏'
    // 全部用内联样式：避开 Vue scoped CSS，也避免被全屏元素内部的样式覆盖。
    b.style.cssText = [
      'position:fixed',
      'top:12px',
      'right:12px',
      'z-index:2147483647',
      'min-width:88px',
      'height:44px',
      'padding:0 14px',
      'margin:0',
      'border:1px solid rgba(255,255,255,.6)',
      'border-radius:22px',
      'background:rgba(0,0,0,.62)',
      'color:#fff',
      'font:14px/44px sans-serif',
      'text-align:center',
      'white-space:nowrap',
      'box-shadow:0 2px 10px rgba(0,0,0,.3)',
      'pointer-events:auto',
      'touch-action:manipulation',
      'user-select:none',
      '-webkit-user-select:none',
      '-webkit-tap-highlight-color:transparent',
      'cursor:pointer'
    ].join(';')

    var exiting = false

    function onExit(e) {
      // touchend 与 click 可能都到，节流避免重复调用退出逻辑
      if (exiting) return
      exiting = true
      setTimeout(function () {
        exiting = false
      }, 400)
      e.preventDefault()
      e.stopPropagation()
      var ok = exitFullscreen()
      if (!ok) dispatchEscape()
      setTimeout(function () {
        if (fsElement()) {
          sync()
          return
        }
        // 非标准全屏且退出没成功：保留这个入口，别让用户再次卡死
        if (forced && !ok) {
          mount(document.body)
          return
        }
        forced = false
        unmount()
      }, 250)
    }

    b.addEventListener('click', onExit, true)
    b.addEventListener('touchend', function (e) {
      // 部分老 WebView 在捕获阶段会吞掉 click，touchend 兜底；onExit 幂等
      e.preventDefault()
      onExit(e)
    }, true)
    return b
  }

  function mount(host) {
    if (!host || !host.appendChild) return
    // SVG 容器里塞 HTML button 不会渲染，退到父节点
    if (host.namespaceURI === SVG_NS) host = host.parentNode || host
    if (btn && btn.parentNode === host) return
    unmount()
    btn = createButton()
    host.appendChild(btn)
  }

  function sync() {
    var host = fsElement()
    if (host) {
      forced = false
      mount(host)
      return
    }
    if (forced) {
      mount(document.body)
      return
    }
    unmount()
  }

  FS_CHANGE_EVENTS.forEach(function (eventName) {
    document.addEventListener(eventName, function () {
      sawFsChange = true
      setTimeout(sync, 0)
    })
  })
  window.addEventListener('resize', function () {
    setTimeout(sync, 60)
  })
  // 部分 WebView 不派发 fullscreenchange，低频轮询兜底（每次只读几个属性）
  setInterval(sync, 1200)

  // 拦截上游两个全屏按钮：若 350ms 后仍拿不到 fullscreenElement，但浏览器确实
  // 派发过全屏事件，说明是宿主/非标准全屏，挂一个 body 级退出按钮作为最后入口。
  // 必须同时满足「本次点击后出现过 fullscreenchange」，否则点了没进全屏也会误挂按钮。
  document.addEventListener('click', function (e) {
    var target = e.target
    if (!target || !target.closest) return
    if (!target.closest('.fullscreenContainer .btn')) return
    sawFsChange = false
    setTimeout(function () {
      if (fsElement()) {
        sync()
        return
      }
      if (!sawFsChange) return
      forced = true
      mount(document.body)
    }, 350)
  }, true)

  // 键盘兜底：外接键盘 / 部分模拟器把返回键派发成 keyCode 4 或 Escape。
  // 只在全屏状态、且焦点不在输入控件时介入，避免干扰正常编辑快捷键。
  document.addEventListener('keydown', function (e) {
    if (!fsElement()) return
    var t = e.target
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return
    var key = e.key || ''
    if (key === 'Escape' || e.keyCode === 27 || e.keyCode === 4) {
      if (exitFullscreen()) {
        e.preventDefault()
        e.stopPropagation()
        setTimeout(sync, 60)
      }
    }
  }, true)

  sync()
})()

/*
 * ---------------------------------------------------------------------------
 * APK 专用：补回被上游 isMobile 隐藏的「新建」按钮
 * ---------------------------------------------------------------------------
 * Toolbar.vue 的「打开目录 / 新建 / 打开文件 / 另存为」四个按钮都带 v-if="!isMobile"，
 * 而 simple-mind-map/src/utils/index.js 的 isMobile() 只匹配 navigator.userAgent 里的
 * Android|iPhone|... ，Android WebView 必然命中，于是 APK 里只剩「导入 / 导出」。
 *
 * 不能简单把 isMobile 改成 false：这四个按钮内部走 window.showSaveFilePicker /
 * showOpenFilePicker / showDirectoryPicker（File System Access API），Android WebView
 * 都不支持，放开只会得到点了就报「不支持」的按钮；同时其它组件的弹窗宽度会从 90%
 * 变回 800px，在窄屏上溢出。
 *
 * 这里注入一个 APK 专用的「新建」：通过 Vue 根实例上的 $bus 派发上游已有的 setData
 * 事件（Edit.vue 常驻监听，导入 .md / .smm 走的是同一条路），把画布换成空白导图；
 * 拿不到 $bus 时降级为写 localStorage + reload。新建会覆盖当前内容，因此先弹确认层。
 * 不改 web/src、不改 dist/、不改 Docker，删掉本段即可整体回退。
 */
;(function () {
  'use strict'

  if (window.__apkNewFileInstalled) return
  window.__apkNewFileInstalled = true

  var BTN_ID = 'apkNewFileBtn'
  var MASK_ID = 'apkConfirmMask'
  var DATA_KEY = 'SIMPLE_MIND_MAP_DATA'
  var ROOT_TEXT = '中心主题'

  function blankRoot() {
    return { data: { text: ROOT_TEXT }, children: [] }
  }

  // 全局 $bus 只在 takeOverApp 模式暴露，正常启动时要从 Vue 根实例的 __vue__ 上取。
  function findBus() {
    if (window.$bus && window.$bus.$emit) return window.$bus
    var el = document.querySelector('.toolbarContainer')
    while (el) {
      var vm = el.__vue__
      if (vm && vm.$bus && vm.$bus.$emit) return vm.$bus
      el = el.parentElement
    }
    var all = document.body ? document.body.querySelectorAll('*') : []
    for (var i = 0; i < all.length; i++) {
      var v = all[i].__vue__
      if (v && v.$bus && v.$bus.$emit) return v.$bus
    }
    return null
  }

  // 兜底：直接回写 localStorage 再重载。theme / layout 必须保留，
  // 否则 Edit.vue init() 里解构 theme.template 会抛错导致白屏。
  function fallbackNew() {
    var full = {}
    try {
      var raw = localStorage.getItem(DATA_KEY)
      if (raw) full = JSON.parse(raw) || {}
    } catch (e) {
      full = {}
    }
    full.root = blankRoot()
    full.view = null
    if (!full.theme || !full.theme.template) {
      full.theme = { template: 'classic4', config: {} }
    }
    if (!full.layout) full.layout = 'logicalStructure'
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(full))
      location.reload()
      return true
    } catch (e) {
      return false
    }
  }

  function toast(msg) {
    var t = document.createElement('div')
    t.className = 'apkToast'
    t.textContent = msg
    document.body.appendChild(t)
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t)
    }, 2000)
  }

  function doNew() {
    var bus = findBus()
    if (bus) {
      bus.$emit('setData', blankRoot())
      toast('已新建空白导图')
      return
    }
    if (fallbackNew()) return
    toast('新建失败，请重启应用后重试')
  }

  // 触摸 + 鼠标双通道，400ms 节流避免 touchend 后再触发 click 重复执行。
  function bindTap(el, fn) {
    var last = 0
    function fire(e) {
      if (Date.now() - last < 400) return
      last = Date.now()
      if (e && e.cancelable) e.preventDefault()
      if (e && e.stopPropagation) e.stopPropagation()
      fn(e)
    }
    el.addEventListener('touchend', fire, false)
    el.addEventListener('click', fire, false)
  }

  // 不用 window.confirm：部分 WebView 宿主没实现 onJsConfirm，会静默失败。
  function showConfirm() {
    if (document.getElementById(MASK_ID)) return

    var mask = document.createElement('div')
    mask.id = MASK_ID
    mask.className = 'apkConfirmMask'

    var card = document.createElement('div')
    card.className = 'apkConfirmCard'

    var title = document.createElement('div')
    title.className = 'apkConfirmTitle'
    title.textContent = '新建思维导图'

    var desc = document.createElement('div')
    desc.textContent =
      '将清空当前画布并新建一张空白导图。当前内容不会自动保留，建议先「导出」备份。'

    var actions = document.createElement('div')
    actions.className = 'apkConfirmActions'

    var cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = '取消'

    var ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'apkConfirmOk'
    ok.textContent = '新建'

    actions.appendChild(cancel)
    actions.appendChild(ok)
    card.appendChild(title)
    card.appendChild(desc)
    card.appendChild(actions)
    mask.appendChild(card)
    document.body.appendChild(mask)

    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask)
    }
    bindTap(cancel, close)
    bindTap(ok, function () {
      close()
      doNew()
    })
    // 只有点在遮罩本身才关闭；卡片与按钮的监听已 stopPropagation。
    bindTap(mask, function (ev) {
      if (ev && ev.target === mask) close()
    })
  }

  function createBtn() {
    var btn = document.createElement('div')
    btn.id = BTN_ID
    btn.className = 'apkNewFileBtn'
    var icon = document.createElement('span')
    icon.className = 'icon iconfont iconxinjian'
    var text = document.createElement('span')
    text.className = 'text'
    text.textContent = '新建'
    btn.appendChild(icon)
    btn.appendChild(text)
    bindTap(btn, showConfirm)
    return btn
  }

  // 目标：含「导入」按钮的那一块 toolbarBlock，让「新建」排在导入之前。
  function findBlock() {
    var blocks = document.querySelectorAll(
      '.toolbarContainer .toolbar .toolbarBlock'
    )
    if (!blocks.length) return null
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].querySelector('.icondaoru')) return blocks[i]
    }
    return blocks[blocks.length - 1]
  }

  var btn = null
  var observed = false

  function install() {
    var block = findBlock()
    if (!block) return false
    if (!btn) btn = createBtn()
    if (btn.parentNode !== block) {
      block.insertBefore(btn, block.firstChild)
    }
    // Vue 重渲染工具栏时可能把外部注入的节点挤走；只观察工具栏自身，
    // 导图 SVG 不在其子树内，不会因节点渲染产生额外回调。
    if (!observed && window.MutationObserver && block.parentNode) {
      observed = true
      var toolbar = block.parentNode
      new MutationObserver(function () {
        var b = findBlock()
        if (b && btn && btn.parentNode !== b) {
          b.insertBefore(btn, b.firstChild)
        }
      }).observe(toolbar, { childList: true, subtree: true })
    }
    return true
  }

  var tries = 0
  install()
  var timer = setInterval(function () {
    tries++
    if (install() || tries >= 60) clearInterval(timer)
  }, 200)

  // 供后面的「原生文件 IO」IIFE 复用，避免重复实现事件总线查找 / toast / 点击绑定。
  window.__apkMobile = {
    findBus: findBus,
    toast: toast,
    bindTap: bindTap,
    blankRoot: blankRoot
  }
})()

/*
 * ---------------------------------------------------------------------------
 * APK 专用：原生文件 IO —— 让「导出」真的落盘，并补上「保存 / 打开」
 * ---------------------------------------------------------------------------
 * 问题 1：导出点了没反应。
 *   simple-mind-map 的导出结果都是 data:URL（Export.js -> readBlob ->
 *   FileReader.readAsDataURL），最终由 utils/index.js 的 downloadFile() 造一个
 *   <a download> 再 a.click()。桌面 Chrome 会下载，Android WebView 默认没有
 *   DownloadListener，data:/blob: 链接既不会下载、也不会有任何提示。
 *   解决：在 a.click() 上做一层拦截，把 data:URL 拆成 fileName / mimeType /
 *   base64，交给 ApkFilePlugin.saveToDownloads 写进系统「下载/MindMap」目录。
 *   非 APK 环境（桌面浏览器打开 www）不拦截，保持原行为。
 *
 * 问题 2：桌面工具栏的「打开 / 另存为」都被 isMobile 隐藏，且内部走
 *   showOpenFilePicker / showSaveFilePicker（File System Access API），WebView
 *   根本不存在。这里注入两个 APK 专用按钮：
 *     保存 —— 用 Vue.prototype.getCurrentData()（Edit.vue init() 注册）拿当前
 *             完整数据，写成 .smm 到下载目录；拿不到时退回 localStorage。
 *     打开 —— 走 ApkFilePlugin.openDocument（系统 SAF 文件选择器）读回文件，
 *             再派发上游已有的 $bus 'importFile' 事件（Import.vue:253），
 *             .smm / .json / .xmind / .md 的解析全部复用上游逻辑。
 *             原生选择器不可用时降级到 <input type=file>（Capacitor 的
 *             BridgeWebChromeClient.onShowFileChooser 已实现）。
 *
 * 依然只改 apk/：不碰 web/src、不碰 dist/、不碰 Docker，删掉本段即可回退。
 */
;(function () {
  'use strict'

  if (window.__apkFileIoInstalled) return
  window.__apkFileIoInstalled = true

  var U = window.__apkMobile || {}
  var DATA_KEY = 'SIMPLE_MIND_MAP_DATA'
  var NAME_KEY = 'APK_LAST_FILE_NAME'
  var PLUGIN = 'ApkFile'
  var MAX_B64 = 30 * 1024 * 1024

  var MIME_MAP = {
    smm: 'application/json',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    md: 'text/markdown',
    txt: 'text/plain',
    xmind: 'application/zip',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }

  // 保存与打开各自节流，互不阻塞：一次导出还在落盘时仍可以打开另一份文件。
  var saveBusy = false
  var openBusy = false
  var saveBtn = null
  var openBtn = null
  var syncing = false
  var observed = false

  /* ---------- 基础工具 ---------- */

  function toast(msg) {
    if (U && typeof U.toast === 'function') return U.toast(msg)
    var t = document.createElement('div')
    t.className = 'apkToast'
    t.textContent = msg
    document.body.appendChild(t)
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t)
    }, 2200)
  }

  function findBus() {
    if (U && typeof U.findBus === 'function') return U.findBus()
    if (window.$bus && window.$bus.$emit) return window.$bus
    return null
  }

  function errText(err) {
    if (!err) return '未知错误'
    if (typeof err === 'string') return err
    return err.message || err.errorMessage || String(err)
  }

  function safeName(raw, fallback) {
    var s = String(raw == null ? '' : raw).trim()
    s = s
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/^\.+/, '')
      .replace(/\s+/g, ' ')
      .slice(0, 90)
    return s || fallback
  }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '')
    return m ? m[1].toLowerCase() : ''
  }

  function mimeOf(name, fallback) {
    return MIME_MAP[extOf(name)] || fallback || 'application/octet-stream'
  }

  // 老 WebView 里 TextEncoder 不保证存在，用经典的 unescape+encodeURIComponent。
  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)))
  }

  function parseDataUrl(href) {
    var m = /^data:([^,]*),([\s\S]*)$/i.exec(href)
    if (!m) return null
    var meta = m[1] || ''
    var body = m[2] || ''
    if (/;base64$/i.test(meta)) {
      return {
        mime: meta.replace(/;base64$/i, '').split(';')[0],
        base64: body.replace(/\s+/g, '')
      }
    }
    var text
    try {
      text = decodeURIComponent(body)
    } catch (e) {
      text = body
    }
    return { mime: meta.split(';')[0], base64: utf8ToBase64(text) }
  }

  function blobUrlToBase64(url) {
    if (typeof fetch !== 'function') {
      return Promise.reject(new Error('WebView 不支持 fetch'))
    }
    return fetch(url)
      .then(function (r) {
        return r.blob()
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader()
          reader.onload = function () {
            resolve(String(reader.result || '').split(',')[1] || '')
          }
          reader.onerror = function () {
            reject(new Error('读取 blob 失败'))
          }
          reader.readAsDataURL(blob)
        })
      })
  }

  function base64ToBytes(base64) {
    var bin = atob(base64)
    var arr = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return arr
  }

  /* ---------- Capacitor 原生桥 ---------- */

  // 不用 @capacitor/core 的 registerPlugin：mobile.js 是纯脚本，没有打包器。
  // native-bridge.js 在原生 WebView 里注入 window.Capacitor.nativePromise，
  // 可直接按 (pluginId, methodName, options) 调用；桌面浏览器没有该对象。
  function isNative() {
    var c = window.Capacitor
    return !!(c && typeof c.nativePromise === 'function')
  }

  function nativeCall(method, opts) {
    var c = window.Capacitor
    if (!c || typeof c.nativePromise !== 'function') return null
    try {
      return c.nativePromise(PLUGIN, method, opts || {})
    } catch (e) {
      return Promise.reject(e)
    }
  }

  function writeDownload(name, base64, mime) {
    if (!isNative()) {
      toast('当前不是 APK 环境，无法保存到设备')
      return Promise.resolve(false)
    }
    if (!base64) {
      toast('文件内容为空')
      return Promise.resolve(false)
    }
    if (base64.length > MAX_B64) {
      toast('文件超过 30 MB，请缩小导出尺寸')
      return Promise.resolve(false)
    }
    if (saveBusy) {
      toast('上一个文件还在保存中')
      return Promise.resolve(false)
    }
    saveBusy = true
    var p = nativeCall('saveToDownloads', {
      fileName: name,
      mimeType: mime || 'application/octet-stream',
      base64: base64
    })
    if (!p) {
      saveBusy = false
      return Promise.resolve(false)
    }
    return p
      .then(function (res) {
        saveBusy = false
        var where = res && res.path ? res.path : '下载/MindMap/' + name
        if (where.charAt(0) !== '/') where = '设备存储/' + where
        toast('已保存：' + where)
        return true
      })
      .catch(function (err) {
        saveBusy = false
        toast('保存失败：' + errText(err))
        return false
      })
  }

  /* ---------- ① 导出拦截：让 <a download> 的文件真正落盘 ---------- */

  var originalClick =
    window.HTMLAnchorElement && HTMLAnchorElement.prototype.click

  if (window.HTMLAnchorElement && originalClick) {
    HTMLAnchorElement.prototype.click = function () {
      try {
        if (this.hasAttribute && this.hasAttribute('download')) {
          var href = this.getAttribute('href') || ''
          var name = safeName(this.getAttribute('download'), '思维导图.smm')
          if (!extOf(name)) name += '.smm'

          if (isNative() && /^data:/i.test(href)) {
            var parsed = parseDataUrl(href)
            if (parsed) {
              writeDownload(name, parsed.base64, mimeOf(name, parsed.mime))
              return
            }
          } else if (isNative() && /^blob:/i.test(href)) {
            blobUrlToBase64(href)
              .then(function (b64) {
                writeDownload(name, b64, mimeOf(name, ''))
              })
              .catch(function (e) {
                toast('导出失败：' + errText(e))
              })
            return
          }
        }
      } catch (e) {
        // 拦截链路出错就交回原生行为，绝不让导出彻底哑掉
      }
      return originalClick.apply(this, arguments)
    }
  }

  /* ---------- ②「保存」：把当前导图写成 .smm ---------- */

  function currentFullData() {
    // Edit.vue init() 里注册了 Vue.prototype.getCurrentData，返回的是画布最新
    // 完整数据（含 root / theme / layout / view），比 localStorage 更可靠。
    try {
      var rootEl = document.querySelector('#app')
      var vm = rootEl && rootEl.__vue__
      if (vm && typeof vm.getCurrentData === 'function') {
        var live = vm.getCurrentData()
        if (live && live.root) return live
      }
    } catch (e) {}
    try {
      var stored = JSON.parse(localStorage.getItem(DATA_KEY) || 'null')
      if (stored && stored.root) return stored
    } catch (e) {}
    return null
  }

  function doSave(name) {
    var data = currentFullData()
    if (!data) {
      toast('未读取到当前导图数据')
      return
    }
    var base64
    try {
      base64 = utf8ToBase64(JSON.stringify(data))
    } catch (e) {
      toast('导图数据序列化失败')
      return
    }
    try {
      localStorage.setItem(NAME_KEY, name)
    } catch (e) {}
    var base = safeName(name, '思维导图').replace(
      /\.(smm|json|png|jpg|jpeg|svg|pdf|md|txt|xmind)$/i,
      ''
    )
    writeDownload((base || '思维导图') + '.smm', base64, 'application/json')
  }

  function showSaveDialog() {
    if (document.getElementById('apkSaveMask')) return

    var mask = document.createElement('div')
    mask.id = 'apkSaveMask'
    mask.className = 'apkConfirmMask'

    var card = document.createElement('div')
    card.className = 'apkConfirmCard'

    var title = document.createElement('div')
    title.className = 'apkConfirmTitle'
    title.textContent = '保存当前导图'

    var hint = document.createElement('div')
    hint.className = 'apkFileHint'
    hint.textContent =
      '保存为 .smm 文件到系统下载目录（下载/MindMap），之后可用「打开」重新载入。'

    var input = document.createElement('input')
    input.type = 'text'
    input.className = 'apkFileNameInput'
    input.setAttribute('placeholder', '文件名')
    var last = ''
    try {
      last = localStorage.getItem(NAME_KEY) || ''
    } catch (e) {}
    input.value = last || '思维导图'

    var actions = document.createElement('div')
    actions.className = 'apkConfirmActions'

    var cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = '取消'

    var ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'apkConfirmOk'
    ok.textContent = '保存'

    actions.appendChild(cancel)
    actions.appendChild(ok)
    card.appendChild(title)
    card.appendChild(hint)
    card.appendChild(input)
    card.appendChild(actions)
    mask.appendChild(card)
    document.body.appendChild(mask)

    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask)
    }
    U.bindTap(cancel, close)
    U.bindTap(ok, function () {
      var name = safeName(input.value, '思维导图')
      close()
      doSave(name)
    })
    // 遮罩只绑 click（不 preventDefault）：输入框需要正常获得焦点与软键盘，
    // 用 bindTap 的 touchend + preventDefault 会把聚焦吃掉。
    mask.addEventListener(
      'click',
      function (ev) {
        if (ev && ev.target === mask) close()
      },
      false
    )
    ;['touchend', 'click'].forEach(function (type) {
      input.addEventListener(type, function (e) {
        e.stopPropagation()
      }, false)
    })
  }

  /* ---------- ③「打开」：系统文件选择器 -> 上游 importFile ---------- */

  function clearImportList() {
    try {
      var el = document.querySelector('.toolbarContainer')
      var vm = el && el.__vue__
      var ref = vm && vm.$refs && vm.$refs.ImportRef
      if (ref) ref.fileList = []
    } catch (e) {}
  }

  function makeFileLike(name, base64, mime) {
    var arr = base64ToBytes(base64)
    if (typeof window.File === 'function') {
      try {
        return new File([arr], name, { type: mime || 'application/octet-stream' })
      } catch (e) {}
    }
    var blob = new Blob([arr], { type: mime || 'application/octet-stream' })
    try {
      blob.name = name
    } catch (e) {}
    return blob
  }

  function loadImported(name, base64) {
    var n = safeName(name, '导图.smm')
    if (!/\.(smm|json|xmind|md)$/i.test(n)) n += '.smm'
    var bus = findBus()
    if (!bus) {
      toast('打开失败：未找到应用事件总线')
      return
    }
    clearImportList()
    // Import.vue:253 handleImportFile -> onChange -> confirm，复用全部格式解析
    bus.$emit('importFile', makeFileLike(n, base64, mimeOf(n, '')))
    toast('已打开：' + n)
  }

  // 降级路径：把 <input type=file> 直接展示在浮层里让用户亲手点。
  // 不能在异步 catch 里对隐藏 input 调 click()——那时用户手势已丢失，
  // WebView 的 onShowFileChooser 可能直接忽略。
  function pickWithInput() {
    if (document.getElementById('apkOpenMask')) return

    var mask = document.createElement('div')
    mask.id = 'apkOpenMask'
    mask.className = 'apkConfirmMask'

    var card = document.createElement('div')
    card.className = 'apkConfirmCard'

    var title = document.createElement('div')
    title.className = 'apkConfirmTitle'
    title.textContent = '打开已有文件'

    var hint = document.createElement('div')
    hint.className = 'apkFileHint'
    hint.textContent = '选择 .smm / .json / .xmind / .md 文件，将覆盖当前画布。'

    var input = document.createElement('input')
    input.type = 'file'
    input.accept = '.smm,.json,.xmind,.md'
    input.className = 'apkFileNameInput apkVisibleFileInput'

    var actions = document.createElement('div')
    actions.className = 'apkConfirmActions'
    var cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = '取消'
    actions.appendChild(cancel)

    card.appendChild(title)
    card.appendChild(hint)
    card.appendChild(input)
    card.appendChild(actions)
    mask.appendChild(card)
    document.body.appendChild(mask)

    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask)
    }
    U.bindTap(cancel, close)

    input.addEventListener('change', function () {
      var f = input.files && input.files[0]
      if (!f) return
      var bus = findBus()
      if (!bus) {
        toast('打开失败：未找到应用事件总线')
        return
      }
      clearImportList()
      bus.$emit('importFile', f)
      toast('已打开：' + f.name)
      close()
    })
    ;['touchend', 'click'].forEach(function (type) {
      input.addEventListener(type, function (e) {
        e.stopPropagation()
      }, false)
    })
  }

  function doOpen() {
    if (openBusy) return
    var p = isNative() ? nativeCall('openDocument', {}) : null
    if (!p) {
      pickWithInput()
      return
    }
    openBusy = true
    p.then(function (res) {
      openBusy = false
      if (!res || res.cancelled || !res.base64) return
      loadImported(res.name, res.base64)
    }).catch(function (err) {
      openBusy = false
      toast('系统文件选择器不可用：' + errText(err))
      pickWithInput()
    })
  }

  /* ---------- ④ 工具栏按钮注入 ---------- */

  function makeBtn(id, iconClass, label, handler) {
    var btn = document.createElement('div')
    btn.id = id
    btn.className = 'apkNewFileBtn apkExtraFileBtn'
    var icon = document.createElement('span')
    icon.className = 'icon iconfont ' + iconClass
    var text = document.createElement('span')
    text.className = 'text'
    text.textContent = label
    btn.appendChild(icon)
    btn.appendChild(text)
    if (id === 'apkSaveFileBtn') {
      U.bindTap(btn, handler)
    } else {
      // 打开要保留原始用户手势，不 preventDefault，方便降级到 input[type=file]
      btn.addEventListener('click', handler, false)
    }
    return btn
  }

  function syncButtons() {
    var host = document.getElementById('apkNewFileBtn')
    if (!host || !host.parentNode) return false
    var block = host.parentNode

    if (!saveBtn) {
      saveBtn = makeBtn('apkSaveFileBtn', 'iconlingcunwei', '保存', showSaveDialog)
    }
    if (!openBtn) {
      openBtn = makeBtn('apkOpenFileBtn', 'iconwenjian1', '打开', doOpen)
    }

    syncing = true
    try {
      if (saveBtn.parentNode !== block || saveBtn.previousSibling !== host) {
        block.insertBefore(saveBtn, host.nextSibling)
      }
      if (openBtn.parentNode !== block || openBtn.previousSibling !== saveBtn) {
        block.insertBefore(openBtn, saveBtn.nextSibling)
      }
    } finally {
      syncing = false
    }

    if (!observed && window.MutationObserver && block.parentNode) {
      observed = true
      // 与「新建」IIFE 的观察者各管各的节点；顺序固定为 新建 -> 保存 -> 打开
      new MutationObserver(function () {
        if (!syncing) syncButtons()
      }).observe(block.parentNode, { childList: true, subtree: true })
    }
    return true
  }

  var tries = 0
  syncButtons()
  var timer = setInterval(function () {
    tries++
    if (syncButtons() || tries >= 60) clearInterval(timer)
  }, 200)
})()
