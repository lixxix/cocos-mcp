/**
 * 自研 Cocos MCP 服务的公共数据结构。
 *
 * 硬约束：扩展间 / 进程间通信走 Electron IPC，数据会被序列化成 JSON，
 * 所以这里所有字段都必须是 JSON 可序列化的（不允许原生对象 / 函数 / class 实例）。
 */

/** 面板或未来的 MCP Server 发来的操作请求 */
export interface OperationRequest {
    /** 操作名，例如 scene.tree */
    op: string;
    /** 操作参数，纯 JSON */
    params?: { [key: string]: any };
}

/** 操作统一返回结构 */
export interface OperationResult {
    /** 是否执行成功 */
    ok: boolean;
    /** 操作名 */
    op: string;
    /** 成功时的数据 */
    data?: any;
    /** 失败时的错误描述 */
    error?: string;
    /** 耗时（毫秒） */
    cost?: number;
    /** 时间戳（毫秒） */
    ts: number;
}

/** 操作目录项，用于面板展示与 MCP tools/list */
export interface OperationInfo {
    /** 操作名，全局唯一，形如 scene.tree */
    name: string;
    /** 中文标题 */
    title: string;
    /** 说明 */
    description: string;
    /** 参数说明：key 为参数名，value 为含义 */
    params: { [key: string]: string };
    /** 参数的 JSON Schema，直接作为 MCP tool 的 inputSchema */
    schema: JsonSchema;
}

/** 最小可用的 JSON Schema 描述（只覆盖 MCP inputSchema 需要的部分） */
export interface JsonSchema {
    type: 'object';
    properties: { [key: string]: any };
    required?: string[];
    additionalProperties?: boolean;
}
