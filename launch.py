"""Standalone WebView2 printer and isolated live-room login window."""
import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def room_id(raw):
    match = re.fullmatch(r'(?:https?://live\.douyin\.com/)?(\d{5,25})(?:[/?#].*)?', str(raw).strip())
    if not match:
        raise ValueError('请输入有效的直播间号或直播链接')
    return match[1]

def listening(port):
    with socket.socket() as sock:
        sock.settimeout(.3)
        return sock.connect_ex(('127.0.0.1', port)) == 0

def ensure_server(port=8080):
    url = f'http://127.0.0.1:{port}/'
    if listening(port):
        with urllib.request.urlopen(url, timeout=3) as response:
            if 'AVATAR PRINT STUDIO' not in response.read(100000).decode('utf-8', errors='replace'):
                raise RuntimeError(f'{port} 端口被其他程序占用')
        return url, None
    server = ThreadingHTTPServer(('127.0.0.1', port), partial(SimpleHTTPRequestHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return url, server

class DesktopApi:
    def __init__(self):
        self._live = None
        self._bridge = None
        self._room = None
        self._lock = threading.RLock()
        self._window = None
        self._live_restore = None
        self._live_min = None
        self._live_outer = None
        self._url = None
        self._live_window = None
        self._live_size = None

    def attach_window(self, window, url=None):
        self._window = window
        self._url = url or getattr(window, 'real_url', None)

    def open_live_window(self):
        """Open a second window that mirrors the print pipeline at 1080×1920.

        The main window keeps running untouched, so controls stay usable while the
        live window is what gets captured by OBS.
        """
        import webview
        if self._live_window is not None:
            try:
                if self._live_window in webview.windows:
                    self._live_window.restore()
                    return '直播窗口已经打开，已切到前台'
            except Exception:
                pass
            self._live_window = None
        if not self._url:
            return '页面地址不可用，无法打开直播窗口'
        import ctypes
        user32 = ctypes.windll.user32
        screen_w = user32.GetSystemMetrics(0)
        screen_h = user32.GetSystemMetrics(1)
        height = min(1920, int(screen_h * 0.94))
        width = round(height * 9 / 16)
        if width > screen_w * 0.94:
            width = int(screen_w * 0.94)
            height = round(width * 16 / 9)
        self._live_size = (width, height)
        sep = '&' if '?' in self._url else '?'
        self._live_window = webview.create_window(
            '头像打印直播 · 1080×1920',
            f'{self._url}{sep}live=1',
            width=width, height=height,
            x=max(0, (screen_w - width) // 2), y=max(0, (screen_h - height) // 2),
            min_size=(320, 568),
            background_color='#101318',
        )
        return f'已打开直播窗口 {width}×{height}（主窗口保留）'

    def live_window_open(self):
        """主窗口轮询用：直播窗口是否还开着（用户手动关掉后恢复主窗口渲染）。"""
        import webview
        try:
            return bool(self._live_window is not None and self._live_window in webview.windows)
        except Exception:
            return False

    def close_live_window(self):
        if self._live_window is None:
            return '直播窗口未打开'
        try:
            self._live_window.destroy()
        except Exception:
            pass
        self._live_window = None
        return '直播窗口已关闭'

    def _release_min_size(self):
        """WinForms clamps resizes to MinimumSize; lift it while the 9:16 frame is on."""
        form = getattr(self._window, 'native', None)
        if form is None:
            return None
        from System.Drawing import Size
        saved = form.MinimumSize
        form.MinimumSize = Size(1, 1)
        return saved

    def set_live_mode(self, on):
        """Resize the desktop window to a 9:16 live frame and back again."""
        window = self._window
        if window is None:
            return '桌面窗口不可用'
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        form = getattr(window, 'native', None)

        if on:
            if self._live_restore is None:
                self._live_restore = (window.width, window.height, window.x, window.y)
                self._live_min = self._release_min_size()
                self._live_outer = None
                if form is not None:
                    try:
                        r0 = wintypes.RECT()
                        user32.GetWindowRect(int(form.Handle.ToInt32()), ctypes.byref(r0))
                        self._live_outer = (r0.left, r0.top, r0.right - r0.left, r0.bottom - r0.top)
                    except Exception:
                        self._live_outer = None
            screen_w = user32.GetSystemMetrics(0)
            screen_h = user32.GetSystemMetrics(1)
            # Title bar + borders: the 9:16 ratio has to apply to the client area,
            # otherwise OBS captures a frame that is slightly off-ratio.
            chrome_w = chrome_h = 0
            scale = 1.0
            if form is not None:
                scale = getattr(form, '_scale', 1.0) or 1.0
                try:
                    hwnd = int(form.Handle.ToInt32())
                    outer, client = wintypes.RECT(), wintypes.RECT()
                    user32.GetWindowRect(hwnd, ctypes.byref(outer))
                    user32.GetClientRect(hwnd, ctypes.byref(client))
                    chrome_w = (outer.right - outer.left) - client.right
                    chrome_h = (outer.bottom - outer.top) - client.bottom
                except Exception:
                    chrome_w = chrome_h = 0
            avail_h = int(screen_h * 0.94) - chrome_h
            height = min(1920, avail_h)
            width = round(height * 9 / 16)
            if width + chrome_w > screen_w * 0.94:
                width = int(screen_w * 0.94) - chrome_w
                height = round(width * 16 / 9)
            window.resize(int(round((width + chrome_w) / scale)), int(round((height + chrome_h) / scale)))
            window.move(max(0, (screen_w - width - chrome_w) // 2), max(0, (screen_h - height - chrome_h) // 2))
            return f'直播竖屏 {width}×{height}（内容区）'

        if self._live_restore:
            width, height, x, y = self._live_restore
            self._live_restore = None
            try:
                window.resize(width, height)
                window.move(x, y)
            finally:
                if self._live_min is not None and form is not None:
                    form.MinimumSize = self._live_min
                    self._live_min = None
        return '已恢复桌面窗口'

    def open_live_room(self, raw):
        with self._lock:
            room = room_id(raw)
            if self._live and self._live.poll() is None:
                if room == self._room:
                    return '直播窗口已经打开，请切换到该窗口登录。'
                return '请先关闭已有直播窗口，再打开新的房间。'
            if listening(9224):
                raise RuntimeError('直播窗口端口 9224 已被占用，请关闭旧应用后重试')
            self.stop_capture()
            self._room = room
            (ROOT / '.bridge-room').write_text(room, encoding='utf-8')
            env = os.environ.copy()
            env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = '--remote-debugging-port=9224 --remote-debugging-address=127.0.0.1'
            self._live = subprocess.Popen([sys.executable, str(ROOT / 'launch.py'), '--live-room', room], cwd=ROOT, env=env)
            return '已打开独立直播窗口，请登录后点击“开始抓取”。'

    def start_capture(self, raw):
        with self._lock:
            room = room_id(raw)
            if not self._live or self._live.poll() is not None or room != self._room:
                raise RuntimeError('请先打开这个房间的独立直播窗口并登录')
            if self._bridge and self._bridge.poll() is None:
                return '数据桥已经运行。'
            if listening(8765):
                raise RuntimeError('旧数据桥仍占用 8765 端口，请关闭旧版启动程序')
            with urllib.request.urlopen('http://127.0.0.1:9224/json/list', timeout=3) as response:
                pages = json.load(response)
            if not any(re.match(r'https://live\.douyin\.com/' + room + r'(?:[/?#]|$)', p.get('url', '')) for p in pages):
                raise RuntimeError('直播窗口尚未进入该直播间，请先完成登录或验证')
            node = shutil.which('node')
            if not node:
                raise RuntimeError('未找到 Node.js')
            env = os.environ.copy()
            env['PRINTER_CDP_PORT'] = '9224'
            with open(ROOT / 'desktop-bridge.log', 'ab') as log:
                self._bridge = subprocess.Popen([node, str(ROOT / 'douyin-bridge.mjs'), room], cwd=ROOT,
                    env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
            return '数据桥已启动，正在连接直播评论。'

    def stop_capture(self, raw=None):
        with self._lock:
            if self._bridge and self._bridge.poll() is None:
                self._bridge.terminate()
                self._bridge.wait(timeout=5)
            self._bridge = None
            return '抓取已停止，可以继续在直播窗口观看。'

    def close(self):
        self.stop_capture()
        if self._live and self._live.poll() is None:
            self._live.terminate()
            self._live.wait(timeout=5)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--live-room')
    parser.add_argument('--server-only', action='store_true')
    parser.add_argument('--room')
    parser.add_argument('--capture', action='store_true')
    parser.add_argument('--port', type=int, default=8080, help='本地静态服务端口（默认 8080）')
    args = parser.parse_args()
    if args.live_room:
        import webview
        webview.settings['REMOTE_DEBUGGING_PORT'] = 9224
        room = room_id(args.live_room)
        webview.create_window('直播间登录 · ' + room, 'https://live.douyin.com/' + room, width=1180, height=800)
        webview.start(gui='edgechromium', private_mode=False, storage_path=str(ROOT / '.live-webview-profile'))
        return
    url, server = ensure_server(args.port)
    api = DesktopApi()
    try:
        if args.server_only:
            threading.Event().wait()
        else:
            import webview
            debug_port = os.environ.get('PRINTER_DEBUG_PORT')
            if debug_port:
                webview.settings['REMOTE_DEBUGGING_PORT'] = int(debug_port)
            window = webview.create_window('头像打印机 · 桌面版', url, js_api=api, width=1380, height=860,
                min_size=(900, 650), background_color='#0b0e14')
            api.attach_window(window, url)
            def start_requested_room():
                if not args.room:
                    return
                try:
                    print(api.open_live_room(args.room), flush=True)
                    if args.capture:
                        for _ in range(30):
                            if listening(9224):
                                try:
                                    print(api.start_capture(args.room), flush=True)
                                    return
                                except (OSError, RuntimeError):
                                    pass
                            threading.Event().wait(1)
                        print('直播窗口未就绪，请完成登录后点击开始抓取', flush=True)
                except Exception as exc:
                    print(str(exc), flush=True)
            webview.start(start_requested_room, gui='edgechromium', private_mode=False, storage_path=str(ROOT / '.printer-webview-profile'))
    except KeyboardInterrupt:
        pass
    finally:
        api.close()
        if server:
            server.shutdown()
            server.server_close()

if __name__ == '__main__':
    main()
