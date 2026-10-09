/**
 * 开发工具箱插件的前端 API 类型定义。
 *
 * 这是一个「纯类型」包：运行时不产出任何代码，宿主在加载插件时把
 * 真实的实现通过 activate(api) 传进来。插件里写
 *
 *   import type { PluginFrontendApi } from '@toolbox/plugin-sdk'
 *
 * 只是为了拿到类型提示；构建时这些导入会被完全擦除。
 */

import type { Component } from 'vue'

/** 宿主 API 版本；插件可据此做兼容判断 */
export declare const TOOLBOX_API_VERSION: string

/** 插件注册工具的参数 */
export interface PluginToolRegistration {
  /**
   * 工具类型标识，全局唯一。
   *
   * 与内置工具同名时会「接管」该入口：插件已安装则用插件实现，
   * 卸载后回退到内置实现 —— 这是官方插件平滑替换内置功能的机制。
   */
  type: string
  /** 菜单与标签展示名 */
  label: string
  /** 图标名（内置于宿主的自绘图标库） */
  icon?: string
  /** 是否多例：可同时打开多个实例标签 */
  multi?: boolean
  /** 单行说明，用于菜单悬浮提示 */
  description?: string
  /** 侧栏分组名；留空归入「插件」分组 */
  group?: string
  /** 工具视图组件 */
  component: Component
}

/** 工具视图组件的 props（宿主注入） */
export interface PluginToolProps {
  /** 所属标签 id（多例工具用于回传状态） */
  tabId: number
  /** 该标签上次保存的状态 */
  initialPayload: Record<string, unknown>
}

/** 插件可用的宿主能力 */
export interface PluginHostCapabilities {
  /**
   * 调用插件自己的后端 handler（runtime.backend = "js" 时可用）。
   * 参数与返回值均为 JSON 可序列化的值。
   */
  invoke: <T = unknown>(handler: string, args?: unknown) => Promise<T>

  /** 插件私有键值存储（需 permissions.storage） */
  storage: {
    get: (key: string) => Promise<string>
    set: (key: string, value: string) => Promise<void>
    all: () => Promise<Record<string, string>>
  }

  /** 发送事件（需 permissions.events）；事件名会自动加上插件前缀 */
  emit: (name: string, payload?: unknown) => void
  /** 监听本插件的事件，返回取消函数 */
  on: (name: string, callback: (payload: unknown) => void) => () => void

  /** 应用内提示 */
  notify: {
    success: (message: string) => void
    error: (message: string) => void
    warning: (message: string) => void
    info: (message: string) => void
  }
  /** 用系统浏览器打开链接 */
  openExternal: (url: string) => void
  /** 生成插件自身静态资源的 URL */
  assetUrl: (relPath: string) => string
}

/** 传给插件 activate() 的上下文 */
export interface PluginFrontendApi {
  /** 插件自身信息 */
  plugin: {
    id: string
    version: string
    /** 插件资源 URL 前缀（已含插件 id 与版本） */
    baseUrl: string
  }

  /**
   * 共享 Vue 运行时。
   *
   * 插件必须从这里取 Vue（或写 SFC 由构建期注入 shim），
   * 自行打包第二份 Vue 会因响应式模块级单例分裂而失去响应。
   */
  vue: typeof import('vue')

  /** 共享 UI 组件库（宿主自研组件，键名即组件名） */
  ui: Record<string, Component>

  /** 宿主能力 */
  host: PluginHostCapabilities

  /** 注册一个工具视图 */
  registerTool: (definition: PluginToolRegistration) => void

  /** 写日志（输出到应用控制台） */
  log: (...args: unknown[]) => void
}

/** 插件前端入口必须导出的激活函数 */
export type PluginActivate = (api: PluginFrontendApi) => void | Promise<void>
