#!/usr/bin/env python3
"""Verify first-run setup and persistence in an isolated Docker container/volume.

Usage: python3 scripts/smoke-docker-setup.py simple-one-api:ci
Requires Docker and Python 3; never uses a real provider or existing data.
"""

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def main():
    image = sys.argv[1] if len(sys.argv) > 1 else "simple-one-api:ci"
    name = "simple-one-api-setup-test-" + uuid.uuid4().hex[:12]
    volume = name + "-data"
    bootstrap = "setup-smoke-bootstrap"
    permanent = "setup-smoke-permanent-key"
    created_container = False
    docker("volume", "create", "--label", "simple-one-api.test=setup", volume)
    try:
        docker("run", "-d", "--name", name, "--label", "simple-one-api.test=setup",
               "-p", "127.0.0.1::9090", "--mount", f"type=volume,src={volume},dst=/app/data",
               "-e", f"SIMPLE_ONE_API_BOOTSTRAP_TOKEN={bootstrap}", image)
        created_container = True
        port = docker("port", name, "9090/tcp").rsplit(":", 1)[1]
        origin = "http://127.0.0.1:" + port
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def request(path, key="", body=None):
            headers = {"Content-Type": "application/json"}
            if key:
                headers["Authorization"] = "Bearer " + key
            data = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(origin + path, data=data, headers=headers)
            try:
                with client.open(req, timeout=3) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()

        def ready():
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                try:
                    if request("/healthz")[0] == 200:
                        return
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(0.2)
            raise AssertionError("container did not become ready")

        ready()
        assert docker("exec", name, "id", "-u") != "0", "container must run as non-root"
        assert request("/api/setup/status") == (200, b'{"initialized":false}')
        assert b'<div id="root"></div>' in request("/setup")[1]
        assert request("/api/admin/config/draft")[0] == 401, "remote bootstrap must require a token"
        status, content = request("/api/admin/config/draft", bootstrap)
        assert status == 200
        draft = json.loads(content)
        assert draft["database_path"] == "/app/data/config.db"
        assert draft["config"]["enable_web"] is True
        draft["config"]["api_key"] = permanent
        payload = {"config": draft["config"], "note": "isolated setup smoke test"}
        status, content = request("/api/admin/config/revisions", bootstrap, payload)
        assert status == 201, content
        assert request("/api/setup/status") == (200, b'{"initialized":true}')
        assert request("/api/admin/config/draft", bootstrap)[0] == 401
        assert request("/api/admin/config/draft", permanent)[0] == 200
        docker("restart", name)
        # Docker may allocate a different host port after restarting a
        # container published with an ephemeral port.
        port = docker("port", name, "9090/tcp").rsplit(":", 1)[1]
        origin = "http://127.0.0.1:" + port
        ready()
        assert request("/api/setup/status") == (200, b'{"initialized":true}')
        assert request("/api/admin/config/draft", permanent)[0] == 200
        print("Docker setup passed: no config file, non-root writable volume, bootstrap auth, publish, restart persistence.")
    except Exception:
        if created_container:
            subprocess.run(["docker", "logs", "--tail", "30", name], check=False)
        raise
    finally:
        if created_container:
            docker("stop", "--time", "2", name)
            docker("rm", name)
        docker("volume", "rm", volume)


if __name__ == "__main__":
    main()
