# ssh-mcp - 变更

## 新增需求

### 需求：支持 profile 配置文件驱动

#### 场景：配置文件启动
- 当 用户通过 `--config` 指定配置文件
- 那么 服务从本地文件加载 profile，并校验 `activeProfile` 与认证字段

### 需求：支持运行时 profile 管理

#### 场景：列出 profile
- 当 调用 `profiles-list`
- 那么 返回 `id/name/host/port/note/tags/active` 且敏感字段脱敏

#### 场景：切换 profile
- 当 调用 `profiles-use` 并传入合法 `profileId`
- 那么 服务切换目标并重建连接会话

#### 场景：重载 profile
- 当 调用 `profiles-reload`
- 那么 服务重新读取文件并校验当前 active 仍有效

### 需求：支持备注持久化更新

#### 场景：更新备注
- 当 调用 `profiles-note-update`
- 那么 指定 profile 的 `note` 写回本地配置文件并立即生效

## 修改需求

### 需求：启动参数模式判定

旧内容（语义）：仅支持 `--host --user` 直连。

新内容：支持“旧模式 + 配置模式”双轨并存，二者冲突时显式报错。

#### 场景：冲突参数
- 当 同时传入 `--config` 与旧模式目标参数
- 那么 启动失败并返回清晰冲突原因

## 契约字段

| 字段 | 类型 | 必需 | 约束 | 兼容性说明 | 备注 |
|------|------|------|------|-----------|------|
| version | number | 是 | 当前固定为 `1` | 新增字段，不影响旧模式 | 配置根字段 |
| activeProfile | string | 是 | 必须存在于 profiles.id | 仅配置模式使用 | 运行时默认 active |
| profiles[].id | string | 是 | 全局唯一 | 新增字段 | 切换主键 |
| profiles[].auth.type | string | 是 | `password` 或 `key` | 新增字段 | 认证类型 |
| profiles[].auth.password | string | 条件必需 | `auth.type=password` 时必填 | 新增字段 | 支持 ENV 展开 |
| profiles[].auth.keyPath | string | 条件必需 | `auth.type=key` 时必填 | 新增字段 | 支持 ENV 展开 |
| profiles[].note | string | 否 | 可为空字符串 | 新增字段 | 运维备注 |

请求示例（`profiles-use`）：

```json
{
  "profileId": "jp-relay"
}
```

响应示例（摘要）：

```json
{
  "activeProfile": "jp-relay",
  "profile": {
    "id": "jp-relay",
    "name": "日本中转",
    "host": "jp-relay.example.com",
    "port": 22,
    "note": "日本入口机，主要做转发与链路排障",
    "tags": ["relay", "jp"],
    "active": true
  }
}
```
