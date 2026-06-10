# whosyourdaddy

> MAKE BI GREATE AGAIN

Cloudflare Worker 驱动的 ZAI / 智谱用量监控面板。每五分钟自动采集一次上游数据，缓存至 KV，前端以**承熙纪年·时辰刻制**展示。

## 功能

- **模型用量** — 各模型调用次数与 token 消耗，按小时粒度聚合
- **工具用量** — 网络搜索 / Web Reader / ZRead 等 MCP 工具调用统计
- **额度监控** — 5 小时 token 额度 & 月度 MCP 额度百分比
- **承熙纪年** — 所有时间以古代纪年显示（承熙六年六月10日 午时初初刻）
- **自动刷新** — `scheduled` trigger 每 5 分钟拉取最新数据写入 KV
- **智能缓存** — 缓存过期时先返回旧数据，后台静默刷新
- **手动刷新** — `POST /api/refresh` 需 Bearer token 验证
- **诊断面板** — 上游请求失败时展示结构化调试信息

## 时间显示

采用承熙纪年 + 时辰刻制：

| 组件 | 规则 | 示例 |
|---|---|---|
| 年号 | 2021 起为承熙元年 | 2026 → 承熙六年 |
| 月份 | 正月 ~ 腊月 | 6月 → 六月 |
| 时辰 | 子丑寅卯辰巳午未申酉戌亥 | 11:00 → 午时 |
| 刻 | 每时辰八刻，初（前四刻）正（后四刻） | 11:10 → 午时初初刻 |

## 文件结构

```
src/index.js      Worker 主逻辑 + 内嵌前端页面
wrangler.toml     Worker 配置、cron、KV 绑定
preview.html      本地开发用的 mock 前端预览
.dev.vars.example 环境变量模板
```

## API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 前端面板页面 |
| `/api/usage` | GET | 返回缓存的用量快照（JSON） |
| `/api/refresh` | POST | 强制刷新，需 `Authorization: Bearer <token>` |

### `/api/usage` 响应结构

```jsonc
{
  "status": "fresh",          // fresh | stale | partial
  "cache": { "refreshed_at": "...", "age_seconds": 42 },
  "data": {
    "model_usage": {
      "modelSummaryList": [{ "modelName": "GLM-5.1", "totalTokens": 58442872 }],
      "modelDataList": [{ "modelName": "GLM-5.1", "tokensUsage": [...] }],
      "x_time": ["2026-06-09 10:00", "..."],
      "granularity": "hourly"
    },
    "tool_usage": { "toolSummaryList": [...], "toolDataList": [...] },
    "quota_limit": { "limits": [{ "type": "TOKENS_LIMIT", "percentage": 37 }] }
  }
}
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `ZAI_PLAN_TOKEN` | ✅ | — | ZAI / 智谱 API 认证 token |
| `ZAI_BASE_URL` | — | `https://api.z.ai/api/anthropic` | 上游 API 地址 |
| `ZAI_TIMEZONE` | — | `Asia/Singapore` | 时间显示时区 |
| `CACHE_STALE_AFTER_SECONDS` | — | `900` | 缓存过期阈值（秒） |
| `REFRESH_TOKEN` | — | — | 启用 `/api/refresh` 的 Bearer token |

## 快速开始

```bash
# 安装依赖
npm install

# 创建 KV namespace
wrangler kv namespace create USAGE_CACHE
wrangler kv namespace create USAGE_CACHE --preview

# 配置 secrets
wrangler secret put ZAI_PLAN_TOKEN

# 本地开发
npm run dev

# 部署
wrangler deploy
```

可选手动刷新功能：

```bash
wrangler secret put REFRESH_TOKEN
```

## 缓存策略

KV 中存储两个 key：

- `usage:latest` — 最近一次成功的用量快照
- `usage:last_error` — 最近一次刷新失败的调试信息

读取时如果缓存过期（超过 `CACHE_STALE_AFTER_SECONDS`），先返回旧数据，同时异步触发后台刷新。适合读多写少、无需强一致性的监控场景。
