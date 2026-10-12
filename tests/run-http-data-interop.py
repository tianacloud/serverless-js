"""Run independently built Gateway and Agent fixtures with a real SQLite App.

Policy and binding setup are fixtures. This is data-path acceptance, not the
Control/Runtime/FUSE/S3 standard cold-start gate. All inputs are explicit.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--agent', type=Path, required=True)
parser.add_argument('--gateway', type=Path, required=True)
parser.add_argument('--sqlite-binary', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--playwright-module', type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
processes = []
logs = []
configs = []


def launch(command, cwd, environment, name):
    log = (out / (name + '.log')).open('w')
    logs.append(log)
    process = subprocess.Popen(command, cwd=cwd, env={**os.environ, **environment}, stdout=log, stderr=subprocess.STDOUT)
    processes.append(process)
    return process


def wait_file(path, process):
    for _ in range(600):
        if path.exists():
            return
        if process.poll() is not None:
            raise RuntimeError(f'fixture exited before creating {path}; inspect output logs')
        time.sleep(.1)
    raise RuntimeError(f'fixture startup timeout: {path}')


with tempfile.TemporaryDirectory(prefix='tiana-http-') as temporary:
    run = Path(temporary)
    try:
        app = launch([str(args.sqlite_binary.resolve()), '--data-socket', str(run / 'data.sock'),
                      '--sql-http-socket', str(run / 'http-data.sock'), '--database', str(run / 'app.db')], repo, {}, 'app')
        wait_file(run / 'http-data.sock', app)
        agent_config = out / 'agent.json'
        agent_config.unlink(missing_ok=True)
        agent = launch(['go', 'test', './internal/transport', '-run', '^TestExternalHTTPDataAgent$', '-count=1', '-v', '-timeout', '6m'],
                       args.agent, {'TIANA_HTTP_AGENT_CONFIG': str(agent_config), 'TIANA_HTTP_APP_RUN_DIR': str(run)}, 'agent')
        wait_file(agent_config, agent)
        configs.append((agent_config, 'done_address'))
        gateway_config = out / 'gateway.json'
        gateway_config.unlink(missing_ok=True)
        gateway = launch(['cargo', 'test', '-p', 'gateway-public', '--test', 'adversarial', 'external_http_data_agent_interop', '--', '--ignored', '--nocapture'],
                         args.gateway, {'TIANA_HTTP_AGENT_ADDRESS': json.loads(agent_config.read_text())['address'],
                                        'TIANA_HTTP_GATEWAY_CONFIG': str(gateway_config)}, 'gateway')
        wait_file(gateway_config, gateway)
        configs.insert(0, (gateway_config, 'done_port'))
        print('Real Gateway / Agent transport / SQLite ready; policy and binding setup are fixtures.', flush=True)
        drivers = [('node', 'http-data-interop.mjs')]
        if args.playwright_module:
            drivers.append(('browser', 'browser-http-data-interop.mjs'))
        failed = []
        for name, script in drivers:
            env = dict(os.environ)
            if args.playwright_module:
                env['TIANA_PLAYWRIGHT_MODULE'] = str(args.playwright_module.resolve())
            result = subprocess.run(['node', str(repo / 'tests' / script), str(repo / 'dist/index.js'), str(gateway_config)],
                                    cwd=repo, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=150)
            (out / (name + '.log')).write_text(result.stdout)
            print(result.stdout, flush=True)
            if result.returncode:
                failed.append(name)
        if failed:
            raise RuntimeError('failed drivers: ' + ', '.join(failed))
    finally:
        for path, key in configs:
            try:
                value = json.loads(path.read_text())[key]
                address = ('127.0.0.1', value) if isinstance(value, int) else (value.split(':')[0], int(value.split(':')[1]))
                socket.create_connection(address, 2).close()
            except OSError:
                pass
        for process in reversed(processes):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)
        for log in logs:
            log.close()
