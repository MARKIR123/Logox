把所有对旧 `log(level, message)` 的调用改成新的 `logger.<level>(message)`，改完把 `logger.mjs` 里旧的 `log` 删掉，测试要全过。
