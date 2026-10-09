/**
 * Vue 运行时 shim。
 *
 * 插件的 SFC 编译产物会 `import { ... } from 'vue'`。
 * 如果让 Rollup 正常解析，插件会打包进第二份 Vue —— 而 Vue 的响应式
 * 依赖模块级单例（activeEffect 等），两份副本互不感知，
 * 结果是「插件里的 ref 变了，宿主却不重渲染」。
 *
 * 因此构建时把 `vue` 指向本文件：所有导出都从宿主共享运行时上取，
 * 全应用只有一个 Vue 实例。
 *
 * 导出清单覆盖两部分：
 *   1. SFC 编译产物用到的渲染函数（createElementBlock/openBlock/...）；
 *   2. 插件业务代码会用到的组合式 API 与组件。
 * 清单不完整时可在此追加 —— 漏掉的符号会表现为运行时 undefined。
 */

const host = globalThis.__TOOLBOX__

if (!host || !host.vue) {
  throw new Error('[toolbox-plugin] 宿主共享运行时未就绪：无法获取 Vue 实例')
}

export default host.vue

export const {
  // ---- 响应式 ----
  ref,
  shallowRef,
  reactive,
  shallowReactive,
  readonly,
  shallowReadonly,
  computed,
  watch,
  watchEffect,
  watchPostEffect,
  watchSyncEffect,
  effectScope,
  getCurrentScope,
  onScopeDispose,
  customRef,
  toRef,
  toRefs,
  toValue,
  unref,
  isRef,
  isReactive,
  isReadonly,
  isProxy,
  markRaw,
  proxyRefs,
  triggerRef,

  // ---- 生命周期 ----
  onBeforeMount,
  onMounted,
  onBeforeUpdate,
  onUpdated,
  onBeforeUnmount,
  onUnmounted,
  onActivated,
  onDeactivated,
  onErrorCaptured,
  onRenderTracked,
  onRenderTriggered,
  onServerPrefetch,

  // ---- 依赖注入与实例 ----
  provide,
  inject,
  getCurrentInstance,
  useAttrs,
  useSlots,
  useModel,
  useId,
  useTemplateRef,
  useCssModule,
  useCssVars,
  useHost,
  useShadowRoot,

  // ---- 组件与渲染 ----
  defineComponent,
  defineAsyncComponent,
  defineCustomElement,
  h,
  createVNode,
  cloneVNode,
  mergeProps,
  isVNode,
  createApp,
  createSSRApp,
  nextTick,
  version,

  // ---- SFC 编译产物需要的渲染内核 ----
  openBlock,
  createBlock,
  createElementBlock,
  createElementVNode,
  createTextVNode,
  createCommentVNode,
  createStaticVNode,
  createSlots,
  renderList,
  renderSlot,
  resolveComponent,
  resolveDynamicComponent,
  resolveDirective,
  withDirectives,
  withModifiers,
  withCtx,
  withKeys,
  withMemo,
  isMemoSame,
  normalizeClass,
  normalizeStyle,
  normalizeProps,
  guardReactiveProps,
  toDisplayString,
  toHandlers,
  setBlockTracking,
  pushScopeId,
  popScopeId,
  withScopeId,
  ssrContextKey,
  ssrUtils,

  // ---- 内置组件 ----
  Fragment,
  Text,
  Comment,
  Static,
  Teleport,
  KeepAlive,
  Suspense,
  Transition,
  TransitionGroup,
  BaseTransition,
  BaseTransitionPropsValidators,

  // ---- 内置指令 ----
  vModelText,
  vModelCheckbox,
  vModelRadio,
  vModelSelect,
  vModelDynamic,
  vShow,
  vText,
  vHtml,

  // ---- 其它 ----
  warn,
  isPromise,
  capitalize,
  camelize,
  hyphenate,
  toHandlerKey,
  looseEqual,
  looseIndexOf,
} = host.vue
