> 此仓库提供支持 macOS 的软件源码，不包含个人资料或原仓库历史。请按下文构建；原仓库发行链接已转为私有归档，本源码副本尚未发布安装包。

# 关系回响

一个本地优先的关系维系应用：Windows 版可通过 WeFlow 提取微信联系人，也可在 Windows / macOS 读取通用 JSON / CSV 联系人源，归纳每位个人联系人的最近一条消息，把“联系频率”和“是否需要维系”分成两条独立轴，并按约 30 天的节律提醒你问候。正式数据统一写入本机 SQLite：Windows 默认使用独立的数据目录，macOS 默认使用用户的 Application Support。浏览器存储仅作恢复缓存。

## 当前可以做什么

- 查看常联系人、不常联系人、需要维系、不需要维系四个系统分类。
- 给联系人设置或取消“需要维系 / 不需要维系”，并创建、分配、移除、删除自定义标签。
- 查看最近一条消息及时间，按 30 天默认周期计算到期、逾期与即将到期。
- 标记“已问候”或稍后 3 / 7 / 14 天提醒；操作不会自动给微信好友发消息。
- 在隐私模式下隐藏姓名、头像文字、聊天摘要、问候参考和导入预览。
- 先预览再合并或替换导入；导入失败不会覆盖当前状态。
- 最多管理 3,000 位联系人，台账默认每页 50 位；快速整理只会操作当前页中明确勾选的人。
- 最近一次可确认互动满 600 天的联系人会自动退出默认台账、节律仪、待问候队列和统计；数据不会删除，可通过“查看已隐藏”临时访问。日期缺失的联系人不会被误隐藏。
- SQLite 自动保留最近 50 次状态历史，并轮转保留 12 份独立数据库快照。
- 快速整理由服务器根据当前 SQLite 权威状态计算实际变化；最近一次批量标签操作可在 45 秒内撤销，页面刷新或服务重启后仍可恢复尚未到期的撤销入口。
- 导出 / 恢复 JSON、手动创建本机数据库快照、恢复演示数据、清空正式状态。
- “数据与隐私”在桌面端采用紧凑 2×2 弹窗，四块说明和全部操作无需在弹窗内滚动。
- 默认使用浅色矿物玻璃外观，并提供深色与跟随系统选项；桌面和移动端分别使用本地 WebP 背景，不加载远程字体或图片。

## 外观系统

当前默认外观是浅色、安静、具有矿物玻璃层次的 Apple 风格设计语言。背景、主要按钮皮肤和联系人来源插画由内置生图提示词生成后随应用一起打包；图片层只负责视觉，按钮、焦点、键盘操作和无障碍名称仍由真实 HTML 控件承担。高对比度、减少动态效果与减少透明度模式会自动降低或关闭装饰层。

- 内置安全提示词：`src/background-prompt.js`。它只接受闭集的主题、比例和用途参数，不会把联系人姓名、聊天内容或 WeFlow Token 拼入提示词。
- 资产与生成记录：`assets/appearance/theme-manifest.json`。
- 默认浅色不会跟随深色系统发生首帧闪烁；用户仍可通过顶栏外观按钮切换为深色或跟随系统。

## 本地运行

需要 Node.js 24 或更高版本（项目使用 Node 原生 `node:sqlite`，不需要安装第三方数据库）：

```powershell
# 如果项目被移动，请把路径替换为实际解压位置
Set-Location -LiteralPath 'D:\SJT网站\relationship-care'
npm start
```

打开 `http://127.0.0.1:4173`。运行自动测试：

```powershell
npm test
```

如果 4173 端口已被占用，可以改用：

```powershell
npm start -- --port 4188
```

然后打开 `http://127.0.0.1:4188`。推荐使用最新版 Chrome、Edge 或 Firefox。服务只监听 `127.0.0.1`，浏览器通过同源 API 访问 SQLite，跨标签页冲突由数据库修订号比较解决。

Windows 默认数据目录位于项目静态目录之外：

```text
D:\SJT网站\relationship-care-data\
├─ relationship-care.sqlite
└─ backups\
```

macOS 默认目录为：

```text
~/Library/Application Support/Relationship Echo/
├─ relationship-care.sqlite
└─ backups/
```

以命令行服务运行时，两个平台都可在启动前设置 `RELATIONSHIP_CARE_DATA_DIR` 覆盖位置；Electron App 固定使用自己的 Application Support 目录，避免环境变量把数据悄悄导向别处。Windows 上如需移动，建议选择独立的本机数据目录。不要把数据库放进 `relationship-care` 应用源码目录；静态服务器虽然使用白名单，数据和网页分离仍是必要边界。

