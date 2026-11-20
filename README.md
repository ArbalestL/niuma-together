# NiuMa Together · 牛马脱敏器联机版

基于 [feiyuaq/niuma](https://github.com/feiyuaq/niuma) v0.1.0 的 Windows 联机版。当前版本 v1.2.0，Windows 文件版本为 1.2.0.0。[更新日志](CHANGELOG.md)

在桌面悬浮窗里看自己的实时工资，也可以和朋友一起看计薪、下班进度和心愿单。Windows 可以建房，手机用浏览器打开邀请链接即可加入。

## 下载并使用

在 [GitHub Releases](https://github.com/ArbalestL/niuma-together/releases/latest) 的 Assets 中选择 Windows x64 便携包。包内已附 Node.js、Cloudflare 隧道工具和房间服务。

如果只有源码，在仓库目录运行下列命令。脚本会下载并校验运行组件、编译客户端，并在 `dist\niuma-together-v1.2.0-windows-x64` 生成完整目录。

```powershell
powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
```

安装本软件时选 Releases 里的便携包。GitHub 的「Code → Download ZIP」与 Releases 下的「Source code」是源码包。只复制 niuma.exe 可以单机计薪，想开房请保留完整解压目录。想从桌面启动，可以为解压后的 niuma.exe 创建快捷方式。

1. 完整解压 Windows 便携包，打开解压目录里的 niuma.exe。
2. 右键悬浮窗或托盘 →「联机房间」。填昵称后点「创建公网房间」或「创建本地房间」。
3. 复制房间面板里的邀请链接。手机用浏览器打开，Windows 可把链接贴进「邀请链接或房间码」。

使用新版创建的公网房间会分享[固定手机入口](https://arbalestl.github.io/niuma-together/)的邀请链接。第一次使用时保存自己的班次和工资，之后在同一浏览器打开其他房主的邀请即可沿用。首次从旧版临时地址换到固定入口时，需要重新填写一次。局域网房间仍通过房主原地址打开。

创建公网房间会在后台启动房间服务和 Cloudflare 临时隧道。房主可以把 Windows 程序隐藏到托盘。退出托管程序会结束房间，重启隧道会分配新的临时地址。已有公网 HTTPS 房间服务也可以直接填写地址。完整操作见[中文使用说明](使用说明.txt)。

## 联机功能

- 完整与迷你悬浮窗都可显示好友计数器。迷你模式单人五位小数，多人四位小数，并支持只显示自己。
- 同一设备重复加入会恢复原成员，房主可在桌面和手机上移除成员。手机重新打开同一网址会尝试恢复有效的房间连接。
- 手机在自己的成员卡上显示实时金额。工资金额默认关闭共享，心愿进度可单独展示，手机开启关页同步后可由房间服务计算到当地午夜。
- 成员下班时，窗口会提醒「【用户名】下班了！拜拜了您」。

## 开发与源码编译

用 Windows PowerShell 运行 build.ps1 编译桌面客户端。使用已有服务地址时，桌面端只需要 Windows 的 .NET Framework 4.8。

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

如需从桌面程序一键建房，在程序同目录下的 runtime 放入便携版 [Node.js](https://nodejs.org/en/download) 的 node.exe 和 [Cloudflare 官方下载](https://developers.cloudflare.com/tunnel/downloads/)的 cloudflared.exe。这两个文件随便携包提供。

房间服务和手机网页可独立运行。使用 Node.js 20 或更新版本，在仓库目录执行下列命令。本机页面默认在 `http://127.0.0.1:8080`。Docker 和 HTTPS 部署见[房间服务说明](room/README.md)。

```sh
node room/server.mjs
node --test room/room.test.mjs
```

原始项目由 feiyuaq 发布，派生版沿用 [MIT 许可证](LICENSE)。

## 发布新版本

更新 Windows 产品版本和文件版本，在 CHANGELOG.md 加上同版本条目，最后把 .github/release-version.txt 改为对应的版本标签并推送到 main。GitHub Actions 会构建并测试 Windows 便携包，上传到草稿并校验 SHA-256，再发布 Release。带相同 ZIP 的已发布版本可以安全重跑。
