#!/usr/bin/env python3
"""GitHub-hosted ephemeral-only cross-UID SO_PEERCRED proof.

Runs as root ONLY in trusted push CI, forks exact unprivileged numeric UIDs.
Does NOT create users, touch system services, grant privileges to the runner,
or use sockets outside the disposable private temp directory.
"""
from __future__ import annotations

import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

RUNNER_UID = 65001
CONTROL_UID = 65002
IPC_GID = 65003
WRONG_UID = 65004
WRONG_GID = 65005
STATUS = b'{"version":1,"operation":"runner.status"}\n'
RELEASE = b'{"version":1,"operation":"release.request"}\n'
READ_ONLY = b'{"version":1,"status":"READ_ONLY","executionEnabled":false}\n'
DENIED = b'{"status":"DENIED"}\n'


def set_identity(uid: int, gid: int) -> None:
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)


def peer(socket_path: str, uid: int, gid: int, payload: bytes,
         allowed: set[bytes] | None = None, deny_connect: bool = False) -> None:
    pid = os.fork()
    if pid == 0:
        try:
            set_identity(uid, gid)
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.settimeout(5.0)
            try:
                client.connect(socket_path)
            except PermissionError:
                os._exit(0 if deny_connect else 11)
            if deny_connect:
                os._exit(12)  # Kernel must deny unauthorized group membership
            try:
                client.sendall(payload)
                client.shutdown(socket.SHUT_WR)
                answer = b''
                while len(answer) < 1024:
                    buf = client.recv(1024)
                    if not buf:
                        break
                    answer += buf
            except (BrokenPipeError, ConnectionResetError):
                # The unauthorized peer may be closed at the SO_PEERCRED gate.
                os._exit(0 if allowed == {DENIED} else 13)
            os._exit(0 if answer in (allowed or set()) else 14)
        except BaseException:
            os._exit(15)
    done, code = os.waitpid(pid, 0)
    assert done == pid and os.WIFEXITED(code) and os.WEXITSTATUS(code) == 0, (
        f'cross-UID IPC failed for uid={uid} gid={gid}, code={code}')


def wait_listen(sock: Path, server: subprocess.Popen[bytes]) -> None:
    until = time.monotonic() + 8.0
    while time.monotonic() < until:
        if server.poll() is not None:
            raise AssertionError(f'server exited before listen: {server.returncode}')
        if sock.exists():
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                    probe.settimeout(0.2)
                    probe.connect(str(sock))
                return
            except (FileNotFoundError, ConnectionRefusedError):
                pass
        time.sleep(0.025)
    raise AssertionError('group-bound UNIX socket never reached listen()')


def main() -> None:
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise AssertionError('Only ephemeral Linux root CI may run this test')
    with tempfile.TemporaryDirectory(prefix='panter-crossuid-') as folder:
        os.chown(folder, RUNNER_UID, IPC_GID)
        os.chmod(folder, 0o710)
        target = Path(folder) / 'runner.sock'
        # Checkout files may be unreadable to a different UID on hosted CI.
        # Copy only the status-only server into an isolated runner-owned path.
        script = Path(folder) / 'readonly_ipc.py'
        shutil.copyfile(Path(__file__).resolve().parents[1] / 'src/runner/readonly_ipc.py', script)
        os.chown(script, RUNNER_UID, IPC_GID)
        os.chmod(script, 0o500)
        argv = [sys.executable, '-B', str(script),
                '--socket', str(target), '--allow-uid', str(CONTROL_UID),
                '--socket-gid', str(IPC_GID)]
        server = subprocess.Popen(argv, preexec_fn=lambda: set_identity(RUNNER_UID, IPC_GID),
                                  stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            wait_listen(target, server)
            info = target.lstat()
            assert stat.S_ISSOCK(info.st_mode)
            assert stat.S_IMODE(info.st_mode) == 0o660
            assert info.st_uid == RUNNER_UID and info.st_gid == IPC_GID
            parent = target.parent.lstat()
            assert stat.S_IMODE(parent.st_mode) == 0o710
            peer(str(target), CONTROL_UID, IPC_GID, STATUS, {READ_ONLY})
            peer(str(target), CONTROL_UID, IPC_GID, RELEASE, {DENIED})
            peer(str(target), WRONG_UID, IPC_GID, STATUS, {DENIED})
            peer(str(target), WRONG_UID, WRONG_GID, STATUS, deny_connect=True)
            assert server.poll() is None, 'read-only server crashed'
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
            if server.stderr is not None:
                errors = server.stderr.read()
                assert server.returncode == 0, errors.decode('utf-8', 'replace')[:500]
        assert not target.exists(), 'runner socket cleanup failed'
    print('cross-UID SO_PEERCRED gate verified on disposable Linux UIDs')


if __name__ == '__main__':
    main()
