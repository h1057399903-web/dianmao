# 点卯 dianmao

omp 扩展：主会话每分钟清点一次 task 小工（子代理），出问题就把报警作为 aside 消息送进主会话（主会话空闲时会直接唤醒它）。

| 情况 | 判断方法 | 默认 |
|---|---|---|
| 卡住 | 最后一条对话消息多久没更新（不看文件修改时间，收工后的用量探测会刷新它） | 20 分钟 |
| 空转 | 每隔一段时间把新增的工具操作摘要交给 SubQ，问"有没有可核对的进展" | 每 30 分钟、至少 10 次操作、概率 < 0.2 报警 |

不算在岗、不会报警的：已有 `<名字>.md` 结果、最后一条是最终回复 / 被取消 / 报错、有 `session_exit`、超过 6 小时没动、`__advisor*` 记录。

同一次卡住只报一次；SubQ 调用失败就跳过这一轮，不影响卡住检查。

## 安装

```sh
omp plugin install git+https://github.com./h1057399903-web/dianmao.git
omp plugin upgrade dianmao   # 以后更新
```

`github.com.` 末尾那个点是故意的：仓库是私有的，bun 遇到 GitHub 地址只走匿名 tarball 接口，会 404（[oven-sh/bun#19618](https://github.com/oven-sh/bun/issues/19618)）；加点后改走 git，用本机 git 凭据（`gh auth setup-git`）拉取。

本地改代码时用 `omp plugin link /path/to/dianmao` 代替，改完重开窗口即生效。

重开 omp 窗口生效，之后每个新窗口都自动带上。

SubQ 密钥：优先读环境变量 `SUBQ_API_KEY`，否则读 macOS 钥匙串条目 `omp-subq-snap`（和 subq-snap MCP 共用）。都没有时只做卡住检查。

## 调参（环境变量）

`DIANMAO_STALL_MIN` `DIANMAO_WINDOW_MIN` `DIANMAO_SPIN_MIN` `DIANMAO_SPIN_MIN_OPS` `DIANMAO_SPIN_THRESHOLD` `DIANMAO_POLL_SEC`

## 测试

```sh
bun test
```
