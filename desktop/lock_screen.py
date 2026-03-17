import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib, GdkPixbuf
import requests
import threading
import hashlib
import io
import qrcode
import hmac
import random


def generate_unlock_key(challenge_code, institution_code, offline_secret):
    """HMAC-SHA256(challenge+institution, secret) → 6 haneli sayı"""
    msg = (challenge_code + institution_code).encode()
    digest = hmac.new(offline_secret.encode(), msg, hashlib.sha256).hexdigest()
    return str(int(digest[:8], 16) % 1000000).zfill(6)


class LockScreen(Gtk.Window):
    def __init__(self, api_url, institution_code="", offline_secret="", institution_name="", unlock_duration=30):
        super().__init__(title="Tulpar Kilit")
        self.api_url = api_url
        self.institution_code = institution_code
        self.offline_secret = offline_secret
        self.unlock_duration = unlock_duration
        self.session_id = None
        self._polling_active = True
        self._relock_timer_id = None
        self._qr_refresh_timer_id = None
        self.challenge_code = self._new_challenge()

        self.set_default_size(600, 800)
        self.set_position(Gtk.WindowPosition.CENTER)
        self.set_decorated(False)
        self.fullscreen()
        self.set_keep_above(True)
        self.set_modal(True)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        box.set_halign(Gtk.Align.CENTER)
        box.set_valign(Gtk.Align.CENTER)

        title = Gtk.Label()
        title.set_markup('<span size="xx-large" weight="bold">🔒 Tulpar Kilit</span>')
        box.pack_start(title, False, False, 0)

        info = Gtk.Label()
        info.set_markup('<span size="large">Kilidi açmak için QR kodu telefonunuzla taratın</span>')
        box.pack_start(info, False, False, 0)

        url_label = Gtk.Label()
        display_name = institution_name if institution_name else api_url
        url_label.set_markup(f'<span size="medium" weight="bold">{display_name}</span>\n<span size="small" color="#aaaaaa">{api_url}/unlock.html</span>')
        box.pack_start(url_label, False, False, 0)

        self.qr_image = Gtk.Image()
        box.pack_start(self.qr_image, False, False, 0)

        self.status_label = Gtk.Label()
        box.pack_start(self.status_label, False, False, 0)

        # --- Offline unlock bölümü ---
        separator = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        box.pack_start(separator, False, False, 4)

        offline_title = Gtk.Label()
        offline_title.set_markup('<span size="medium" color="#aaaaaa">İnternet yoksa — Çevrimdışı Kilit Açma</span>')
        box.pack_start(offline_title, False, False, 0)

        challenge_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        challenge_box.set_halign(Gtk.Align.CENTER)
        challenge_lbl = Gtk.Label()
        challenge_lbl.set_markup('<span size="medium" color="#cccccc">Kod:</span>')
        challenge_box.pack_start(challenge_lbl, False, False, 0)
        self.challenge_label = Gtk.Label()
        self.challenge_label.set_markup(
            f'<span size="x-large" weight="bold" color="white">{self.challenge_code}</span>'
        )
        challenge_box.pack_start(self.challenge_label, False, False, 0)
        box.pack_start(challenge_box, False, False, 0)

        key_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        key_box.set_halign(Gtk.Align.CENTER)
        key_lbl = Gtk.Label()
        key_lbl.set_markup('<span color="#cccccc">Unlock Key:</span>')
        key_box.pack_start(key_lbl, False, False, 0)
        self.key_entry = Gtk.Entry()
        self.key_entry.set_max_length(6)
        self.key_entry.set_width_chars(8)
        self.key_entry.set_placeholder_text("6 haneli")
        self.key_entry.connect("activate", self._on_offline_unlock)
        key_box.pack_start(self.key_entry, False, False, 0)
        unlock_btn = Gtk.Button(label="Aç")
        unlock_btn.connect("clicked", self._on_offline_unlock)
        key_box.pack_start(unlock_btn, False, False, 0)
        box.pack_start(key_box, False, False, 0)

        self.offline_status = Gtk.Label()
        box.pack_start(self.offline_status, False, False, 0)
        # --- /Offline unlock bölümü ---

        # --- Bilgisayarı kapat düğmesi ---
        shutdown_btn = Gtk.Button(label="⏻ Bilgisayarı Kapat")
        shutdown_btn.connect("clicked", self._on_shutdown)
        shutdown_btn.set_halign(Gtk.Align.CENTER)
        shutdown_btn.set_size_request(200, -1)
        # Kırmızımsı soluk stil
        shutdown_css = Gtk.CssProvider()
        shutdown_css.load_from_data(b"""
        button.shutdown-btn {
            background: rgba(239, 68, 68, 0.25);
            color: #f87171;
            border: 1px solid rgba(239, 68, 68, 0.4);
            border-radius: 6px;
            padding: 8px 16px;
            font-size: 14px;
        }
        button.shutdown-btn:hover {
            background: rgba(239, 68, 68, 0.5);
            color: white;
        }
        """)
        shutdown_btn.get_style_context().add_class("shutdown-btn")
        shutdown_btn.get_style_context().add_provider(shutdown_css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        box.pack_start(shutdown_btn, False, False, 12)
        # --- /Bilgisayarı kapat ---

        css = b"""
        window { background-color: #2c3e50; }
        label  { color: white; }
        """
        provider = Gtk.CssProvider()
        provider.load_from_data(css)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

        self.add(box)

        # Pencere kapatmayı engelle (Alt+F4, WM close vs.)
        self.connect("delete-event", lambda *_: True)

        # Tehlikeli kısayolları yakala ve engelle
        self.connect("key-press-event", self._on_key_press)

        GLib.timeout_add(500, self.generate_qr)
        GLib.timeout_add(2000, self.check_unlock_status)
        self.connect("show", lambda _: self._activate_grabs())

    def _activate_grabs(self):
        """Keyboard ve pointer grab ile tüm girişi yakala"""
        self.grab_add()
        window = self.get_window()
        if window:
            seat = Gdk.Display.get_default().get_default_seat()
            seat.grab(window, Gdk.SeatCapabilities.ALL, True, None, None, None)

    def _release_grabs(self):
        """Grab'ları serbest bırak"""
        self.grab_remove()
        seat = Gdk.Display.get_default().get_default_seat()
        seat.ungrab()

    def _on_key_press(self, widget, event):
        """Tehlikeli kısayolları engelle"""
        mods = event.state
        key = event.keyval
        ctrl = mods & Gdk.ModifierType.CONTROL_MASK
        alt = mods & Gdk.ModifierType.MOD1_MASK

        # Alt+F4, Alt+Tab, Ctrl+Alt+Del, Ctrl+Alt+Backspace, Super key
        if alt and key == Gdk.KEY_F4:
            return True
        if alt and key == Gdk.KEY_Tab:
            return True
        if ctrl and alt and key in (Gdk.KEY_Delete, Gdk.KEY_BackSpace):
            return True
        if key in (Gdk.KEY_Super_L, Gdk.KEY_Super_R):
            return True
        if alt and key in (Gdk.KEY_F1, Gdk.KEY_F2):
            return True
        if ctrl and alt and key in (Gdk.KEY_F1, Gdk.KEY_F2, Gdk.KEY_F3,
                                     Gdk.KEY_F4, Gdk.KEY_F5, Gdk.KEY_F6,
                                     Gdk.KEY_F7):
            return True
        # Escape engelle
        if key == Gdk.KEY_Escape:
            return True
        return False

    def _new_challenge(self):
        return str(random.randint(100000, 999999))

    def _on_offline_unlock(self, *_):
        entered = self.key_entry.get_text().strip()
        expected = generate_unlock_key(self.challenge_code, self.institution_code, self.offline_secret)
        if entered == expected:
            self.offline_status.set_markup('<span color="lightgreen">✓ Doğrulandı, kilit açılıyor...</span>')
            GLib.timeout_add(800, lambda: self.unlock_screen(self.unlock_duration) or False)
        else:
            self.offline_status.set_markup('<span color="red">✗ Hatalı key</span>')
            self.key_entry.set_text("")

    def _on_shutdown(self, *_):
        """Bilgisayarı onaysız kapat"""
        import subprocess
        self._release_grabs()
        subprocess.Popen(["systemctl", "poweroff", "-i"])


    def generate_qr(self):
        if self._qr_refresh_timer_id is not None:
            GLib.source_remove(self._qr_refresh_timer_id)
            self._qr_refresh_timer_id = None
        threading.Thread(target=self._generate_qr_thread, daemon=True).start()
        return False

    def _generate_qr_thread(self):
        try:
            params = {}
            if self.institution_code:
                params['institutionCode'] = self.institution_code
            response = requests.get(f"{self.api_url}/lock/desktop", params=params, timeout=5)
            result = response.json()

            if response.ok:
                self.session_id = result['sessionId']
                expires_at = result.get('expiresAt')

                # QR image'ı lokal olarak üret
                img = qrcode.make(result['qrData'], box_size=8, border=2)
                buf = io.BytesIO()
                img.save(buf, format='PNG')
                buf.seek(0)

                loader = GdkPixbuf.PixbufLoader.new_with_type('png')
                loader.write(buf.read())
                loader.close()
                pixbuf = loader.get_pixbuf()
                GLib.idle_add(self.qr_image.set_from_pixbuf, pixbuf)
                GLib.idle_add(self.status_label.set_markup,
                              '<span color="lightgreen">QR kod hazır</span>')

                if expires_at:
                    import time
                    ms_left = expires_at - int(time.time() * 1000)
                    seconds_left = max(int(ms_left / 1000) - 2, 5)
                    GLib.idle_add(self._schedule_qr_refresh, seconds_left)
            else:
                GLib.idle_add(self.status_label.set_markup,
                              '<span color="red">QR oluşturulamadı</span>')
        except Exception as e:
            print(e)
            GLib.idle_add(self.status_label.set_markup,
                          f'<span color="orange">Çevrimdışı — QR yok</span>')

    def _schedule_qr_refresh(self, seconds):
        self._qr_refresh_timer_id = GLib.timeout_add_seconds(seconds, self._on_qr_expired)
        return False

    def _on_qr_expired(self):
        self._qr_refresh_timer_id = None
        if self._polling_active:
            GLib.idle_add(self.status_label.set_markup,
                          '<span color="orange">QR süresi doldu, yenileniyor...</span>')
            self.generate_qr()
        return False

    def check_unlock_status(self):
        if not self._polling_active:
            return False
        if self.session_id:
            threading.Thread(target=self._check_status_thread, daemon=True).start()
        return True

    def _check_status_thread(self):
        try:
            response = requests.get(f"{self.api_url}/lock/status/{self.session_id}", timeout=2)
            result = response.json()
            if result.get('unlocked'):
                GLib.idle_add(self.unlock_screen, self.unlock_duration)
        except:
            pass

    def unlock_screen(self, duration_minutes):
        self._polling_active = False
        if self._qr_refresh_timer_id is not None:
            GLib.source_remove(self._qr_refresh_timer_id)
            self._qr_refresh_timer_id = None
        self._release_grabs()
        self.hide()
        self._relock_timer_id = GLib.timeout_add_seconds(
            duration_minutes * 60, self.lock_screen
        )
        return False

    def lock_screen(self):
        self._relock_timer_id = None
        self.session_id = None
        self._polling_active = True
        self.challenge_code = self._new_challenge()
        GLib.idle_add(self.challenge_label.set_markup,
                      f'<span size="x-large" weight="bold" color="white">{self.challenge_code}</span>')
        self.key_entry.set_text("")
        self.offline_status.set_markup("")
        self.show_all()
        self.fullscreen()
        self.set_keep_above(True)
        GLib.idle_add(self._activate_grabs)
        self.generate_qr()
        GLib.timeout_add(2000, self.check_unlock_status)
        return False
