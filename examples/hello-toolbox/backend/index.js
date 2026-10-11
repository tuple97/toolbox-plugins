/*
 * 插件后端入口（goja JavaScript 运行时）。
 *
 * 约定：
 *   - 入口在全局作用域执行，用 toolbox.handler(名, 函数) 注册后端方法；
 *   - handler 必须是**同步**函数：goja 没有事件循环，
 *     返回 Promise 不会被宿主等待（宿主的 http/存储等能力也是同步的）；
 *   - 参数与返回值都走 JSON（宿主会做序列化）。
 */

// 打招呼：前端通过 api.host.invoke('greet', { name }) 调用
toolbox.handler('greet', function (args) {
  var name = (args && args.name) || 'world'

  // 存储读取需要清单里的 permissions.storage 为 true，否则会抛权限错误
  var prefix = toolbox.storage.get('greeting') || '你好'

  toolbox.log('greet 被调用: ' + name)

  return {
    message: prefix + '，' + name + '！',
    pluginId: toolbox.plugin.id,
    pluginVersion: toolbox.plugin.version,
    appVersion: toolbox.plugin.appVersion,
    at: new Date().toISOString()
  }
})

// 演示插件间调用：其它插件在「声明了对本插件的依赖」之后
// 可以 call('com.example.hello', 'ping')。
//
// 只有清单 runtime.exports 中列出的 handler 才对外开放，
// 其它 handler（例如下面的私有方法）只能被本插件自己调用。
toolbox.handler('ping', function () {
  return { pong: true, from: toolbox.plugin.id }
})

toolbox.handler('__internal_helper', function () {
  return '这个 handler 没有出现在 runtime.exports 中，跨插件调用会被拒绝'
})

toolbox.log('后端已加载')
