# 第三方组件与来源

本项目根据公开功能独立实现，功能参考 [InfernalAzazel/ghost-job](https://github.com/InfernalAzazel/ghost-job)。本仓库不是原项目官方发行版，也不包含原版软件二进制或原版源码。

## 随包组件

| 组件 | 版本 | 用途 | 许可文件 |
| --- | --- | --- | --- |
| [Node.js](https://nodejs.org/) | 24.22.2 | 本地服务、SQLite 与浏览器连接 | Windows 包中的 `runtime/NODE-LICENSE.txt`（包含 Node 及所含第三方组件许可） |
| [CPython](https://www.python.org/downloads/release/python-31410/) | 3.14.10 | PDF 文本提取 | Windows 包中的 `runtime/python/LICENSE.txt` |
| [pypdf](https://pypi.org/project/pypdf/6.1.3/) | 6.1.3 | PDF 解析 | [`vendor/pypdf-LICENSE.txt`](vendor/pypdf-LICENSE.txt)，BSD-3-Clause |

运行环境只放在 Windows Release ZIP；Git 仓库存放源码、pypdf 模块 ZIP 及其许可。官方运行环境的下载地址和 SHA-256 固定在 [`runtime-manifest.json`](runtime-manifest.json)。

自有代码目前尚未指定开源许可证；源码公开可查看和下载。第三方组件始终按各自许可使用，不能将原项目名称、商标或第三方组件视为本项目独占资产。
