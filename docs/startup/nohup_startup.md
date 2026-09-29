# nohup 启动

脚本默认读取脚本目录下的 `config.json`：

脚本要求配置文件事先存在，可复制 `samples/config_web.json` 并调整端口（样例为 `19090`）。无配置文件启动请使用[快速开始](../quick-start.md)中的直接运行方式。

```bash
chmod +x nohup_manage_simple_one_api.sh
./nohup_manage_simple_one_api.sh start
./nohup_manage_simple_one_api.sh stop
./nohup_manage_simple_one_api.sh restart
```

也可以在启动时传入配置文件：

```bash
./nohup_manage_simple_one_api.sh start /opt/simple-one-api/config.json
```

日志默认写入脚本目录下的 `simple-one-api.log`。

首次部署运行 `tail -n 100 simple-one-api.log`，复制 `Admin temporary bootstrap token:` 后的值，在远程 `/setup` 页面中解锁，再设置永久主密钥。
