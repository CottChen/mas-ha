# MAS MVP

MAS 是一个基于 Pi SDK 的多智能体执行原型，对外通过 ACP 让 AionUI 作为客户端连接。

## 命令

```bash
npm install
npm run doctor
./bin/mas acp
./bin/mas run "阅读当前项目并总结结构"
./bin/mas status
```

## AionUI 自定义 Agent 配置

在 AionUI 的自定义 ACP Agent 中配置：

```bash
/home/admin/mas-impl/bin/mas acp
```

默认权限策略是读操作自动通过，写文件、编辑文件和执行命令会向 AionUI 发起 `session/request_permission`。

如需高自主模式：

```bash
/home/admin/mas-impl/bin/mas acp --approve-all
```

## Pi 依赖

当前 MVP 直接引用本机 Pi 源码：

```text
/home/admin/mas/pi-mono
```

需要先在 Pi monorepo 中完成依赖安装和构建：

```bash
cd /home/admin/mas/pi-mono
npm install
npm run build
```

## 当前范围

- 已实现 ACP 初始化、建会话、加载会话、发送 prompt、取消 prompt 的外壳。
- 已实现 HA / Ego / Superego 的最小闭环编排。
- 已实现 Pi 工具事件到 ACP `session/update` 的映射。
- 已实现写、编辑、bash 的 ACP 权限请求。
- 已实现 SQLite run、agent_run、approval、audit 记录。

生产阶段暂未包含 Temporal、PostgreSQL、NATS、对象存储和远程控制面。
