#!/usr/bin/env python3
"""Tulpar Kilit — Masaüstü Başlatıcı Penceresi"""
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib
import subprocess
import os
import sys
import json
import time

STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".lock_state.json")


def read_remaining():
    """State dosyasından kalan süreyi saniye olarak döndürür. None = bilgi yok veya kilitli."""
    try:
        with open(STATE_FILE) as f:
            data = json.load(f)
        if data.get("locked", True):
            return None
        unlock_time = data.get("unlock_time", 0)
        duration = data.get("duration_minutes", 0)
        remaining = (unlock_time + duration * 60) - time.time()
        return max(0, remaining)
    except Exception:
        return None


class LauncherWindow(Gtk.Window):
    def __init__(self):
        super().__init__(title="Tulpar Kilit")
        self.set_default_size(340, 220)
        self.set_position(Gtk.WindowPosition.CENTER)
        self.set_resizable(False)
        self.set_border_width(24)

        # CSS
        css = b"""
        window { background-color: #2c3e50; }
        label  { color: white; }
        button.lock-btn {
            background: #e74c3c;
            color: white;
            font-size: 16px;
            padding: 12px 24px;
            border-radius: 8px;
            border: none;
        }
        button.lock-btn:hover { background: #c0392b; }
        button.cancel-btn {
            background: #7f8c8d;
            color: white;
            font-size: 14px;
            padding: 8px 20px;
            border-radius: 8px;
            border: none;
        }
        button.cancel-btn:hover { background: #95a5a6; }
        """
        provider = Gtk.CssProvider()
        provider.load_from_data(css)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        box.set_halign(Gtk.Align.CENTER)
        box.set_valign(Gtk.Align.CENTER)

        title = Gtk.Label()
        title.set_markup('<span size="x-large" weight="bold">🔒 Tulpar Kilit</span>')
        box.pack_start(title, False, False, 0)

        # Kalan süre etiketi
        self.timer_label = Gtk.Label()
        box.pack_start(self.timer_label, False, False, 0)

        # Ekranı Kilitle düğmesi
        lock_btn = Gtk.Button(label="Ekranı Kilitle")
        lock_btn.get_style_context().add_class("lock-btn")
        lock_btn.connect("clicked", self._on_lock)
        box.pack_start(lock_btn, False, False, 0)

        # Vazgeç düğmesi
        cancel_btn = Gtk.Button(label="Vazgeç")
        cancel_btn.get_style_context().add_class("cancel-btn")
        cancel_btn.connect("clicked", self._on_cancel)
        box.pack_start(cancel_btn, False, False, 0)

        self.add(box)

        # Zamanlayıcıyı başlat
        self._update_timer()
        self._timer_id = GLib.timeout_add_seconds(1, self._update_timer)

    def _update_timer(self):
        """Kalan süreyi SS:DD:SS formatında güncelle."""
        remaining = read_remaining()
        if remaining is not None and remaining > 0:
            total = int(remaining)
            hours = total // 3600
            minutes = (total % 3600) // 60
            seconds = total % 60
            if hours > 0:
                text = f'{hours:02d}:{minutes:02d}:{seconds:02d}'
            else:
                text = f'{minutes:02d}:{seconds:02d}'
            self.timer_label.set_markup(
                f'<span size="large" color="#2ecc71">Kalan süre: {text}</span>'
            )
        elif remaining is not None and remaining <= 0:
            self.timer_label.set_markup(
                '<span size="large" color="#e74c3c">Süre doldu — ekran kilitlenecek</span>'
            )
        else:
            self.timer_label.set_markup(
                '<span size="medium" color="#95a5a6">Kilit bilgisi yok</span>'
            )
        return True

    def _on_lock(self, _btn):
        """Kilit ekranını başlat ve bu pencereyi kapat."""
        script_dir = os.path.dirname(os.path.abspath(__file__))
        lock_script = os.path.join(script_dir, "tulpar_lock.py")
        subprocess.Popen([sys.executable, lock_script])
        self.close()

    def _on_cancel(self, _btn):
        self.close()


def main():
    win = LauncherWindow()
    win.connect("destroy", Gtk.main_quit)
    win.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
