# Assetory 项目上下文

## 当前目标

Assetory 是本地优先的月度资产价值追踪工具。它以单个 JSON 账本保存月末资产、流水、汇率、价格与趋势分析；网页只计算和展示，不保存用户账本到服务器。

## 文件与发布

- `src/index.template.html` / `src/styles.css`：页面结构和样式源码。
- `src/js/core.js`：公共状态、数据模型、迁移和基础计算。
- `src/js/storage.js`：IndexedDB、加密、文件读写、导入导出和账本管理。
- `src/js/transactions.js`：流水联动、成本基础、对账和跨月同步。
- `src/js/quotes.js`：汇率、股价及首月价格基线。
- `src/js/trends.js`：盈亏归因和趋势图表。
- `src/js/ui.js`：月度页面、资产/流水表和对话框。
- `src/js/app.js`：全局事件、PWA 和启动流程。
- `scripts/build.mjs`：将模板、CSS 和上述模块合并为单文件 `index.html`；无第三方依赖。
- `assets/images/`：页面、浏览器 Tab 与 PWA 图标。
- `index.html`：生成后的本地版和服务器静态入口，不应直接编辑。单独下载后可按需要重命名为 `assetory.html`。
- `assetory-demo-ledger.json`：公开演示账本，六个月数据，可用于基础回归。
- `manifest.webmanifest` / `service-worker.js`：PWA 安装与离线程序缓存。
- `README.md`：给普通用户与 AI Agent 的使用说明。

修改源码后必须运行 `npm run build`，并用 `npm run check` 确认 `index.html` 未过期。如需部署，可使用任意支持 HTTPS 的静态网站服务。应提交 `assets/`、`src/`、`scripts/`、构建产物和公开说明；不得提交个人账本、备份、`.DS_Store`、`node_modules/`、`.env` 或任何密钥。部署域名、服务器地址和站点目录属于使用者自己的环境配置，不应写入或提交到项目上下文。发布时只上传公开程序与演示文件，绝不上传真实账本 JSON。

## 数据模型

```text
ledger.months[YYYY-MM]
  balance[]       月末资产/负债；每项必须有稳定的 id
  flows[]         流水；通过 fromAssetId / toAssetId 引用资产 id
  fxRates         本月原币 -> CNY 汇率
  opening[]       期初快照，用于对账
  openingPrices{} 首月自动报价股票的上月底价格基线，用于首月盈亏归因
  copiedFrom      上一个来源月份（如有）
  revision        本月内容版本号
  sourceRevision  子月已接收的来源版本号
  changeLog[]     按 revision 记录变更摘要与字段级明细，用于同步前展示差异
  createdAt / updatedAt 仅用于展示
```

旧 JSON 的 `fromIdx` / `toIdx` 会在导入时迁移到资产 ID；新代码不得再新增数组下标引用。

## 核心约束

