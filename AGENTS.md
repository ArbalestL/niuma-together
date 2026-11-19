# 安装 NiuMa Together

- 用户要求安装或试用时，优先从 [GitHub Releases](https://github.com/ArbalestL/niuma-together/releases) 下载 Windows x64 联机便携包，文件名格式为 `niuma-together-v*-windows-x64.zip`。如果没有附件或只有源码，在仓库目录运行 `powershell -ExecutionPolicy Bypass -File .\build-portable.ps1`，使用生成的 dist 目录。
- 完整解压便携包。在同一目录检查 `niuma.exe`、`launch.mjs`、`room/server.mjs`、`runtime/node.exe` 和 `runtime/cloudflared.exe`。
- 用户要从桌面启动时，为解压目录中的 `niuma.exe` 创建快捷方式。单独复制 EXE 只适用于单机计薪。
- 启动后在「联机房间」选择「本机建房」或「异地建房」。用户只要求安装时，完成解压和文件检查即可。
