# 点卯 dianmao

omp 扩展：主会话每分钟清点一次 task 小工（子代理），出问题就把报警作为 aside 消息送进主会话（主会话空闲时会直接唤醒它）。点卯只观察和报告；重试、催办、换人由主会话决定。

| 情况 | 判断方法 | 默认 |
|---|---|---|
| 卡住 | 最后一条对话消息多久没更新（不看文件修改时间，收工后的用量探测会刷新它）。正在跑显式设了长 `timeout` 的命令时，等到它的截止时间 + 2 分钟；命令返回后恢复默认 | 20 分钟 |
| 空转 | 从第一次看到小工起，每个固定窗口把这段时间的操作摘要交给 SubQ，问"有没有可核对的进展" | 每 30 分钟、至少 10 次操作、概率 < 0.2 报警 |

不算在岗、不会报警的：已有 `<名字>.md` 结果、最后一条是最终回复 / 被取消 / 报错、有 `session_exit`、超过 6 小时没动、`__advisor*` 记录。

同一次卡住只报一次。单个记录读不了（坏行、刚被移走）只跳过它，下一轮再看。SubQ 失败或超时就跳过这个窗口；等回答期间小工收工、换了会话或已进入下一个窗口，旧结论直接丢弃。

**发给 SubQ 的内容**：每次调用只有工具名、成功/失败/进行中、耗时、模型自己写的一句意图（截到 60 字），以及参数指纹（参数相同则指纹相同，看不出内容）。原始命令、路径、文件正文都不发送。

## 安装

```sh
omp plugin install github:h1057399903-web/dianmao
omp plugin upgrade dianmao   # 以后更新
```

重开 omp 窗口生效，之后每个新窗口都自动带上。本地改代码时用 `omp plugin link /path/to/dianmao` 代替。

SubQ 密钥：优先读环境变量 `SUBQ_API_KEY`，否则读 macOS 钥匙串条目 `omp-subq-snap`（和 subq-snap MCP 共用）。都没有时只做卡住检查。

## 调参（环境变量）

`DIANMAO_STALL_MIN` `DIANMAO_WINDOW_MIN` `DIANMAO_SPIN_MIN` `DIANMAO_SPIN_MIN_OPS` `DIANMAO_SPIN_THRESHOLD` `DIANMAO_POLL_SEC`

## 测试

```sh
bun test
```
