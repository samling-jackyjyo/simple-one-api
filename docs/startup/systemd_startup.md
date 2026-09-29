# 使用 systemd 服务

使用仓库根目录的 `install_simple_one_api_service.sh` 安装。第一个参数是应用目录，第二个可选参数是配置文件路径：

安装脚本要求可执行文件和配置文件都已存在。首次安装可将 `samples/config_web.json` 复制到应用目录并将 `server_port` 改成所需端口（样例为 `19090`）。若希望完全不准备配置文件，请使用[快速开始](../quick-start.md)中的单文件直接运行或 Docker 方式。

```bash
chmod +x install_simple_one_api_service.sh
sudo ./install_simple_one_api_service.sh /opt/simple-one-api /opt/simple-one-api/config.json
```

脚本会把日志写入 systemd journal，并将 SQLite 路径设置为应用目录下的 `config.db`。

```bash
sudo systemctl start simple-one-api
sudo systemctl stop simple-one-api
sudo systemctl restart simple-one-api
sudo journalctl -u simple-one-api -f
```

首次远程打开服务页面时，使用 `sudo journalctl -u simple-one-api -n 100 --no-pager` 找到 `Admin temporary bootstrap token:` 后的值，输入 `/setup` 后设置永久主密钥。完整步骤见[初始化向导](../quick-start.md#2-打开初始化向导)。
