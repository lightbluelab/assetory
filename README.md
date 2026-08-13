# Assetory

**Assets, Liabilities & Net Worth**

Assetory 是一个本地优先的个人/家庭资产追踪工具：按月记录资产、负债和流水，查看净资产、现金流与趋势变化。账本由你自己保存为 JSON 文件，不会上传到本项目或网页服务器。

## 使用者：两种打开方式

### 方式一：通过网页使用

访问 [Assetory 在线版](https://lightbluelab.github.io/assetory/)。

1. 首次打开可直接体验示例账本。
2. 点击右上角“账本管理”，选择“新建”或“打开 JSON”。
3. 日常维护资产、负债和流水；需要时添加新月份。
4. 修改历史月份后，按页面提示同步后续月份。
5. 定期点击“备份”下载账本 JSON。

在支持文件写回的桌面浏览器中，网页可在你授权后写回原文件。其他浏览器、手机和导入模式下，修改会保留在当前页面；离开前请点击“备份”下载最新 JSON。密码保护可在“账本管理”中设置，密码丢失无法恢复内容。

### 方式二：下载 HTML 在本地使用

下载 [assetory.html](./assetory.html)，双击即可在浏览器中打开。它不依赖本地服务或安装步骤。

首次使用时选择“新建”或“打开 JSON”。本地 HTML 无法自动加载在线示例账本，这是浏览器的本地文件限制；可从 [assetory-demo-ledger.json](./assetory-demo-ledger.json) 下载后手动导入。编辑后同样请通过“备份”保存最新账本。

常用下载：

- [产品介绍页](./index.html)
- [独立本地 HTML](./assetory.html)
- [演示账本 JSON](./assetory-demo-ledger.json)
- [使用说明网页](./guide.html)

## 开发者

### 下载代码到本地

```sh
git clone https://github.com/lightbluelab/assetory.git
cd assetory
```

项目不依赖第三方 npm 包；安装 Node.js 后可直接构建和检查：

```sh
npm test
npm run build
npm run check
```

- `npm run build` 生成根目录的 `index.html`、`assetory.html` 和 `guide.html`。
- `npm run check` 确认生成物与源码同步。
- 修改功能应编辑 `src/` 和相关公开 JSON/文档，不要直接修改生成后的 HTML。

设计约束、数据模型、模块职责、同步规则和最低验证要求记录在 [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)。修改账本计算、同步或导入逻辑前，请先阅读该文件。

## 设计与安全

Assetory 采用本地优先设计：真实账本只存在于你的设备和你导出的文件中。公开仓库仅包含程序代码与演示账本。请自行妥善保管备份和密码。
