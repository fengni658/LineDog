# 线条小狗桌宠（LineDog）

LineDog 是一款运行在 Windows 桌面的线条小狗桌宠。运行时采用 Tauri 2、Vite 与
Vanilla TypeScript：角色动画时间线、状态机和物理计算由 TypeScript 维护；Rust 只承担
原生窗口、工作区、粗粒度指针事实和 Tray 能力。

本说明描述的是 **0.3.0 集成候选**，不是独立 QA 或最终发布结论。

## 0.3 用户可见行为

启动后，小狗会在工作区底部出现，并按以下优先级响应：

1. `IDLE` 动画层会在 2.5–6 秒的间隔眨眼，低概率连续眨两次；双眨眼仍属于 `IDLE`，不会创建新的行为状态。
2. 在 `IDLE/PAUSE` 与 `WALK` 之间随机切换；鼠标靠近时进入 `LOOK`，点击触发不会叠加的 `HAPPY` 反馈。
3. 开始拖拽会进入 `DRAG` 并播放专用 Drag 动画；松手后进入 `FALL`，落到 WorkArea 底部后播放 `LAND` 并回到 `IDLE`。

交互优先级为 `DRAG > HAPPY > LOOK > WALK/IDLE`。应用不主动追逐鼠标。

## 源码、发布与许可证边界

- 公开源码目标仓库是 [`fengni658/LineDog`](https://github.com/fengni658/LineDog)。它只能由确定性 allowlist 导出，不能从私有工作树直接整体推送。
- 既有私有历史仓库 `fengni658/LineDog-Source` 保持私有，且不会被更改远端、覆盖或改写历史。
- Windows 安装器、`latest.json`、校验和与发布说明只属于公开二进制渠道 [`fengni658/LineDog-Releases`](https://github.com/fengni658/LineDog-Releases)。其中不包含源码、角色制作源、参考图、候选图、工作目录、QA 证据、私钥或本地配置。
- 代码及其他未由资产许可证单独覆盖的软件文件采用 [MIT License](LICENSE)；最终运行时角色 PNG 与应用图标采用 [CC BY-NC-ND 4.0](ASSET-LICENSE.md)。
- 参考图、候选图、模型/draft、`public/character/work/**`、QA 证据、密钥与本地配置不在任何公开源码导出内，也不因上述许可证而获得授权。

`FREEWARE-NOTICE.txt` 说明带有 NC 运行时视觉资产的 LineDog 分发包不得用于商业用途、转售或重新打包；这不会改变 MIT 代码许可本身。

## Windows 安装与更新语义

当前候选面向 **Windows 11 x64**，产物为 **unsigned NSIS current-user installer**。这是 Windows
代码签名状态；Tauri updater 的元数据签名仍需要单独、显式注入的私钥材料，且不会被记录或打印。

更新检查由用户在 Tray 中主动发起。应用不会后台轮询、静默下载、静默安装或自动重启；当用户确认安装时，Windows updater 使用 `passive` 安装语义。Microsoft Store/MSIX、Windows 代码签名和自动后台更新都不在本轮范围内。

## 本地开发

请使用 PowerShell 7+：

```powershell
npm test
npm run typecheck
npm run build
Push-Location .\src-tauri
cargo fmt --check
cargo check
cargo test
Pop-Location
```

## 公开源码导出

以下命令只在被 `.gitignore` 排除的本地目录生成可审阅的公开源码候选，不创建仓库、不推送、不创建 PR，也不会修改当前私有 `origin`：

```powershell
.\scripts\export-public-source.ps1 -Version 0.3.0 -OutputDirectory .\.public-source\0.3.0
```

导出器只复制已跟踪且被 allowlist 分类的代码、运行时 PNG、图标、许可证和必要元数据；每个已导出文件的 SHA-256 会写入 `PUBLIC-SOURCE-MANIFEST.txt`。已跟踪但未被 allowlist 或明确排除的路径会导致导出失败。

## 本地发布候选

发布准备只允许明确授权的集成/发布负责人在 PowerShell 7+ 中执行。默认命令会运行
`npm test → npm run typecheck → npm run build → cargo fmt --check → cargo check → cargo test → NSIS build`，并在 `.release/<version>/` 收集安装器、其 updater 签名、`latest.json`、校验和、`FREEWARE-NOTICE.txt` 和中文发布说明。

签名材料必须通过 `-SigningKeyPath` 或 `LINEDOG_SIGNING_KEY_PATH` 显式提供；脚本不会读取、打印或依赖源码中的本机私钥路径。未提供材料时会在本地 fail-closed。

```powershell
.\scripts\publish-release.ps1 -SigningKeyPath '<explicit local key path>'
```

默认模式不会产生 Git 或 GitHub 远端副作用。`-Publish` 只适用于已经获得目标版本、公开源码 tag、GitHub Release 和安装器资产上传的逐项明确授权的场景；它要求公开源码仓库已有同版本 tag，同时要求二进制仓库尚无同版本 tag/Release。当前 Changeset 不授权最终 tag、GitHub Release 或安装器上传。
