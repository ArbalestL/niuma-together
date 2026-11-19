# NiuMa Together · 牛马脱敏器联机版

基于 [feiyuaq/niuma](https://github.com/feiyuaq/niuma) v0.1.0 的 Windows 联机版。当前版本 v1.1.0，Windows 文件版本为 1.1.0.0。

在桌面悬浮窗里看自己的实时工资，也可以和朋友一起看计薪、下班进度和心愿单。Windows 可以建房，手机用浏览器打开邀请链接即可加入。

## 使用

1. 完整解压 Windows 便携包，打开 niuma.exe。
2. 右键悬浮窗或托盘 →「联机房间」。填昵称后点「异地建房」或「本机建房」。
3. 复制房间面板里的邀请链接。手机用浏览器打开，Windows 可把链接贴进「邀请链接或房间码」。

异地建房会在后台启动房间服务和 Cloudflare 临时隧道。房主可以把 Windows 程序隐藏到托盘。退出托管程序会结束房间，重启隧道会分配新的临时地址。已有公网 HTTPS 房间服务也可以直接填写地址。完整操作见[中文使用说明](使用说明.txt)。

## 联机功能

- 完整与迷你悬浮窗都可显示好友计数器。迷你模式单人五位小数，多人四位小数，并支持只显示自己。
- 同一设备重复加入会恢复原成员，房主可在桌面和手机上移除成员。手机重新打开同一网址会尝试恢复有效的房间连接。
- 工资金额默认关闭共享。心愿进度可单独展示，手机开启关页同步后可由房间服务计算到当地午夜。
- 成员下班时，窗口会提醒「【用户名】下班了！拜拜了您」。

## 从源码运行

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
