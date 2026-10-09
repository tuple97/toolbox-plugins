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

// 演示插件间调用：其它插件可以 call('com.example.hello', 'ping')
toolbox.handler('ping', function () {
  return { pong: true, from: toolbox.plugin.id }
})

// 供前端一次性取回插件自己的全部配置
toolbox.handler('__listSettings', function () {
  return toolbox.storage.all()
})

toolbox.log('后端已加载')