## Mac App 迁移包

Windows 端可把当前 SQLite 通过一致性快照导出成 AES-256-GCM 加密迁移文件，再与锁定依赖、Electron universal 构建配置和一键 `.command` 一起封装为百度网盘 ZIP。正式交付命令必须显式给出期望联系人数；期望人数由使用者自行指定，选错演示库或旧库会直接停止，不会生成 ZIP。

Mac 第一次运行一键脚本时会：核对包内文件、执行 `npm ci`、运行全部测试、构建 Intel + Apple Silicon universal App、做个人本地临时签名、通过带单实例锁、持久日志和回滚副本的可恢复事务安装到 `~/Applications/关系回响.app`，最后把联系人安装到 `~/Library/Application Support/Relationship Echo`。密码通过匿名标准输入短时传递，不进入命令行参数或子进程环境；已有 Mac 数据库始终拒绝覆盖。即使安装时断电或被强制终止，下次运行也会先根据 SQLite 完整性、SHA-256、修订号和联系人数量复核事务身份，再决定提交或恢复；误双击第二次不会干扰第一个任务。

ZIP 内 `SHA256SUMS.txt` 用于检测普通下载损坏。防止整包被替换所需的 ZIP SHA-256 与迁移密码放在另一个“请勿上传”文件里，必须通过不同于百度网盘的可信渠道保存并在解压前比对。完整操作见 `MAC-APP.md`。

## 联系人来源与 Mac 兼容

联系人提取层使用统一的数据源合同，而不是把整个应用绑定到 WeFlow：

- `weflow-http-win32`：仅在 Windows 显示和运行，职责只有从 WeFlow 回环 API 提取联系人、会话时间与最近一条消息。
- `portable-contact-file`：Windows 与 macOS 通用的离线 JSON / CSV 入口；可使用 `samples/contact-source.sample.json` 作为适配目标。
- `mac-reader-bridge`：为将来选定的 macOS 微信读取软件保留的本机适配器槽位。当前未绑定某个具体第三方读取器，因此会明确显示“需要适配器”，不会假装已经直连。

通用来源用 `providerId × instanceId × externalKey` 生成稳定、隔离的联系人 ID，避免不同读取器、不同微信账号或重复导入互相覆盖。只有明确列入兼容范围的旧 WeFlow / 旧通用文件可缺少新版来源引用；新适配器必须提供完整引用。控制字符、重复 ID、来源矛盾和超限数据都会在预览阶段失败关闭。

## WeFlow 本机直连（仅 Windows）

1. 在 WeFlow 设置中打开“API 服务”，默认地址为 `127.0.0.1:5031`。
2. 复制 WeFlow 的 Access Token。
3. 在本网站点击“导入数据”，输入端口和 Token，再点“连接并生成预览”。
4. 核对联系人、最近消息和警告后，再选择合并或替换并确认。

直连读取 `/health`、`/api/v1/contacts`、`/api/v1/sessions` 和每个个人会话最近一条 `/api/v1/messages`。群聊与公众号默认过滤；完整聊天历史不会写入本应用。Token 只存在于本次请求内，不写入 SQLite、`localStorage` 或页面配置。WeFlow/微信 4.0 的部分组合可能出现“会话可读但消息接口返回 0 条”，页面会保留时间并给出显式警告，不会把空结果伪装成完整成功。

逐联系人补全最近消息设有 45 秒总预算，避免 3,000 人场景长时间卡住。达到预算时仍会返回联系人和会话时间，并把未补全正文的人数明确标为“待校验”；预览同时分开展示待校验联系人数与系统警告组数。

## 导入格式

当前入口是版本明确、失败关闭的兼容导入器，不会假装兼容未知 WeFlow 版本。支持：

1. 联系人摘要列表（JSON 或 CSV），字段可使用 `id / name / lastMessageAt / lastMessage / tags / maintenanceIntent / cadenceDays`。
2. 消息列表 JSON，至少要有可识别的个人会话 ID 和时间；内容字段可选，缺失时仍可用于节律计算。同一会话只保留最近一条有效消息，群聊与公众号默认过滤。

快速体验：启动网站后点击“导入数据”，选择项目自带的 `samples/contacts.sample.json`，确认预览无误后选择“合并到当前联系人”。开发 macOS 适配器时，优先输出版本化的 `samples/contact-source.sample.json` 合同；只提供联系人而没有互动时间也可以导入，但会统一标记为“待校验”。

JSON 摘要示例：