1. 所有账本内容修改应走 `transact()`：先克隆快照，成功后一次 `persist()`，写入失败则回滚内存数据。
2. `migrateLedger()` 负责 JSON 结构检查、旧字段迁移、文本清理与稳定 ID 检查。任何用户文本渲染到 `innerHTML` 前都用 `escapeHTML` / `escapeAttr`。
3. 流水新增或编辑必须先通过 `buildFlowDraft()` 校验，再写入并调用 `applyFlow()`；删除流水必须以 `applyFlow(flow, -1)` 回滚。新流水的金额和数量必须为正数。股票卖出允许从零持仓或多头持仓穿过零仓建立空头，基金和固定资产不可超卖；还款不得超过当前负债余额；跨币种还款必须先通过现金转账换汇。收入可流入任意非负债资产；流入股票时以数量和价格联动持仓，其余资产按金额联动。只有流入现金资产的收入计入净现金流，股票或实物激励等非现金收入只增加资产与净资产。
4. 删除资产必须先下载备份，回滚并删除当前及后续月份的关联流水和资产，再沿继承链重建后续月份。
5. 跨月待同步只比较 `parent.revision > child.sourceRevision`，不得再以时间戳作为判断依据。同步依赖 `rebuildChildFromParent()`；插入中间月份时必须重连原直接子月，保持单一时间链。同步提示通过 `changeLog` 展示尚未接收的修改。
6. 资产类占比以总资产为分母；负债类占比以总负债绝对值为分母。净资产不是配置比例分母。
7. 本月资产盈亏与收入/支出的净资产贡献不同：资产盈亏用于价格、汇率、买卖成本和资产收益归因；收入/支出在盈亏趋势中单列。归因与净资产变动优先以上一个实际月份的当前期末为比较基准；账本首月没有真实上月时，使用期末反向扣除本月流水得到的期初，其中自动报价股票可用 `openingPrices` 的上月底价格替换期末价格，其余无流水资产估值保持不变。`opening` 只用于同步重建和对账，不能作为归因基准，否则两套期初的差额会落入“未解释调整”。现金盈亏另外拆分汇率影响、资产收益和手工余额调整。
8. 所有修改应由 `transact()` 自动生成字段级变更明细；同步提示展示余额、数量、价格、汇率和流水去向等具体差异。不得依赖时间戳判断是否需要同步。
9. JSON 导入对历史流水采用兼容校验：资产引用 ID 必须存在，但不追溯性强制旧流水符合当前的资产类别选择规则。新建非现金收入用 `nonCashIncome: true` 标记，股票数量型收入另用 `incomeAssetMode: "quantity"`；没有这些字段的旧收入保持原余额和现金流口径。
10. `src/` 是唯一源码，根目录 `index.html` 是构建产物。所有功能修改必须落在对应模块中，再运行构建脚本；禁止只修改生成物，否则下一次构建会覆盖变更。

## 关键函数

- `applyFlowToBalance`：流水联动余额与成本基准。
- `assetProfitAttribution` / `profitAttribution`：月度资产盈亏和净资产归因。
- `rebuildChildFromParent` / `syncToNext` / `syncToAll`：跨月重建。
- `reconcile`：期初、流水和期末差异检查。
- `renderMonthPanel`：月度资产负债表、移动端紧凑卡片和流水表。
- `renderTrendSummary` / `renderTrend`：顶部指标与趋势分析。

## 当前 UI 规则

- 桌面资产负债表默认信息态；点“编辑”后才展示操作按钮。保存单项资产后保持编辑态，直到用户点“完成”；切换月份或账本时重置编辑态。价格或估值只在“编辑资产详情”中修改，自动更新失败仅显示警告状态。
- 窄屏（<=560px）用 `balance-mobile` 紧凑卡片替代横向滚动资产表。
- 分组小计的资产/负债占比固定显示一位小数。
- 顶部净资产、总资产、总负债卡显示窗口变化，下面显示期初/期末；净现金流显示流入/流出。
- 自动股价失败的警告标识可点击，直接进入手工价格修正。
- 美股历史价格优先使用腾讯日线或其月末报价，目标旧月份无数据时回退新浪 JSONP 历史日线；不要恢复会触发浏览器 CORS 的东财接口。
- PWA 仅在 HTTPS 环境注册；本地 `file://` 模式跳过 PWA，仍使用原有 JSON 机制。移动浏览器始终显示“添加到桌面”，不能直接安装时展示系统菜单指引；发布新版需递增 `service-worker.js` 的 `CACHE_NAME`。
- 密码输入统一使用 `requestPassword()` 的 password 类型对话框；加密账本修改密码时留空并确认会取消加密，恢复明文 JSON。
- 新建资产和流水建仓使用 `assetGroupList` / `assetAccountList` 推荐历史分组与账户，但始终允许自定义输入；流水金额由 `parseArithmetic()` 支持基础四则运算与括号。

## 最低验证

```sh
npm run build
npm run check
```

还应检查 `assetory-demo-ledger.json` 能被解析，且每条 `fromAssetId` / `toAssetId` 都存在于该月 `balance`。数据计算或同步逻辑改动时，优先用演示账本手工验证买入、卖出、资产收益、删除资产与跨月同步。
