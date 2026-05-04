# Windows 中文文档编码指南

## 背景

在当前 Windows 环境中，中文 Markdown 文件应统一保存为无 BOM UTF-8。Git Bash、Node.js 和大多数编辑器可以稳定处理这种编码。

如果直接用 Windows PowerShell 5.1 的默认输出或默认写文件方式，可能出现两类问题：

- 控制台输出乱码：文件本身是 UTF-8，但 PowerShell 按系统 ANSI 代码页输出，外层工具再按 UTF-8 解码，表现为 `鐢ㄤ簬` 这类 mojibake。
- 写文件带 BOM 或编码不一致：`Set-Content`、`Out-File` 在不同 PowerShell 版本中的默认编码不一致，容易让中文文档和 JSON 配置出现不可见差异。

## 推荐做法

优先使用 Git Bash 查看和验证中文文档：

```bash
sed -n '1,120p' docs/WINDOWS_UTF8.md
file -bi docs/WINDOWS_UTF8.md
xxd -l 3 docs/WINDOWS_UTF8.md
```

预期结果：

- `file -bi` 显示 `charset=utf-8`。
- `xxd -l 3` 不显示 `ef bb bf`，表示没有 BOM。

如果必须在 PowerShell 中读取中文文件，先显式设置输出编码：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-Content -Raw -Encoding UTF8 .\docs\WINDOWS_UTF8.md
```

如果必须在 PowerShell 中写中文文件，使用 .NET API 显式写无 BOM UTF-8：

```powershell
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("C:\path\to\file.md", $content, $utf8NoBom)
```

## 项目约束

- 中文文档、提示词、技能说明优先用编辑器或 Git Bash/Node.js 创建和检查。
- 避免用 PowerShell 5.1 的默认 `Set-Content`、`Out-File` 写中文 Markdown 或 Pi 配置 JSON。
- 修改 `~/.pi/agent/*.json` 时必须确认文件是无 BOM UTF-8。
- 看到 `鐢ㄤ簬`、`涓`、`鍙` 这类字符时，先判断是显示链路乱码还是文件内容已经损坏。判断方式是用 Git Bash 读取同一个文件，并检查原始字节。