```json
{
  "version": 1,
  "contacts": [
    {
      "id": "wxid_example",
      "name": "示例好友",
      "lastMessageAt": "2026-07-01T12:00:00+08:00",
      "lastMessage": "最近在准备搬家。",
      "tags": ["同学"],
      "maintenanceIntent": "maintain",
      "cadenceDays": 30
    }
  ]
}
```

联系人最终上限为 3,000 位；原始消息文件上限仍为 20,000 条，因为多条消息可能只归纳成一位联系人。合并后的总人数也会再次校验，超过上限时不会部分写入。

## 隐私边界

- 页面不包含分析脚本或远程字体；业务网络仅限同源本机 API，WeFlow 代理仅允许回环地址和固定只读端点。只读 API 不开放 CORS，所有写入还会额外校验 Host 与 Origin。
- 联系人、聊天摘要、标签和提醒状态的权威来源是本机 SQLite；`localStorage` 只是可丢弃的恢复缓存，清理浏览器不会删除主数据。
- 新 SQLite 为空但浏览器存在旧缓存时，页面会明确询问是否迁移；不会在后台静默把缓存提升为权威数据。
- 恢复备份、恢复演示数据和清空数据会先创建写前快照，但仍必须通过 `changeId` 并发校验；旧标签页不能用破坏性操作覆盖新状态。
- SQLite、滚动快照和导出的 JSON 都不是加密保险箱；拥有本机账户权限的人仍可能读取内容。
- 与主数据库位于同一存储磁盘的快照能防浏览器清理和多数误操作，但不能防磁盘物理损坏；重要数据仍应另存一份到不同磁盘。
- 应用关闭后不会可靠地在后台弹出提醒；当前版本会在你再次打开应用时重新计算到期状态。

## 批量整理与撤销合同

- `POST /api/state/batch-tag` 接收 `expectedChangeId`、`operationId`（浏览器生成的 UUID v4）、`action`、`tagId`、`contactIds` 和 `scopeLabel`。服务器会去重 ID，并只记录权威状态中真正发生标签变化的联系人；同一事务会把 `operationId` 保存为撤销 ID，便于超时后准确判断这次操作是否已经落盘。
- 成功写入会在同一个 SQLite 事务中更新状态并替换唯一的 `pendingUndo`；第二批操作会覆盖第一批的撤销入口。
- `POST /api/state/batch-tag/undo` 接收 `expectedChangeId` 和 `undoId`。服务器同时校验状态版本、撤销 ID、撤销对应的状态版本和 45 秒服务端时钟；到期时刻本身即拒绝撤销。
- `GET /api/state` 与所有状态写入响应都会成对返回 `state`、公共 `pendingUndo` 和 `serverNow`。公共撤销信息不包含联系人 ID；浏览器即使丢失写入响应，也能通过下一次 GET 恢复入口。写请求在网络、响应读取或协议校验阶段结果不明时不会盲目重试，而是读取 SQLite 权威状态；只有撤销 ID 与本页 `operationId` 相同才会把成功归因给本页。
- 任意普通 `PUT /api/state` 成功后会在同一事务中清除旧撤销；CAS 冲突不会清除。破坏性 PUT 从写前备份开始就登记写屏障，期间的 GET 会等待写入提交或失败，避免把仍可能被覆盖的旧状态误报为最终结果。SQLite v1 会事务迁移到 v2，高于 v2 的数据库会拒绝启动而不会被降级。
- 独立数据库快照在临时副本中删除 `pendingUndo` 并完成完整性检查后才原子发布；主数据库中的未到期撤销记录不受影响。

## 项目结构

- `index.html`：语义结构和原生对话框。
- `styles.css`：节律仪视觉系统、响应式与可访问性样式。
- `src/domain.js`：分类、日期、提醒和问候文案的纯逻辑。
- `src/importer.js`：JSON / CSV 解析、消息归纳与过滤。
- `src/background-prompt.js`：不接触联系人隐私的内置外观生图提示词。
- `src/visual-theme.js`：浅色 / 深色 / 跟随系统外观切换。
- `src/storage.js`：状态深校验、浏览器缓存与 JSON 备份合同。
- `src/local-api.js`：浏览器到同源本机服务的唯一网络入口。
- `src/app.js`：界面渲染、分页、预览和 SQLite 权威提交。
- `server/state-repository.mjs`：本机 SQLite、CAS 事务、历史与快照。
- `server/weflow-adapter.mjs`：固定回环地址的 WeFlow 直连适配器。
- `server/contact-source-registry.mjs`：跨平台联系人读取器目录、能力声明与预览合同。
- `server.mjs`：仅监听本机地址的 API 与静态白名单服务器。
- `PRODUCT.md`、`DESIGN.md`：产品和视觉决策记录。
