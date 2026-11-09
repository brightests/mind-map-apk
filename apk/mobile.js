/*
 * APK 专用移动端补丁（两个独立 IIFE，按顺序执行）：
 *   ① 给 Android WebView 补一个「退出全屏」入口；
 *   ② 补回被上游 isMobile 隐藏的「新建」按钮。
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
})()
