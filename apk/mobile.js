/*
 * APK 专用：给 Android WebView 补一个「退出全屏」入口。
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
