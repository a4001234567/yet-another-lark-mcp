---
name: feishu-ssh
description: Execute commands on remote machines — win_exec (Windows) and pi_exec (Raspberry Pi 5), both over the frp tunnel.
---

# feishu_ssh

Two remote-exec tools, both routed through the frp tunnel:

| Tool | Target | Tunnel |
|------|--------|--------|
| `win_exec` | Remote Windows machine (shirosaki account) | SSH to 127.0.0.1:2226 |
| `pi_exec` | Remote Raspberry Pi 5 (shir0saki account) | SSH to 127.0.0.1:2227 |

## Quick Reference

| Tool | Required | Optional |
|------|----------|----------|
| `win_exec` | `command` | `cwd` |
| `pi_exec` | `command` | — |

---

## Rules

- **win_exec:** Windows 路径用反斜杠需双写转义，也可用正斜杠 + 完整路径。
- **pi_exec:** 报 SSH 错先查命令格式，往往不是连接问题。
- 有副作用的操作（装包、烧录、改配置、删文件）先发 confirm 卡再执行。
- 重型操作先评估（`du -sh`、单个包体积），避免搞死服务器；不开全盘 `find /`，不并行重型任务。
- 改源码不自启，改完告诉缺月手动重启 MCP。
