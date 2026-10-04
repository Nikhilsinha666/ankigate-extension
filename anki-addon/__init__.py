# AnkiGate Bridge — tells the AnkiGate browser extension whether you are
# really looking at Anki.
#
# Why this exists: a Chrome extension cannot see the Windows/macOS desktop, so it
# has no way to know whether the app in front of you is Anki, a file manager, or
# a game. Anki itself knows exactly, so this add-on answers the question.
#
# It serves a tiny JSON status on http://127.0.0.1:8766 :
#
#   {"focused": true, "fullscreen": false, "maximized": true,
#    "minimized": false, "coverage": 0.99, "reviewing": true, "ts": 1690000000000}
#
# It also answers http://127.0.0.1:8766/focus by bringing the Anki window to the
# front, which is what "click Anki in AnkiGate's list" does — a browser cannot
# start or raise a desktop program by itself.
#
# Nothing leaves your computer through THIS add-on. The server binds to localhost only, so the
# only thing that can read it is a program already running on this machine.
#
# It does report a little more than window state, and this used to say otherwise, so it is worth
# being exact. Alongside the focus and review readings it reports the FRONT OF THE CARD YOU ARE
# ON — see _card_front and the long note above it — because the extension's video gate needs to
# know what you are studying in order to decide which YouTube videos are about it. That crosses
# from Anki to a browser extension on the same computer and no further.
#
# What the extension then does with it is the extension's business and is stated in its own
# settings page. One thing there is worth knowing about from this side: it has an optional
# "ask an AI whether this video is related" switch which, when the user turns it on, sends the
# card front to Google's Gemini API. It ships OFF, it says what it does before it is switched on,
# and nothing in this file is involved in it — but "no card content ever goes anywhere" is no
# longer a promise this add-on is in a position to make on the whole system's behalf, so it does
# not make it.

import ctypes
import json
import math
import os
import random
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from aqt import mw, gui_hooks
from aqt.qt import (QBrush, QColor, QFont, QLinearGradient, QPainter, QPen, QPixmap, Qt,
                    QTimer, QWidget)

# Anki has shipped on both PyQt5 and PyQt6, and they disagree about where enum
# members live: PyQt6 scopes them (Qt.WindowType.Tool), PyQt5 keeps them flat on the
# parent (Qt.Tool). Probing for a real member is the only reliable test — PyQt5 does
# define Qt.WindowType as a type, it just doesn't hang the members off it, so
# hasattr(Qt, "WindowType") answers yes on both and tells us nothing.
def _enum_home(owner, group, member):
    scoped = getattr(owner, group, None)
    return scoped if hasattr(scoped, member) else owner


_WT = _enum_home(Qt, "WindowType", "Tool")
_WA = _enum_home(Qt, "WidgetAttribute", "WA_TranslucentBackground")
_RH = _enum_home(QPainter, "RenderHint", "Antialiasing")


class _LASTINPUTINFO(ctypes.Structure):
    """Windows' answer to "when did this session last see a key or a mouse move?"

    Declared with plain ctypes types rather than the wintypes ones the rest of the Win32
    code uses, so it can live at module scope: wintypes is imported lazily inside
    _win32_api, which never runs at all on a machine that is not Windows. UINT and DWORD
    are both 32-bit unsigned on every Windows ABI, so these are the same two fields under
    another name.
    """
    _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_ulong)]

PORT = 8766
# Keep in step with manifest.json's human_version — the extension reads that file
# to decide whether the installed add-on is the one it shipped.
#
# 4.7: a third lock, "no new cards until today's goal is done". It refuses adding at the collection
# itself — add_note and friends, and the importers — so it holds for Anki's own Add window and for
# anything that adds through AnkiConnect or another add-on, not just for the windows the card lock
# guards. See the NO NEW CARDS section.
#
# 4.6: green glows like red instead of sweeping. 4.5 took the sweep away and ALSO replaced the soft
# deep haze with a 3px hard line, which was a change nobody asked for and the wrong one — the haze is
# what lets you register the state without looking at it. The haze is back, in all three colours, and
# green simply wears it now instead of washing a band of light across the card. The quicker red-to-
# green dissolve from 4.5 (0.22s) stays.
#
# 4.5: green stopped sweeping across the window on every change.
#
# 4.4: a YouTube frame the extension has PAUSED is no longer reported as stalled on the network. The
# rewind sends seekTo along with pauseVideo, and a seek leaves the player sitting in state 3 —
# BUFFERING — for as long as it stays paused, so a video we had stopped on purpose looked exactly like
# one waiting on a slow connection, and the camera window said "video loading" over it.
#
# Bumping this is not bookkeeping: it is the ONLY way anybody learns to reinstall. The extension
# compares the version it ships against the version the running add-on reports, and nags when they
# differ. Change the code and leave the number alone and that nag stays silent, so the fix sits in the
# extension folder while Anki goes on running the old copy — which looks exactly like the fix not
# working.
VERSION = "4.7"

# Chrome cannot start a desktop program — but Windows can, if something teaches it
# a URL that means "run Anki". This add-on registers one for the current user (no
# admin rights, nothing outside your own account), so clicking "Anki app" in
# AnkiGate opens Anki even when it isn't running. Anki has no URL scheme of its
# own on desktop, which is why we make one.
#
# LEGACY is the same scheme under the product's old name, and both keys are written.
# The extension updates itself from the Web Store while this add-on is updated by hand,
# so an extension still expecting the old name has to keep working — and registering a
# second key costs three idempotent writes into your own account. Only the new name is
# reported; the extension accepts either.
LAUNCH_SCHEME = "ankigate-anki"
LAUNCH_SCHEME_LEGACY = "focusgate-anki"

# AnkiGate opens a small camera window in Chrome and gives it this title. A
# normal browser window cannot put itself above other applications, so we do it
# for it — without activating it, so your typing stays in Anki.
#
# LEGACY, again, is the pre-rename title, and it is matched as well as the current one.
# This is the direction that cannot be helped from the browser side: a document has one
# title, so an extension older than this add-on still calls its camera window by the old
# name. Matching both means updating the add-on first is never the wrong order.
CAM_TITLE = "AnkiGate Cam"
CAM_TITLE_LEGACY = "FocusGate Cam"
CAM_TITLES = (CAM_TITLE, CAM_TITLE_LEGACY)

# Written on Anki's main thread by _sample(), read by the HTTP thread. Only
# plain numbers/booleans cross the boundary, so no locking is needed.
_state = {
    "focused": False,
    "focus_kind": "unknown",
    "cam_focused": False,
    "fullscreen": False,
    "maximized": False,
    "minimized": True,
    "coverage": 0.0,
    "reviewing": False,
    "state": "",
    "cam_found": False,
    "cam_pinned": False,
    "pin_error": 0,
    "pin_supported": sys.platform.startswith("win"),
    "launch_scheme": "",
    # Media on the card being reviewed. `media_readable` is the one that matters:
    # false means "we could not tell", which the extension treats as not gating.
    # `media_waiting` splits the not-playing case in two: stopped because you have not
    # pressed play, or stopped because the video is buffering. Both stop the clock; they
    # need different words on screen, since "press play" is not actionable at a spinner.
    "media_present": False,
    "media_playing": False,
    "media_readable": False,
    "media_waiting": False,
    # Answers to the unlock gates the extension can't work out for itself — how many
    # cards are still due, how many DIFFERENT cards you have answered, and how many
    # of your reviews you got right. See the goals section further down for why none
    # of these can be had from outside Anki.
    "goals": {"for": "", "due": -1, "cards": 0, "pass": 0, "again": 0, "at": 0},
    # What the card in front of you is about, so the extension can decide whether a video is
    # about the same thing. The FRONT only, as plain text, capped — see _card_text.
    #
    # This is the one thing in this payload that is content rather than window state, and the
    # header of this file promised it would not be. So, precisely: it is the front field of the
    # card you are looking at this second, it never leaves your machine (the extension does the
    # matching locally — see keywords.js), it is blank the moment you are not reviewing, and it
    # is only read at all when you have switched the video gate on. That is a narrower promise
    # than the old one, and it is written here rather than quietly broken.
    "card_front": "",
    # Which card, so the extension can tell "you moved to a new card" from "the same card was
    # re-rendered". Question and answer sides of one card are one id, which is the point.
    "card_id": 0,
    # Is the collection locked against editing right now? A reading, not a request: the
    # extension asks via POST /lock and this says what actually happened.
    "lock_on": False,
    # And is the add-on manager locked? Separate switch, so it is reported separately rather
    # than folded into lock_on — the extension's Settings shows the two as two rows and would
    # otherwise have no way to tell which of them actually took effect.
    "lock_addons_on": False,
    # And is adding new cards refused? The third switch, reported on its own for the same reason.
    "lock_new_on": False,
    # Seconds since a key or the mouse was last touched, or -1 for "cannot tell" — which is
    # what a machine that is not Windows always says. See _sample_input.
    "idle_sec": -1.0,
    "version": VERSION,
    "ts": 0,
}

_launch_scheme = ""


def _anki_exe():
    """The program to run to start Anki. The packaged app is anki.exe; running from
    source gives a bare python.exe, which must never be registered — it would
    launch an interpreter, not Anki."""
    try:
        exe = sys.executable or ""
        if exe and os.path.basename(exe).lower().startswith("anki"):
            return exe
    except Exception:
        pass
    return ""


def _register_one_scheme(winreg, scheme, cmd):
    """One protocol handler, written command-first.

    The order is the point. Windows treats a key carrying "URL Protocol" as a registered
    scheme whether or not anything is behind it, so writing that first and then failing
    on \\shell\\open\\command left the machine claiming the scheme with no program to
    run — an error dialog instead of Anki, and this function would meanwhile have
    reported "no launcher". Writing the command first means a partial failure leaves a
    key Windows will not act on at all, which is the harmless shape.
    """
    base = r"Software\Classes\%s" % scheme
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open\command") as k:
        # No "%1". Windows hands a protocol handler the whole URL as an argument,
        # and Anki treats positional arguments as files to import — so passing it
        # "ankigate-anki://open" would pop an import error dialog on every
        # launch. Leaving %1 off means Windows starts Anki with no arguments,
        # which is exactly what we want. The URL carries no information anyway;
        # it exists only to mean "run this program".
        winreg.SetValueEx(k, None, 0, winreg.REG_SZ, cmd)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\DefaultIcon") as k:
        winreg.SetValueEx(k, None, 0, winreg.REG_SZ, cmd)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as k:
        winreg.SetValueEx(k, None, 0, winreg.REG_SZ, "URL:AnkiGate Anki launcher")
        winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")


def _register_launcher():
    """Write the one-URL launcher into HKEY_CURRENT_USER. Idempotent, so running it
    on every start also repairs it after Anki is moved or updated."""
    global _launch_scheme
    if not sys.platform.startswith("win"):
        return
    exe = _anki_exe()
    if not exe:
        return
    try:
        import winreg
        cmd = '"%s"' % exe
        _register_one_scheme(winreg, LAUNCH_SCHEME, cmd)
        _launch_scheme = LAUNCH_SCHEME
    except Exception:
        _launch_scheme = ""
    # The old name, for an extension that has not updated yet. Its own try, because
    # failing to write a compatibility key must not take the working one down with it.
    try:
        import winreg
        _register_one_scheme(winreg, LAUNCH_SCHEME_LEGACY, '"%s"' % exe)
    except Exception:
        pass





def _app_is_active(win):
    """Fallback for non-Windows: does Qt think this window is the active one."""
    active = False
    try:
        active = bool(win.isActiveWindow())
    except Exception:
        pass
    try:
        st = win.app.applicationState()
        # Qt.ApplicationActive == 4 in both Qt5 and Qt6.
        active = active and int(st) == 4
    except Exception:
        pass
    return active


def _foreground_kind():
    """Which app owns the window you're actually working in:

        "anki"    any window of this Anki process (main window, Browse, dialogs)
        "cam"     AnkiGate's own little camera window
        "other"   something else entirely — Explorer, an IDE, a game
        "unknown" we couldn't tell (not Windows)

    Asking the OS which window is in the foreground is the only reliable answer.
    Qt's isActiveWindow() lies in both directions, and it also can't tell that
    AnkiGate's camera window belongs to your study session rather than to
    "some other app" — which is why clicking the camera used to pause the clock.
    """
    api = _win32_api()
    if not api:
        return "unknown"
    u, wintypes = api["u"], api["wintypes"]
    try:
        fg = u.GetForegroundWindow()
        if not fg:
            return "other"
        fg_i = int(fg)
        if fg_i in _cam_hwnds:
            return "cam"
        pid = wintypes.DWORD(0)
        u.GetWindowThreadProcessId(wintypes.HWND(fg_i), ctypes.byref(pid))
        return "anki" if pid.value == os.getpid() else "other"
    except Exception:
        return "unknown"


def _sample():
    try:
        win = mw
        if win is None:
            return
        minimized = False
        try:
            minimized = bool(win.isMinimized())
        except Exception:
            pass

        # How much of the screen the window covers. Catches a window that was
        # dragged to fill the screen without being formally "maximised".
        coverage = 0.0
        try:
            geo = win.frameGeometry()
            # QWidget.screen() only exists from Qt 5.14. The fallback used to be
            # win.geometry() — the window measured against ITSELF, which divides out
            # to about 1.0 whatever size the window is. So on older Anki builds this
            # branch fired on every single sample and reported "fills the screen"
            # permanently: a postage-stamp Anki window counted as full-screen study.
            #
            # Failing closed instead. No way to ask how big the screen is means no
            # coverage claim, and the extension then relies on the real
            # maximised/fullscreen flags, which are always trustworthy.
            avail = None
            try:
                avail = win.screen().availableGeometry()
            except Exception:
                try:
                    from aqt.qt import QGuiApplication
                    scr = QGuiApplication.primaryScreen()
                    avail = scr.availableGeometry() if scr else None
                except Exception:
                    avail = None
            if avail is not None:
                area = float(max(1, avail.width() * avail.height()))
                coverage = (geo.width() * geo.height()) / area
        except Exception:
            pass

        # Working in Anki counts, and so does clicking AnkiGate's own camera
        # window — that's part of studying, not a different app.
        kind = _foreground_kind()
        if kind == "unknown":
            focused = _app_is_active(win) and not minimized
        else:
            focused = kind in ("anki", "cam") and not minimized

        # Only while the reviewer is actually showing a card. Off the review screen there is no
        # current card, so reporting the last one would leave the video gate open on the
        # keywords of a card you finished with ten minutes ago — which is the whole session,
        # since the congratulations screen and the deck list are not reviewing.
        #
        # The extension treats "no keywords" as "no video is justified", so blank here is the
        # strict answer rather than a gap.
        reviewing = getattr(win, "state", "") == "review"
        _state.update(_media_view())
        _state.update({
            "goals": _goals,
            "card_front": _card_front if reviewing else "",
            "card_id": _card_id if reviewing else 0,
            "lock_on": bool(_lock_active()),
            "lock_addons_on": bool(_lock_addons_active()),
            "lock_new_on": bool(_lock_new_active()),
            # Rounded to tenths. It is compared against a whole number of seconds, so the
            # extra digits would only be noise travelling over the wire on every poll.
            "idle_sec": round(_input_idle, 1),
            "focused": focused,
            "focus_kind": kind,
            "cam_focused": kind == "cam",
            "fullscreen": bool(win.isFullScreen()),
            "maximized": bool(win.isMaximized()),
            "minimized": minimized,
            "coverage": round(coverage, 3),
            "reviewing": getattr(win, "state", "") == "review",
            "state": str(getattr(win, "state", "")),
            # So AnkiGate can tell you whether the floating camera window is
            # really being held on top, instead of you finding out the hard way.
            "cam_found": len(_cam_hwnds) > 0,
            "cam_pinned": bool(_cam_pinned),
            "pin_error": int(_pin_error),
            "pin_supported": sys.platform.startswith("win"),
            # Are the title-bar buttons actually off the camera window right now? Reported so
            # the extension can stop guessing: it keeps a reopen-on-close fallback for the
            # cases this cannot cover — another platform, an older add-on, a refusal from
            # Windows — and the settings page can say which of the two is doing the work.
            "cam_close_blocked": bool(_cam_close_blocked),
            "close_error": int(_close_error),
            # Told to the extension so it knows it can start Anki later, when this
            # add-on isn't running to be asked.
            "launch_scheme": _launch_scheme,
            "version": VERSION,
            "ts": int(time.time() * 1000),
        })
    except Exception:
        # Never let a sampling hiccup disturb Anki.
        pass


_win32 = None
_cam_hwnds = []         # every top-level window named CAM_TITLE (usually one)
_cam_pinned = False
_pin_error = 0          # last Windows error code from pinning (5 = access denied)

# ---------------------------------------------------------------------------
# Are your hands on the machine?
#
# The extension can watch a web page for a mouse that has stopped moving; it cannot watch
# Anki, which is a desktop app on the other side of a wall Chrome will not let it through.
# So the reading is taken here and reported like every other reading in this file, and the
# extension decides what it means — the same division as the foreground and media checks.
#
# WHY THIS IS NOT A Qt EVENT FILTER. An app-wide filter would see keystrokes and clicks
# separately, which would be better, and it costs a Python call for every event Qt
# delivers to every object in Anki — thousands a second while a card is being drawn. It
# would also miss most of what matters: the reviewer is a Chromium webview, and input that
# lands inside it is not delivered as Qt events at all. So the OS is asked instead. One
# call, twice a second, and it sees everything.
#
# System-wide rather than Anki-only, and that is fine rather than merely acceptable: this
# reading is only ever consulted while the add-on has already said Anki is the window in
# front of you, so "somebody touched this machine" and "somebody touched Anki" are the same
# statement at the moment it is asked.
#
# -1 means "cannot tell" and is what a machine that is not Windows reports. The extension
# treats it as not gating, exactly as it does an unreadable video — a check that cannot see
# must stand aside, not accuse.
_input_idle = -1.0


def _sample_input():
    """Seconds since this session last saw a key press or a mouse movement.

    Called from the 500 ms tick, so the answer is at most half a second old — well inside
    the resolution of a setting whose smallest value is five seconds.
    """
    global _input_idle
    api = _win32_api()
    if not api:
        _input_idle = -1.0
        return
    try:
        lii = _LASTINPUTINFO()
        lii.cbSize = ctypes.sizeof(_LASTINPUTINFO)
        if not api["u"].GetLastInputInfo(ctypes.byref(lii)):
            _input_idle = -1.0
            return
        # Masked to 32 bits because both sides of this subtraction are 32-bit tick counts
        # that wrap roughly every 49 days. In C the wrap cancels itself; Python's integers
        # are unbounded, so without the mask a wrap between the two readings would give a
        # hugely negative idle time — which, being smaller than any timeout, would read as
        # "actively working" forever rather than as an error.
        elapsed = (api["k"].GetTickCount() - lii.dwTime) & 0xFFFFFFFF
        _input_idle = elapsed / 1000.0
    except Exception:
        _input_idle = -1.0

# ---------------------------------------------------------------------------
# Taking the title bar's buttons away while you are in Anki
#
# Chrome gives an extension no way to open a window without a close button, and no way to
# refuse a close. So the extension's own answer was to put a fresh window up the instant
# the old one went — which works, but you see it: press ✕ and the window blinks rather
# than staying put. From this side it can be done properly. The camera window belongs to
# Chrome, but its title bar is a Windows title bar, and the buttons on it are one style
# bit: clear WS_SYSMENU and the ✕, the − and the □ are simply not drawn. Nothing to press,
# so nothing to refuse, and Alt+F4 goes with them.
#
# ONLY WHILE ANKI IS THE APP IN FRONT. Anywhere else the buttons come straight back,
# because a window you cannot close while you are not even studying is not a check on
# anything, it is a fault. That is the same rule the extension applies to its reopen, and
# the same rule the un-minimise below already applies, so all three agree.
#
# What this deliberately does NOT do is prevent the EXTENSION from closing the window.
# chrome.windows.remove does not go through the title bar, so every legitimate close still
# works: you finished, the day is off, you switched the timer off, Anki quit. That last one
# matters most — it is what stops a buttonless window outliving the thing it belongs to.
#
# Cross-process SetWindowLongW is not something Microsoft documents as supported, and the
# note further down about WS_EX_TOPMOST is a real scar from that. This case is different in
# kind: WS_EX_TOPMOST asks the compositor to reorder windows, which is why it needs
# SetWindowPos, whereas WS_SYSMENU only changes how the frame draws itself and is picked up
# by asking for a frame recalculation. It can still be refused — a different integrity
# level will do it — so every change is read back.
#
# THE LIMIT OF WHAT THAT READ-BACK PROVES, stated plainly because it would be easy to read
# more into it. It proves the style bit changed. It does NOT prove the buttons stopped being
# drawn, and on Windows those are not always the same thing: Chrome often draws its own
# non-client area — its own caption, its own −/□/✕ — in which case the bit is off and Chrome
# carries on painting the buttons anyway. Whether a given Chrome build does that for an
# extension popup is Chrome's business and it changes between versions, so this is written as
# an attempt that costs nothing and is reported as an attempt, never as a guarantee.
#
# Which is why the extension keeps its reopen-on-close. That is the layer that actually
# enforces the rule, on every platform and every Chrome; this one removes the button where
# Windows owns the frame, so there is nothing to press and no blink. Neither is load-bearing
# for the other, and the extension is told which it is getting so it can say so.
GWL_STYLE = -16
WS_SYSMENU = 0x00080000
SWP_FRAMECHANGED = 0x0020
SWP_NOZORDER = 0x0004
# Handles whose WS_SYSMENU WE cleared, so it is put back on exactly those and nothing else.
# Without this, "restore" would mean "set the bit", which would ADD a title-bar button to a
# window that never had one.
_cam_nosys = set()
_cam_close_blocked = False
_close_error = 0        # last Windows error from taking the buttons away
# When Anki ITSELF was last the window in front, as a monotonic-ish wall clock.
#
# The foreground can also be the camera window, and that is not an answer on its own: it is
# the one window that can be in front while you are anywhere at all, because clicking it is
# how you drag it. So it inherits Anki's foreground for a short while and no longer — which
# is the same rule, for the same reason, that the extension's ankiHasForeground applies.
_anki_fg_at = 0.0
CAM_FOCUS_GRACE_S = 10.0


def _as_long(v):
    """Fold a Python int into the signed 32-bit range SetWindowLongW's argtype wants.

    A window style routinely has the top bit set — WS_POPUP is 0x80000000 — and
    GetWindowLongW hands that back as a negative c_long. Arithmetic on it in Python is
    arbitrary precision, so `style | WS_SYSMENU` can come out as a positive number larger
    than a c_long holds, and ctypes refuses it. Normalising here means neither caller has
    to think about it.
    """
    v &= 0xFFFFFFFF
    return v - 0x100000000 if v & 0x80000000 else v


def _set_cam_close_button(api, hwnds, hide):
    """Take the title-bar buttons off the camera window, or put them back.

    `hide` False only ever touches handles in _cam_nosys — windows we took the buttons from
    ourselves. Anything else is somebody's window and none of our business.
    """
    global _cam_close_blocked, _close_error
    u, wintypes = api["u"], api["wintypes"]
    # NOSIZE | NOMOVE | NOZORDER | NOACTIVATE | FRAMECHANGED. NOZORDER matters: this must not
    # disturb the always-on-top ordering that _pin_camera_window has just settled.
    FLAGS = 0x0001 | 0x0002 | SWP_NOZORDER | 0x0010 | SWP_FRAMECHANGED
    all_hidden = bool(hwnds)
    for h in list(hwnds):
        try:
            hw = wintypes.HWND(h)
            if not u.IsWindow(hw):
                _cam_nosys.discard(h)
                continue
            style = u.GetWindowLongW(hw, GWL_STYLE)
            want = (style & ~WS_SYSMENU) if hide else (style | WS_SYSMENU)
            if want != style:
                if not hide and h not in _cam_nosys:
                    continue                      # not ours to give back
                ctypes.set_last_error(0)
                u.SetWindowLongW(hw, GWL_STYLE, _as_long(want))
                err = ctypes.get_last_error()
                # A style change is not on screen until the frame is told to work itself out
                # again. Without this the buttons stay drawn until something else happens to
                # invalidate the window, which on a window sitting still is never.
                u.SetWindowPos(hw, wintypes.HWND(0), 0, 0, 0, 0, FLAGS)
                gone = not (u.GetWindowLongW(hw, GWL_STYLE) & WS_SYSMENU)
                if hide:
                    if gone:
                        _cam_nosys.add(h)
                    else:
                        _close_error = err if err else 1
                else:
                    _cam_nosys.discard(h)
            if hide and (u.GetWindowLongW(hw, GWL_STYLE) & WS_SYSMENU):
                all_hidden = False
        except Exception:
            all_hidden = False
    if not hide:
        all_hidden = False
    _cam_close_blocked = all_hidden
    if all_hidden:
        _close_error = 0


def _restore_cam_close_buttons(api=None):
    """Put back every button we took, on every window we took one from.

    Called when the window stops being the camera window, and on the way out of the profile.
    A Chrome window left with no way to close it would be the worst thing in this file.
    """
    global _cam_close_blocked
    api = api or _win32_api()
    if not api:
        _cam_nosys.clear()
        _cam_close_blocked = False
        return
    if _cam_nosys:
        _set_cam_close_button(api, list(_cam_nosys), False)
    _cam_nosys.clear()
    _cam_close_blocked = False


def _win32_api():
    """Lazily set up the handful of Win32 calls we need, with real signatures.
    Handles are pointer sized, so argtypes matter on 64-bit Python."""
    global _win32
    if _win32 is not None:
        return _win32
    if not sys.platform.startswith("win"):
        _win32 = False
        return _win32
    try:
        from ctypes import wintypes
        # use_last_error so we can report *why* pinning failed instead of guessing.
        u = ctypes.WinDLL("user32", use_last_error=True)
        u.EnumWindows.argtypes = [ctypes.c_void_p, wintypes.LPARAM]
        u.EnumWindows.restype = wintypes.BOOL
        u.IsWindow.argtypes = [wintypes.HWND]
        u.IsWindow.restype = wintypes.BOOL
        u.IsWindowVisible.argtypes = [wintypes.HWND]
        u.IsWindowVisible.restype = wintypes.BOOL
        u.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        u.GetWindowTextLengthW.restype = ctypes.c_int
        u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetWindowTextW.restype = ctypes.c_int
        u.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
        u.SetWindowPos.restype = wintypes.BOOL
        u.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
        u.GetWindowLongW.restype = ctypes.c_long
        u.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_long]
        u.SetWindowLongW.restype = ctypes.c_long
        u.GetForegroundWindow.argtypes = []
        u.GetForegroundWindow.restype = wintypes.HWND
        # Left as POINTER(DWORD). ctypes accepts None for any pointer parameter and passes NULL,
        # which is what _raise_main_window relies on to ask for the thread id and not the process
        # id — and _sample_input still passes a real byref for the other caller's sake.
        u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        u.GetWindowThreadProcessId.restype = wintypes.DWORD
        # Borrowing the foreground thread's input queue, which is the documented way for a
        # background process to be allowed to take the foreground at all. See _raise_main_window
        # for why SetForegroundWindow on its own only flashes the taskbar button.
        u.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
        u.AttachThreadInput.restype = wintypes.BOOL
        u.IsIconic.argtypes = [wintypes.HWND]
        u.IsIconic.restype = wintypes.BOOL
        u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        u.ShowWindow.restype = wintypes.BOOL
        u.SetForegroundWindow.argtypes = [wintypes.HWND]
        u.SetForegroundWindow.restype = wintypes.BOOL
        u.BringWindowToTop.argtypes = [wintypes.HWND]
        u.BringWindowToTop.restype = wintypes.BOOL
        # "Has anybody touched this machine lately?" — for the inactivity tracker. See
        # _sample_input.
        #
        # GetTickCount rather than GetTickCount64 deliberately: LASTINPUTINFO.dwTime is a
        # 32-bit tick count, so the two have to be the same clock to be subtracted. Pairing
        # it with the 64-bit call would give a difference of about 49 days on any machine
        # that had been up long enough to wrap once.
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.GetTickCount.argtypes = []
        k.GetTickCount.restype = wintypes.DWORD
        # Which thread we are, for the AttachThreadInput pair in _raise_main_window. This runs on
        # Anki's GUI thread, which is the thread that owns the window being raised.
        k.GetCurrentThreadId.argtypes = []
        k.GetCurrentThreadId.restype = wintypes.DWORD
        u.GetLastInputInfo.argtypes = [ctypes.POINTER(_LASTINPUTINFO)]
        u.GetLastInputInfo.restype = wintypes.BOOL
        proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        _win32 = {"u": u, "k": k, "proc": proc, "wintypes": wintypes}
    except Exception:
        _win32 = False
    return _win32


def _title_is_cam(text):
    """Is this window title the camera window's?

    Either spelling counts — see CAM_TITLES. Substring, not equality, because Chrome
    appends its own decoration to a window's title on some platforms and versions.
    """
    return any(t in text for t in CAM_TITLES)


def _find_cam_windows(api):
    """Every visible top-level window titled CAM_TITLE.

    EnumWindows only walks top-level windows, so Chrome's internal child windows
    (the "Chrome Legacy Window" and friends) can't be picked up by mistake. We
    collect all matches rather than the first, because Chrome sometimes keeps a
    second, older window around for a moment after reopening.
    """
    u = api["u"]
    found = []

    def visit(hwnd, _lparam):
        try:
            if not u.IsWindowVisible(hwnd):
                return True
            n = u.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            if _title_is_cam(buf.value):
                found.append(int(hwnd))
        except Exception:
            pass
        return True

    try:
        cb = api["proc"](visit)
        u.EnumWindows(ctypes.cast(cb, ctypes.c_void_p), 0)
    except Exception:
        return []
    return found


def _window_title_matches(api, hwnd):
    """Does this window still carry the camera window's title?

    Asked on every tick, because a window's title is not a fixed property — a web
    page can rewrite its own at any moment, and Chrome names a window after whichever
    tab is showing.
    """
    try:
        u = api["u"]
        hw = api["wintypes"].HWND(hwnd)
        n = u.GetWindowTextLengthW(hw)
        if n <= 0:
            return False
        buf = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(hw, buf, n + 1)
        return _title_is_cam(buf.value)
    except Exception:
        return False


def _pin_camera_window():
    """Keep AnkiGate's camera window above every other app, including Anki.

    Checked on every tick: clicking another window, or Chrome re-showing its own,
    can clear the always-on-top flag, so we re-assert it whenever it goes missing
    instead of setting it once and hoping.
    """
    global _cam_hwnds, _cam_pinned, _pin_error, _anki_fg_at
    api = _win32_api()
    if not api:
        _cam_pinned = False
        # The code goes with the verdict it belonged to. It was only ever cleared on a
        # full success, so on every path that gives up early the last failure's number
        # stayed on the wire — reported alongside cam_found: false, describing a window
        # that is no longer there.
        _pin_error = 0
        return
    u, wintypes = api["u"], api["wintypes"]
    HWND_TOPMOST = wintypes.HWND(-1)
    FLAGS = 0x0001 | 0x0002 | 0x0010          # NOSIZE | NOMOVE | NOACTIVATE
    GWL_EXSTYLE, WS_EX_TOPMOST = -20, 0x00000008

    # Drop handles that have gone OR that no longer carry the title, and look again
    # whenever we have none.
    #
    # The title is re-checked, not just liveness. It used to be checked once, at
    # discovery, and then the handle was pinned for as long as the window existed —
    # so any page that set document.title to the camera window's title got its whole
    # Chrome window forced above every other app, and un-minimised twice a second,
    # for the rest of its life. Re-checking means the moment the title stops matching
    # we let go, and the block below puts the window back to normal.
    alive, dropped = [], []
    for h in _cam_hwnds:
        try:
            hw = wintypes.HWND(h)
            if u.IsWindow(hw) and u.IsWindowVisible(hw) and _window_title_matches(api, h):
                alive.append(h)
            else:
                dropped.append(h)
        except Exception:
            dropped.append(h)
    # Undo our own change on the way out. Leaving WS_EX_TOPMOST set on a window we
    # have stopped tracking means we made someone's window always-on-top and then
    # walked away from it — it would stay like that until they closed it.
    for h in dropped:
        try:
            hw = wintypes.HWND(h)
            if u.IsWindow(hw):
                u.SetWindowPos(hw, wintypes.HWND(-2), 0, 0, 0, 0, FLAGS)   # HWND_NOTOPMOST
        except Exception:
            pass
    # And its buttons, for the same reason and more urgently. A window we have stopped
    # tracking is either somebody else's or one whose title stopped matching — leaving it
    # with no ✕ would be this add-on breaking a window it has just disowned.
    if dropped and _cam_nosys:
        _set_cam_close_button(api, [h for h in dropped if h in _cam_nosys], False)
    if not alive:
        alive = _find_cam_windows(api)
        _cam_pinned = False
    _cam_hwnds = alive
    if not _cam_hwnds:
        _pin_error = 0          # nothing to pin, so nothing has failed to pin
        _restore_cam_close_buttons(api)
        return

    # Minimising is not allowed while Anki is in front. If you tried to hide the
    # camera by clicking the taskbar or the − button, put it back up right away.
    # Only while Anki actually has the foreground — otherwise we'd fight Windows
    # over hiding when you switch to any other app on purpose.
    fg_kind = _foreground_kind()
    if fg_kind == "anki":
        _anki_fg_at = time.time()
    elif fg_kind == "other":
        # Any other application owning the screen spends the inheritance immediately. This is
        # the line that makes clicking the little window from your browser count as "not in
        # Anki" — without it, "cam" would hold a pass open for as long as you left it in front.
        _anki_fg_at = 0.0
    # "cam" deliberately falls through both branches, leaving the stamp alone: the camera
    # window inherits Anki's foreground for CAM_FOCUS_GRACE_S and never earns one of its own.
    in_anki = fg_kind == "anki" or (
        fg_kind == "cam" and _anki_fg_at > 0 and (time.time() - _anki_fg_at) <= CAM_FOCUS_GRACE_S)

    # `in_anki`, not `fg_kind in ("anki", "cam")`, which is what this used to say. The two differ
    # in exactly one case and it is the case that matters: sitting in your browser with the little
    # window in front of it. That reports "cam", so the old test called it being in Anki and put a
    # window you had just minimised straight back up while you were nowhere near Anki.
    #
    # It also makes the three rules in this function agree, which their comments already claim they
    # do — pin it, refuse to let it hide, take its buttons away — and agree with the extension,
    # whose ankiHasForeground draws the same line for the same reason.
    if in_anki:
        SW_SHOWNOACTIVATE = 4
        for h in _cam_hwnds:
            try:
                hw = wintypes.HWND(h)
                if u.IsIconic(hw):
                    u.ShowWindow(hw, SW_SHOWNOACTIVATE)
            except Exception:
                pass

    # The title-bar buttons: gone while you are in Anki, back the moment you are not.
    #
    # Re-asserted every tick rather than set once, exactly like the pinning above and for the
    # same reason — Chrome owns this window and redraws its own frame, so a style we set once
    # and walked away from is a style that can quietly come back.
    _set_cam_close_button(api, _cam_hwnds, in_anki)

    pinned_all = True
    for h in _cam_hwnds:
        try:
            hw = wintypes.HWND(h)
            ex = u.GetWindowLongW(hw, GWL_EXSTYLE)
            if not (ex & WS_EX_TOPMOST):
                # The error code is read IMMEDIATELY after the call that might have
                # failed. It used to be read after an intervening GetWindowLongW,
                # which resets it — so pin_error held that call's code instead, and
                # the settings page showed its "try running both as administrator"
                # advice at essentially random moments.
                ctypes.set_last_error(0)
                okpos = u.SetWindowPos(hw, HWND_TOPMOST, 0, 0, 0, 0, FLAGS)
                err = ctypes.get_last_error()
                ex = u.GetWindowLongW(hw, GWL_EXSTYLE)
                if not (ex & WS_EX_TOPMOST):
                    # There is no second attempt any more. It was
                    # SetWindowLongW(GWL_EXSTYLE, ... | WS_EX_TOPMOST), which
                    # Microsoft documents as not supported for this flag — it writes
                    # style bits into another process's window without telling the
                    # window manager, so it either did nothing or left the window in a
                    # state disagreeing with what the compositor believed. SetWindowPos
                    # is the supported way, and if that is refused the honest answer is
                    # "not pinned", which the extension already knows how to explain.
                    _pin_error = err if err else (0 if okpos else 1)
            if not (ex & WS_EX_TOPMOST):
                pinned_all = False
        except Exception:
            pinned_all = False

    _cam_pinned = pinned_all
    if _cam_pinned:
        _pin_error = 0


# ---------------------------------------------------------------------------
# Media cards: is the video on this card actually being watched?
#
# The rule AnkiGate wants to enforce: if a card carries a video, sitting and
# looking at the paused first frame is not studying — the clock should only run
# while the thing is playing. A card with no media behaves exactly as before.
#
# And "playing" means the position is MOVING. Not "not paused", which is what this used to
# ask, and which a buffering video answers yes to: it is playing into an empty buffer with
# its counter standing still. On a slow connection that is most of the sitting, and it was
# all being credited. YouTube's buffering state was even on the explicit allow-list, on the
# reading that you had pressed play and were waiting for it — but waiting for a video to
# arrive is not studying it. So both kinds of player are now judged on their own seconds
# counter, the one you can see moving on the screen.
#
# Two not-playing cases are then told apart and reported separately: stopped because you
# have not pressed play, and stopped because it is buffering. Both stop the clock. They need
# different words, because "press play" at a spinner is advice nobody can take.
#
# Only Anki can answer this. The card is rendered inside Anki's own webview, and a
# Chrome extension cannot see into another application's browser engine. So a small
# probe is added to the card's HTML, and this add-on asks it for a verdict.
#
# What can and cannot be read, honestly:
#
#   <video> / <audio> in a field   — read directly (position, paused, ended). Reliable.
#   A YouTube <iframe>             — only if the embed URL carries enablejsapi=1,
#                                    which ordinary embeds don't. The probe adds it
#                                    and then talks to the player over postMessage.
#                                    Usually works; YouTube is entitled to ignore us.
#   Any other video host           — counted as media, but its state is NOT readable.
#
# `[sound:...]` is deliberately not a gate. Anki plays those itself, usually
# automatically, through an external player rather than in the page — so there is no
# "user chose not to press play" state for it to catch.
#
# The important design decision is what to do when a card HAS media whose state we
# cannot read. Refusing to count time would be the strict answer and it is the wrong
# one: the goal could then never be finished, the sites could never unlock, and the
# day is a dead end because of one embed. So unreadable media does not gate, and the
# extension is told `readable: false` so it can say so on screen instead of pretending.

# Every other 500 ms tick, i.e. about once a second. Fast enough for a play/pause
# gate, and it keeps the eval off the GUI thread's back half the time.
MEDIA_POLL_EVERY = 2
# A verdict older than this is not a verdict. If the eval stops coming back — the
# webview went away, the card's own JavaScript threw — we must report "don't know"
# rather than leaving the last answer standing, in either direction.
MEDIA_STALE_MS = 4000

_media = {"present": False, "playing": False, "readable": False, "waiting": False, "at": 0}
# Regenerated for every card. The probe echoes it back, so a verdict left over from
# the previous card can be recognised and thrown away — the reviewer reuses one
# document across cards, so `window` state does NOT reset by itself between them.
_media_token = ""
_media_tick = 0
_media_pending = False
# When the outstanding probe was sent. The "one request in flight" rule needs a way out:
# evalWithCallback's callback is not guaranteed to arrive — the webview can be torn down
# between the call and the reply, a page navigation can swallow it, a profile can close
# mid-flight — and a flag with no timeout then blocked every future probe for the rest of
# the session. The symptom fails OPEN and silently: the media reading goes stale, the
# extension reads "can't check this card", and the media gate stands aside while videos
# play on with the clock stopped, which is the one thing the feature exists to prevent.
_media_sent_at = 0.0
# How long a probe may be outstanding before it is written off. Six ticks of the 500 ms
# timer: long enough that a webview merely busy drawing a card full of images is never
# interrupted, short enough that a lost callback costs a couple of seconds.
_MEDIA_PROBE_TIMEOUT = 3.0
# Set by a POST on the HTTP thread, spent by the next tick on Anki's GUI thread. Touching the
# webview from the HTTP thread is not allowed, so the request has to wait half a second for a
# thread that may. Same shape as _raise_wanted.
_media_pause_wanted = False
# The same, for putting it back once the extension's conditions come good again. Its own flag rather
# than a signed version of the one above: the two are spent side by side, and "-1 means resume" read at
# the point of use is how a mistake gets made.
_media_resume_wanted = False
# How far back to wind, in seconds, as asked for by the request that set the flag above. The
# extension owns the number — it is a setting on its own page — so it travels with each request
# rather than being configured here as well and drifting.
_media_pause_back = 0


_MEDIA_JS = """
<script>(function(){
try{
  var TOK = "__FG_TOKEN__";
  var st = { token: TOK, has: false, playing: false, readable: false, waiting: false,
             html5: 0, yt: 0, other: 0 };
  window.__fgMedia = st;

  // ---- what we stopped, by WHICH MEDIA rather than which element ----
  //
  // { mediaKey: when we paused it }, and the `||` is the whole point: this one object deliberately
  // survives the card being rebuilt, because the reviewer reuses a single document and only `st` is
  // replaced per card.
  //
  // It exists because the marks the pause leaves — `el.__fgByUs` on a <video>, `y.byUs` on an
  // iframe — live on DOM NODES, and Anki throws the card's nodes away every time the card changes.
  // So: pause a lecture, glance at the next card and come back, and the extension still has a debt
  // on its books while the page has nothing marked to pay it with. __fgResumeMedia found nothing,
  // reported nothing, and the video you had been watching sat there waiting for a click. The
  // extension cannot tell that apart from a resume that simply failed, which is why it looked
  // intermittent rather than broken.
  //
  // Keyed by keyFor() — "yt:<video id>" or "v:<path>" — so what is remembered is the MEDIA and not
  // the element. That is what makes acting on it correct rather than merely convenient: a key only
  // matches a player of the same video, so coming back to the card you left resumes the thing you
  // were watching, and arriving at a different card with a different video resumes nothing. The one
  // case it deliberately does cover is two cards embedding the same lecture, which is the same
  // video and the same intention.
  //
  // Bounded in time, because a claim nobody ever came back to redeem must not be honoured an hour
  // later on a card that happens to carry the same video. See OWN_MAX_MS.
  window.__fgOwn = window.__fgOwn || {};
  var OWN = window.__fgOwn;
  // How long a claim is worth honouring. Ten minutes: long enough for "I paused it, read a few
  // cards and came back", short enough that it cannot reach across a session.
  var OWN_MAX_MS = 600000;
  function ownClaim(key){
    if (!key) return;
    try {
      OWN[key] = Date.now();
      // Swept here rather than on a timer, because this is the only place the object grows. A
      // collection with thousands of videos would otherwise accumulate a key per video watched.
      var ks = Object.keys(OWN), now = Date.now();
      if (ks.length > 40) {
        for (var i = 0; i < ks.length; i++) {
          if (now - (Number(OWN[ks[i]]) || 0) > OWN_MAX_MS) delete OWN[ks[i]];
        }
      }
    } catch (x) {}
  }
  function ownHeld(key){
    if (!key) return false;
    var at = Number(OWN[key]) || 0;
    if (!at) return false;
    if (Date.now() - at > OWN_MAX_MS) { try { delete OWN[key]; } catch (x) {} return false; }
    return true;
  }
  function ownRelease(key){
    if (!key) return;
    try { delete OWN[key]; } catch (x) {}
  }

  // Playing means the POSITION IS MOVING, and nothing else. Buffering used to count, on the
  // reading that you had pressed play and were waiting for it — but waiting for a video to
  // load is not studying it, and on a bad connection it is most of the sitting. The seconds
  // counter on the player is the only honest witness here, so that is what is watched.
  //
  // A position may stand still for this long before playing stops being true: long enough
  // that one throttled tick, a seek, or a coarsely reported currentTime cannot trip it,
  // short enough that a real stall costs you almost nothing.
  var STILL_MS = 2500;

  // How long a player may be BUFFERING before that is worth reporting.
  //
  // This exists because the two ways of stalling were not being treated alike, and one of them
  // had no grace at all. A plain <video> that stops moving keeps `playing` true for STILL_MS
  // above, so a momentary hitch costs nothing and says nothing. A YouTube embed reports its own
  // state, and the instant it said "buffering" the clock stopped and the window announced
  // "waiting for the video to load" — on the same momentary hitch that the <video> beside it
  // would have absorbed in silence. Every seek, every quality change and every half-second dip
  // on a normal connection produced that message, which is how a message stops being read.
  //
  // So a freshly-buffering player counts as still running, exactly as a freshly-stalled one
  // does, and only a stall that has LASTED gets reported. A second is the figure because it is
  // about the shortest pause a person notices as a pause: below it the message would be gone
  // before it had been read, and anything longer starts to feel like the extension has missed
  // what is plainly happening on screen.
  //
  // Deliberately shorter than STILL_MS rather than equal to it. This is a player SAYING it is
  // stuck, which is direct evidence; STILL_MS is inferred from a clock that has not moved, and
  // inference deserves more rope than testimony.
  var BUFFER_GRACE_MS = 1000;

  // One listener for the life of the document, because the reviewer reuses it.
  // It writes into whatever window.__fgMedia currently is, so it follows the card.
  //
  // Every player's state is kept ON ITS OWN IFRAME, and that is the fix for cards with more than
  // one embed. It used to be a handful of fields on the single shared object — ytPlay, ytPos,
  // ytMovedAt — so every frame's message overwrote the last one's. Put thirty embeds on a card,
  // play the fifth, and the other twenty-nine go on reporting "cued, position 0" several times a
  // second: whichever of them spoke last decided the answer, so the card read as nothing playing
  // while a video plainly was. The shared position was worse than useless — it lurched between the
  // playing video's clock and zero, so "has it moved" was noise. With a single embed there was
  // nobody to overwrite it, which is exactly why this only ever went wrong on many.
  if (!window.__fgMediaListening) {
    window.__fgMediaListening = true;
    window.addEventListener("message", function(e){
      var d = e.data;
      if (typeof d === "string") { try { d = JSON.parse(d); } catch (x) { return; } }
      if (!d || !d.info) return;
      if (!window.__fgMedia) return;
      // Which frame said this? By the identity of the window that posted, not by the id handed out
      // in the handshake: an echoed id is only as trustworthy as whatever echoes it, and a window
      // reference cannot be claimed by a different frame on the page.
      //
      // Read off the live document rather than a captured list, because this listener outlives the
      // card that installed it — the reviewer reuses the document, so a closure over one card's
      // frames would be looking at the previous card's elements.
      var f = null, all = document.getElementsByTagName("iframe");
      for (var i = 0; i < all.length; i++) {
        if (all[i].contentWindow === e.source) { f = all[i]; break; }
      }
      if (!f) return;
      var y = f.__fgYt || (f.__fgYt = {});
      var ps = d.info.playerState;
      if (typeof ps === "number") {
        // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued. Three of those
        // are worth telling apart: playing, finished, and stuck.
        y.seen = true;
        y.play = (ps === 1);
        y.ended = (ps === 0);
        // WHEN it started buffering, not merely that it is. See BUFFER_GRACE_MS: a stall is only
        // worth reporting once it has lasted, and "how long" cannot be answered by a boolean.
        //
        // Stamped on the EDGE — the transition into state 3 — and left alone while it stays there.
        // Restamping on every repeat of the same state would hold the grace open for the whole
        // stall, and a grace that never runs out is a report that never arrives.
        //
        // On the iframe's own object (this is `f.__fgYt`), so it survives the card being rebuilt.
        // `st` is replaced for every card while these elements outlive the look that made them,
        // which is the same reason `movedAt` lives here.
        if (ps === 3) { if (!y.buffering) y.buffAt = Date.now(); }
        else { y.buffAt = 0; }
        y.buffering = (ps === 3);
        // Running again, so we are no longer holding it. Cleared HERE and not in __fgResumeMedia, and
        // the reason is a bug that has already been paid for once: the rewind's guard was cleared only
        // inside the pause function, which stops being called the moment the pause lands, so it was set
        // once and never released. This listener is the only thing on the page that sees a player's
        // state continuously, whoever pressed play — so it is the only honest place to let go.
        //
        // The per-video claim goes with it, for the same reason and in the same breath: the two are one
        // fact recorded twice — once against this element, once against the video so it can outlive the
        // element — and releasing one without the other would leave the resume pressing play on
        // something already playing for the next ten minutes. `f.__fgKey` is whatever keyFor cached on
        // this iframe, and is empty until something has asked; nothing to release in that case.
        if (ps === 1) { y.byUs = false; if (f.__fgKey) ownRelease(f.__fgKey); }
      }
      // The clock inside the video. YouTube reports it continuously while a video runs and
      // repeats the same value while it stalls, which is the difference this gate needs —
      // the player can go on claiming state 1 for a while before it admits to buffering.
      var ct = d.info.currentTime;
      if (typeof ct === "number") {
        y.seen = true;
        if (typeof y.pos !== "number" || ct > y.pos + 0.05) y.movedAt = Date.now();
        y.pos = ct;
      }
    }, false);
  }

  function isVideoHost(s){
    return /(youtube(-nocookie)?\\.com|youtu\\.be)/i.test(s);
  }

  // ---- where you left off ----
  // Injected by the add-on for THIS card: { mediaKey: seconds }. Reported back the same way, so
  // the add-on can write it down and hand it over again next time. See _pos_note there.
  var POS = __FG_POS__ || {};

  // What identifies one player across sessions.
  //
  // Not its position in the document, which changes the moment you edit the note. For YouTube it
  // is the video id, which is the only part of an embed URL that means anything — the rest carries
  // autoplay flags, a start time and whatever else the template happened to write, and two of
  // those we add ourselves. For a file it is the path Anki serves it from, with the scheme and
  // host cut off: Anki's own media server picks a fresh port every time it starts, so leaving the
  // host in would make every video a stranger on the next run.
  //
  // The index is only a fallback, for a player with nothing to identify it at all. Cached on the
  // element so that one document never changes its mind about which player is which.
  function ytId(s){
    var m = /(?:youtu\\.be\\/|\\/embed\\/|[?&]v=)([\\w-]{6,})/.exec(String(s || ""));
    return m ? m[1] : "";
  }
  function keyFor(el, i){
    if (el.__fgKey) return el.__fgKey;
    var s = String(el.getAttribute("src") || el.currentSrc || "");
    var k;
    if (String(el.tagName).toLowerCase() === "iframe") {
      var id = ytId(s);
      k = id ? "yt:" + id : "yi:" + i;
    } else {
      var p = s.replace(/^[a-z][a-z0-9+.-]*:\\/\\/[^/]*\\//i, "").split("#")[0];
      k = p ? "v:" + p : "vi:" + i;
    }
    el.__fgKey = k;
    return k;
  }
  // Put a file back where you left it. Guarded two ways: not before the browser knows how long
  // the thing is, and not within a couple of seconds of the end — a video you watched to the
  // finish leaves its position there, and "resuming" into the last two seconds is the same as not
  // resuming while looking like a bug.
  function restore(el, i){
    var t = Number(POS[keyFor(el, i)]);
    if (!(t > 1)) return;
    var go = function(){
      try {
        var d = Number(el.duration);
        if (!isFinite(d) || t < d - 2) el.currentTime = t;
      } catch (x) {}
    };
    if (el.readyState >= 1) go();
    else { try { el.addEventListener("loadedmetadata", go, { once: true }); } catch (x) { el.addEventListener("loadedmetadata", go, false); } }
  }
  function isOtherHost(s){
    return /(vimeo\\.com|dailymotion\\.com|drive\\.google\\.com|twitch\\.tv|bilibili\\.com|wistia|streamable\\.com)/i.test(s);
  }

  // YouTube will not report its state unless the embed asked for it. Ordinary
  // embeds don't, so the parameter is added here. Rewriting src reloads the frame,
  // which is why this runs once when the card appears rather than while you watch.
  var frames = [];
  function prep(){
    frames = [];
    var all = document.getElementsByTagName("iframe");
    for (var i = 0; i < all.length; i++) {
      var f = all[i], s = String(f.getAttribute("src") || "");
      if (!s) continue;
      if (isVideoHost(s)) {
        // Two parameters, one rewrite. Rewriting src reloads the frame, so doing it twice would
        // load the video, throw it away and load it again — and the second load would be the one
        // that mattered, which is a race nobody needs.
        //
        // `start` is how you resume a YouTube embed. There is a seekTo command over postMessage,
        // but it can only be sent once the player has loaded and answered the handshake, which is
        // a second or two of it playing from the beginning first. The parameter is honoured before
        // the first frame is drawn.
        var add = [];
        if (!/[?&]enablejsapi=1/.test(s)) add.push("enablejsapi=1");
        var t0 = Math.floor(Number(POS[keyFor(f, i)]) || 0);
        // Not if the template already asked for a start time — that is the author's decision about
        // their own card, and it outranks anything we remembered.
        if (t0 > 1 && !/[?&]start=/.test(s)) add.push("start=" + t0);
        if (add.length) {
          try { f.setAttribute("src", s + (s.indexOf("?") < 0 ? "?" : "&") + add.join("&")); } catch (x) {}
        }
        frames.push(f);
        st.yt++;
      } else if (isOtherHost(s)) {
        st.other++;
      }
    }
  }

  // Ask each player to start reporting. Repeated, because a frame that hasn't
  // finished loading silently drops the request.
  //
  // Only the ones that have not answered yet, and it keeps asking them for as long as the card is up
  // rather than stopping as soon as ANY frame replies. That was the second half of the multiple-embed
  // bug: the retry was gated on "has anything answered", so the first frame to reply switched the
  // handshake off for all the rest. Scroll down twenty videos and play one, and that player had never
  // been asked to report — so it played in silence.
  function ping(){
    for (var i = 0; i < frames.length; i++) {
      var y = frames[i].__fgYt;
      if (y && y.seen) continue;                      // already talking to us
      try {
        frames[i].contentWindow.postMessage(
          '{"event":"listening","id":' + i + ',"channel":"widget"}', "*");
      } catch (x) {}
    }
  }

  // Is this element's position moving?
  //
  // `!paused` was the old test and it is not the question. A buffering video is not paused —
  // it is playing into an empty buffer with its position standing still, which is the state
  // the spinner draws.
  //
  // The samples are kept ON the element: st is rebuilt for every card while the element lives
  // as long as the card does, and this has to compare one look against the next.
  function moving(v, now, gap){
    var pos = v.currentTime || 0;
    var was = v.__fgPos;
    v.__fgPos = pos;
    if (typeof was !== "number") {
      // First look at this element: there is genuinely nothing to compare against, so whether it
      // is moving cannot be known yet. It is given the benefit of the doubt for one grace window
      // rather than being called stuck, because "not yet measurable" and "stalled" are different
      // facts and only one of them is worth a message.
      //
      // Without this, every unpaused player reported a stall on the tick it first appeared —
      // a card with a video on it said "waiting for the video to load" for one 400ms sample as
      // it opened, which is both wrong and long enough for the add-on's own ~1s poll to catch and
      // pass on. Seeding the stamp rather than returning true keeps it one window and not forever:
      // if the position really is not moving, the very next look says so.
      v.__fgMovedAt = now;
      return true;
    }
    if (pos > was + 0.02) { v.__fgMovedAt = now; return true; }
    // The grace is measured against the gap between looks as well as against a constant. A
    // webview whose timers are being throttled looks far less often than the 400ms below
    // asks for, and then "it has not moved since the last look" is normal, not a stall.
    return typeof v.__fgMovedAt === "number" &&
           (now - v.__fgMovedAt) < Math.max(STILL_MS, gap * 3);
  }

  // Every player on the card, and ANY ONE of them running is enough.
  //
  // That is the rule the whole feature needed and could not express while the state was shared: a
  // card with thirty embeds is being watched if you are watching one of them, and the other
  // twenty-nine sitting cued is not evidence of anything at all.
  function ytAny(now){
    var out = { running: false, seen: false, stuck: false };
    for (var i = 0; i < frames.length; i++) {
      var y = frames[i].__fgYt;
      if (!y || !y.seen) continue;                    // never answered: it has no opinion
      out.seen = true;
      if (y.ended) { out.running = true; continue; }   // finished counts as watched
      // A player WE stopped. Neither running nor stuck, whatever state it is reporting.
      //
      // This is here because of the rewind. The pause sends pauseVideo and then seekTo, and a seek puts
      // a YouTube player into state 3 — BUFFERING — where it can sit for as long as it stays paused.
      // So a video the extension had deliberately stopped looked exactly like a video stalled on the
      // network, and the camera window said "video loading" over it. `!y.play` below cannot catch that
      // case: state 3 is not state 1, so the frame never reaches that line.
      //
      // Held rather than waiting is the honest reading: nothing is being downloaded and nothing is
      // being watched, and the thing it is waiting for is the resume. Skipped BEFORE the buffering
      // branch for exactly that reason.
      if (y.byUs) continue;
      // Buffering, and for how long. Under the grace it still counts as running, so a hitch of a
      // few hundred milliseconds neither stops the clock nor puts a message on screen; past it,
      // this is a genuine stall and is reported as one. See BUFFER_GRACE_MS.
      //
      // The missing-stamp case counts as running rather than stuck, and that direction is
      // deliberate: it is a player that has said "buffering" without us having seen it change
      // into that state — the handshake landed mid-stall, or a message was missed — and treating
      // an unknown as a fault is how a warning gets shown for something nobody can act on.
      if (y.buffering) {
        var bAt = Number(y.buffAt) || 0;
        if (!bAt || (now - bAt) < BUFFER_GRACE_MS) out.running = true;
        else out.stuck = true;
        continue;
      }
      if (!y.play) continue;                          // paused, unstarted, cued
      // Claims to be playing. Believed unless its own clock has stopped moving — and taken on trust
      // if it has never reported a position at all.
      if (typeof y.movedAt !== "number" || (now - y.movedAt) < STILL_MS) out.running = true;
      else out.stuck = true;
    }
    return out;
  }

  var lastLookAt = 0;
  function look(){
    var now = Date.now();
    var gap = lastLookAt ? (now - lastLookAt) : 400;
    lastLookAt = now;
    var els = document.querySelectorAll("video, audio");
    st.html5 = els.length;
    var running = false, stuck = false;
    for (var i = 0; i < els.length; i++) {
      var v = els[i];
      // Sampled for every element, never short-circuited: a sample skipped on this look is a
      // sample that looks like a jump on the next one.
      var mv = moving(v, now, gap);
      if (v.ended) { running = true; continue; }
      if (v.paused || v.seeking) continue;            // paused is your decision, not the network's
      if (v.currentTime > 0 && mv) running = true;
      else stuck = true;                              // told to play, getting nowhere
    }
    var yt = ytAny(now);
    // Where each player is now, for the add-on to write down. Whole seconds: this is a resume
    // point, and a fraction would only make the file bigger and the writes more frequent.
    //
    // A finished player reports 0 rather than being left out. Left out, the add-on would keep the
    // old number and next time drop you two seconds from the end of something you had already
    // watched; 0 is an instruction to forget it, which is what finishing means.
    var pos = {};
    for (var pi = 0; pi < els.length; pi++) {
      var pt = Number(els[pi].currentTime);
      if (isFinite(pt)) pos[keyFor(els[pi], pi)] = els[pi].ended ? 0 : Math.floor(pt);
    }
    for (var fi = 0; fi < frames.length; fi++) {
      var fy = frames[fi].__fgYt;
      if (!fy || typeof fy.pos !== "number") continue;      // never told us where it is
      pos[keyFor(frames[fi], fi)] = fy.ended ? 0 : Math.floor(fy.pos);
    }
    st.pos = pos;
    st.has = (st.html5 + st.yt + st.other) > 0;
    // Readable means at least one thing on this card has a state we can actually
    // read. A plain <video> always does; a YouTube frame only once it has answered.
    st.readable = st.html5 > 0 || yt.seen;
    // Reported for the extension's own diagnostics and for the retry below. `ytSeen` is now "any of
    // them has answered", which is the honest reading of it — one frame replying never meant the
    // rest had.
    st.ytSeen = yt.seen;
    st.playing = running || yt.running;
    // Waiting on the network rather than waiting on you. This does not decide whether the
    // clock runs — st.playing does that — it decides which of two sentences the extension
    // shows, because "press play" in front of a spinner is advice that cannot be followed.
    st.waiting = !st.playing && (stuck || yt.stuck);
  }

  // Stop everything on this card, on request.
  //
  // The other direction of the same conversation. Everything above this line REPORTS what the
  // media is doing; this acts on it, because a clock that has stopped and a video that has not
  // is the one combination that makes the whole gate pointless — walk away from the desk and the
  // lecture plays to an empty chair, and you come back to twenty minutes you did not watch.
  //
  // Rescanned from the live document rather than reusing `frames`: a card can add a player after
  // prep() ran, and this has to reach that one too. Returns how many things it spoke to, which is
  // for the add-on's own sake — nothing depends on the number.
  //
  // Only hosts we have a command channel to are asked. A Vimeo or Drive embed gets nothing here
  // for the same reason it reports nothing above: there is no way to talk to it. Pretending
  // otherwise would be worse than being honest about it.
  // `back` is how many seconds to wind the player back before leaving it. The last few seconds of
  // anything went past while you were already turning away — they were played, not taken in — so
  // stopping where the clock stopped means resuming into a gap. 0 means "stop where it is".
  //
  // The winding happens on the same visit as the pause and in the same direction as the pause: only
  // ever backwards, and never past the beginning.
  window.__fgPauseMedia = function(back){
    var b = Number(back) || 0;
    if (!(b > 0)) b = 0;
    var n = 0;
    try {
      var els = document.querySelectorAll("video, audio");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        // Already paused is not a failure and not worth counting — this runs a few times per
        // stop, since a player is entitled to ignore the first request.
        var was = false;
        try { if (!el.paused) { el.pause(); n++; was = true; } } catch (x) {}
        // Marked as ours, so __fgResumeMedia knows what it is allowed to start again. Only the ones we
        // actually stopped: something you paused yourself, or never started, is not ours to play.
        //
        // Cleared by a one-time `play` listener rather than by the resume, and that distinction is the
        // whole lesson of the rewind bug that was just fixed — a flag cleared only by code that stops
        // running is a flag that never gets cleared. `play` fires whether it was us or you, so pressing
        // play yourself and then pausing again leaves nothing marked, and we keep our hands off it.
        if (was) {
          el.__fgByUs = true;
          // And the same claim filed by MEDIA rather than by element, so it outlives this card's
          // nodes. See window.__fgOwn.
          ownClaim(keyFor(el, i));
          if (!el.__fgPlayHook) {
            el.__fgPlayHook = true;
            try {
              el.addEventListener("play", function(){
                el.__fgByUs = false;
                // Released from both places, and for the same reason it is set in both: this event
                // is the only first-hand evidence that the thing is running again, whoever started
                // it. Letting go here rather than in the resume is the lesson the comment in
                // __fgResumeMedia spells out.
                ownRelease(el.__fgKey);
              }, false);
            } catch (x) {}
          }
        }
        // Wound back only on the visit that actually stopped it. This function runs several times
        // per stop, and winding on every visit would walk a paused video backwards five seconds at
        // a time until it reached the start.
        if (b && was) {
          try {
            var t = Number(el.currentTime);
            if (isFinite(t)) el.currentTime = Math.max(0, t - b);
          } catch (x) {}
        }
      }
    } catch (x) {}
    try {
      var all = document.getElementsByTagName("iframe");
      for (var j = 0; j < all.length; j++) {
        var f = all[j];
        var s = String(f.getAttribute("src") || "");
        if (!isVideoHost(s)) continue;
        // Sent to every YouTube frame, not only the ones reporting as playing. Their state
        // arrives over postMessage and can be a moment behind; pausing something that was
        // already paused costs nothing, and missing the one that is playing costs everything.
        try {
          f.contentWindow.postMessage(
            '{"event":"command","func":"pauseVideo","args":[]}', "*");
          n++;
        } catch (x) {}
        // And a seek, for the ones we know the position of. There is no way to read a YouTube
        // player's clock synchronously, so this uses the position it last reported over
        // postMessage — which is at most a few hundred milliseconds old, and the whole point of
        // this is to be a few seconds out on purpose.
        //
        // Only once per stop, and the guard is a POSITION rather than a flag. This is the fix for
        // "it never winds back": it wound back exactly once per player and then silently never again.
        //
        // It used to be a boolean, y.wound, set here and cleared a few lines below whenever the player
        // reported paused. The clearing lived inside this very function, and this function stops being
        // called the moment the pause lands — the extension only asks for a pause while the add-on is
        // reporting something PLAYING, so once the video is paused the requests stop. So the flag was
        // set on the first stop and there was no longer any code running that could clear it. Second
        // stop onwards: paused on the dot, wound back not at all.
        //
        // A remembered position needs nobody to clear it. The player has either moved away from where
        // we last put it or it has not, and that is the question actually being asked. It closes a
        // second hole the boolean had as well: if a pause request never landed, the player's state
        // never changed, so even the clearing that did exist would not have fired.
        //
        // The slop is for YouTube's own reporting. After a seek it does not always come back with
        // exactly the number it was given — it can settle a little either side — and a difference that
        // small is the same place, not a resume. Either direction, so seeking backwards by hand also
        // counts as having moved on.
        var y = f.__fgYt;
        // Playing now, or playing a moment ago. A "paused" state message can beat this call by a few
        // milliseconds: the extension asks for the pause because the add-on's last reading said
        // something was playing, and both of those readings travel over a network. Demanding y.play on
        // its own therefore lost the occasional stop for no reason anybody could have seen. movedAt is
        // when the player's own clock last went forward.
        // BUFFERING counts as live, and leaving it out was a way for auto-resume to do nothing.
        //
        // A frame that is buffering has play === false — state 3 is not state 1 — and its clock has
        // by definition stopped moving, so `movedAt` goes stale within two seconds. So a video that
        // happened to be loading at the moment you looked away was paused by the broadcast above and
        // then not claimed by the line below: the extension had a debt on its books and the page had
        // nothing marked to pay it with, so pressing play was left to you. On a slow connection that
        // is most of the pauses.
        //
        // It is also the state a paused-and-restarted embed spends its first moment in, which is how
        // this could bite twice in a row.
        var live = !!y && (y.play === true || y.buffering === true ||
                           (y.movedAt && (Date.now() - y.movedAt) < 2000));
        var moved = !y || typeof y.woundTo !== "number" || Math.abs(y.pos - y.woundTo) > 1.5;
        if (b && y && y.seen && live && !y.ended && typeof y.pos === "number" && moved) {
          var to = Math.max(0, y.pos - b);
          y.woundTo = to;
          try {
            f.contentWindow.postMessage(
              '{"event":"command","func":"seekTo","args":[' + to + ',true]}', "*");
          } catch (x) {}
        }
        // Ours to put back, and only if we have reason to believe it was running. The pause command
        // above is sent to EVERY player on the card on purpose — pausing something already paused costs
        // nothing — but marking every one of them would have the resume press play on embeds you never
        // touched. `live` is the same reading the wind uses, and a frame that never answered the
        // handshake has no y at all, so it is never claimed. Cleared in the message listener the moment
        // the player reports playing; see there.
        if (y && y.seen && live && !y.ended) { y.byUs = true; ownClaim(keyFor(f, j)); }
      }
    } catch (x) {}
    return n;
  };

  // The other half. Starts again ONLY what __fgPauseMedia stopped, and nothing else on the card.
  //
  // That restriction is the whole design. "Play the media on this card" would be a much simpler thing
  // to write and a much worse thing to have: a card with three embeds would start all three the moment
  // you sat back down, and a video you had deliberately paused would refuse to stay paused. So each
  // player carries its own mark, put there by the pause and taken away the moment it plays again —
  // whoever pressed play. Nothing here can start something that was not ours.
  //
  // No rewinding here. The winding already happened, at the moment of the pause, and the position it
  // wound to is where the player is sitting: there is nothing left to adjust, and adjusting it again
  // would take another few seconds off every time the conditions flickered.
  window.__fgResumeMedia = function(){
    var n = 0;
    try {
      var els = document.querySelectorAll("video, audio");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        // Ours by the mark on the element, or ours by the claim filed against this MEDIA. The second
        // is what makes a resume survive the card being rebuilt — see window.__fgOwn. Marked up now
        // as well, so everything below this line can go on reading one flag.
        if (!el.__fgByUs && ownHeld(keyFor(el, i))) el.__fgByUs = true;
        if (!el.__fgByUs) continue;
        // An element adopted from a claim rather than marked by the pause has never been given the
        // listener that lets go of it, because the element the pause marked was a different one —
        // this card's nodes are new. Without this the claim would only ever be released by its own
        // ten-minute expiry, so the video would be started again on every later resume of this
        // session. Attached here, once, and identical to the one __fgPauseMedia attaches.
        if (!el.__fgPlayHook) {
          el.__fgPlayHook = true;
          try {
            el.addEventListener("play", function(){
              el.__fgByUs = false;
              ownRelease(el.__fgKey);
            }, false);
          } catch (x2) {}
        }
        // Still paused, or there is nothing to do. Also the guard against the `play` listener and this
        // racing: whichever runs first, the other finds the state already correct.
        try {
          if (el.paused) {
            // THE MARK IS NOT CLEARED HERE, and that is the whole of the second auto-resume bug.
            //
            // It used to be cleared on this line, before play() had been called, let alone before
            // anyone knew whether it worked. Chromium's autoplay policy routinely refuses play() in
            // this webview — the card has had no user gesture since the pause — and the refusal arrives
            // as a rejected promise a tick later, by which time the only record that this element was
            // ours had already been thrown away. The extension's second and third attempts then found
            // nothing marked and skipped the element entirely. One refusal and the video never came
            // back, which is exactly what "auto resume doesn't work" looked like.
            //
            // So the mark is left standing and the `play` listener __fgPauseMedia attached is what
            // clears it — on the event, which only fires when playback ACTUALLY started, whoever
            // started it. That listener is the only thing on the page with first-hand evidence, and
            // this is the same lesson the iframe branch below already learned and wrote down: never
            // release a claim on the strength of a command you merely sent.
            //
            // Nothing leaks. `play` clears it whether it was us or you, and __fgPauseMedia only marks
            // what it actually stopped.
            //
            // The catch is still needed: an unhandled rejection is a console error about something that
            // does not matter.
            var p = el.play();
            if (p && typeof p.catch === "function") p.catch(function(){});
            n++;
          } else {
            // Already running, so whatever we were holding, we are not holding it now. This is the one
            // place clearing on the way out is honest, because the state has been read rather than
            // requested.
            el.__fgByUs = false;
            ownRelease(el.__fgKey);
          }
        } catch (x) {
          // play() threw synchronously, which for a detached or torn-down element it can. The mark goes
          // in this branch and only this one: there is no element left to resume, so keeping the claim
          // would have the extension spend its remaining attempts on something that cannot answer.
          try { el.__fgByUs = false; ownRelease(el.__fgKey); } catch (z) {}
        }
      }
    } catch (x) {}
    try {
      var all = document.getElementsByTagName("iframe");
      for (var j = 0; j < all.length; j++) {
        var f = all[j];
        if (!isVideoHost(String(f.getAttribute("src") || ""))) continue;
        var y = f.__fgYt;
        // Ours by the mark on the frame, or ours by the claim filed against this video. Same fix as
        // the <video> branch above, and the case it covers is the commoner one here: an embed's
        // `__fgYt` is created by the handshake, so a rebuilt card starts with no mark at all and the
        // lecture you paused was simply never a candidate for resuming.
        //
        // The frame must have answered the handshake before it is played, claim or no claim. A frame
        // that has not reported a state cannot be told to play either — the command would be sent
        // into a document that has not loaded its player yet and dropped — so this is not a
        // restriction, it is the difference between trying and pretending to try.
        if (y && !y.byUs && y.seen && ownHeld(keyFor(f, j))) y.byUs = true;
        if (!y || !y.byUs) continue;
        // The mark is NOT cleared here. It is cleared by the state message that says the player is
        // playing, which is the only evidence the command actually landed — YouTube can ignore a
        // command sent to a frame that is still loading, and clearing on the way out would spend our
        // one attempt on a message nobody received. The extension retries a couple of times, so an
        // ignored command is asked again a second and a half later.
        try {
          f.contentWindow.postMessage(
            '{"event":"command","func":"playVideo","args":[]}', "*");
          n++;
        } catch (x) {}
      }
    } catch (x) {}
    return n;
  };

  var ticks = 0;
  prep();
  // After prep, because prep is what gives the iframes their src back; before look, so the first
  // reading reports the resumed position rather than zero and the add-on does not immediately
  // write a 0 over the number it just handed us.
  try {
    var rels = document.querySelectorAll("video, audio");
    for (var ri = 0; ri < rels.length; ri++) restore(rels[ri], ri);
  } catch (x) {}
  look();
  ping();
  // The probe polls itself rather than waiting to be asked, so that a YouTube frame
  // which loads a second after the card does still gets its handshake.
  if (window.__fgMediaTimer) clearInterval(window.__fgMediaTimer);
  window.__fgMediaTimer = setInterval(function(){
    try {
      if (!window.__fgMedia || window.__fgMedia.token !== TOK) { clearInterval(window.__fgMediaTimer); return; }
      // ping() filters to the frames that have not answered, so this no longer needs a condition of
      // its own — and must not have one. `st.yt && !st.ytSeen` stopped the retry the moment the
      // first of thirty players replied, leaving the other twenty-nine mute for the life of the card.
      // Throttled to every third tick because a card can hold thirty of them and a handshake is not
      // urgent; the frames that matter answer within a second either way.
      if (++ticks % 3 === 1) ping();
      look();
    } catch (x) {}
  }, 400);
} catch (e) {
  // A card template that throws must not take the probe's absence as "no media".
  // Leaving window.__fgMedia unset makes the add-on report "don't know", which does
  // not gate — see the note above about dead ends.
  try { window.__fgMedia = null; } catch (x2) {}
}
})();</script>
"""


# ---------------------------------------------------------------------------
# Where you left off.
#
# A card with a twenty-minute lecture on it is not a card you finish in one sitting. Come back to
# it tomorrow and the video started from the beginning again, which meant either scrubbing to find
# your place — on a YouTube embed the size of a flashcard — or watching the first ten minutes
# again. Neither is studying.
#
# So the position of every player on a card is written down and handed back the next time that card
# comes up. Kept per card id, which is what makes "the same card" mean the same thing after a
# restart, and per player within it, because a card can carry several.
#
# It lives in a small JSON file rather than in the collection. The collection syncs and is the
# user's data; where you paused a video is neither — it is a convenience local to this machine, and
# putting it in the collection would mean a database write every few seconds and a sync conflict
# for anyone reviewing on two computers. user_files is the folder Anki preserves across add-on
# updates, which the add-on folder itself is not.
_POS_MAX_CARDS = 400      # cards remembered, oldest dropped first
_POS_MAX_PER_CARD = 40    # players remembered on one card
_POS_KEEP_DAYS = 60       # a resume point older than this is not one
_POS_SAVE_EVERY = 10.0    # seconds between writes, at most
_pos_store = None         # {card id: {"t": {key: seconds}, "at": epoch}}
_pos_dirty = False
_pos_saved_at = 0.0


def _pos_path():
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user_files")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return os.path.join(d, "media_pos.json")


def _pos_load():
    """Read the file once, and never let a bad one matter.

    Every value is re-checked on the way in rather than trusted. This file is on disk between runs,
    so it can have been hand-edited, half-written by a machine that lost power, or left behind by a
    future version of this add-on — and the one thing it must never do is throw inside a card-show
    hook, which would leave the card blank.
    """
    global _pos_store
    if _pos_store is not None:
        return _pos_store
    _pos_store = {}
    try:
        with open(_pos_path(), "r", encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            for cid, ent in raw.items():
                if not isinstance(ent, dict) or not isinstance(ent.get("t"), dict):
                    continue
                times = {}
                for k, v in ent["t"].items():
                    if isinstance(v, bool) or not isinstance(v, (int, float)):
                        continue
                    if v > 1:
                        times[str(k)[:300]] = float(v)
                if times:
                    at = ent.get("at")
                    _pos_store[str(cid)] = {
                        "t": times,
                        "at": float(at) if isinstance(at, (int, float)) else 0.0,
                    }
    except Exception:
        _pos_store = {}
    return _pos_store


def _pos_prune():
    """Keep the file small and the memory honest."""
    st = _pos_load()
    cut = time.time() - _POS_KEEP_DAYS * 86400
    for cid in [c for c, e in st.items() if (e.get("at") or 0) < cut]:
        st.pop(cid, None)
    if len(st) > _POS_MAX_CARDS:
        oldest = sorted(st, key=lambda c: st[c].get("at") or 0)
        for cid in oldest[:len(st) - _POS_MAX_CARDS]:
            st.pop(cid, None)


def _pos_save(force=False):
    """Write, at most every _POS_SAVE_EVERY seconds unless forced.

    Throttled because the probe reports a new position about once a second and this runs on Anki's
    GUI thread — a file write per second while a video plays is a thing you would feel. Written to a
    temporary file and moved into place, so a crash mid-write leaves the previous file intact rather
    than a truncated one that _pos_load then throws away.
    """
    global _pos_dirty, _pos_saved_at
    if not _pos_dirty:
        return
    now = time.time()
    if not force and (now - _pos_saved_at) < _POS_SAVE_EVERY:
        return
    _pos_saved_at = now
    tmp = ""
    try:
        _pos_prune()
        path = _pos_path()
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_pos_load(), f, separators=(",", ":"))
        os.replace(tmp, path)
        # Cleared AFTER the write lands, not before it.
        #
        # It was set false on the way in, so any failure — a locked file, a full disk,
        # antivirus holding the .tmp, a permissions problem in user_files — was swallowed
        # below with nothing left marked as needing saving. The positions then sat in
        # memory and were never retried, not even by the forced saves on card change and
        # profile close, because both of those return early on a clean flag. One transient
        # error disabled video resume for the rest of the session.
        _pos_dirty = False
    except Exception:
        # And the half-written temporary file goes, rather than being left beside the
        # real one until something happens to overwrite it.
        if tmp:
            try:
                os.remove(tmp)
            except Exception:
                pass


def _pos_for_card(card):
    """The saved positions for this card, as plain JSON to paste into the page."""
    try:
        cid = int(getattr(card, "id", 0) or 0)
        ent = _pos_load().get(str(cid)) if cid else None
        times = (ent or {}).get("t") or {}
        blob = json.dumps({k: round(v, 1) for k, v in times.items()})
    except Exception:
        blob = "{}"
    # A key is a media path or a video id, both of which come from the user's own note — so it can
    # contain anything, including the four characters that would end the <script> element early and
    # spill the rest of the probe onto the card as text. json.dumps escapes quotes and backslashes;
    # it has no reason to escape this, because it does not know it is writing into HTML.
    return blob.replace("</", "<\\/")


def _pos_note(pos):
    """Take a reading from the probe. Nothing is written to disk here — see _pos_save."""
    global _pos_dirty
    if not isinstance(pos, dict):
        return
    cid = 0
    try:
        cid = int(getattr(getattr(getattr(mw, "reviewer", None), "card", None), "id", 0) or 0)
    except Exception:
        cid = 0
    if not cid:
        return
    st = _pos_load()
    ent = st.get(str(cid))
    if ent is None:
        ent = st[str(cid)] = {"t": {}, "at": 0.0}
    changed = False
    for k, v in pos.items():
        try:
            t = float(v)
        except Exception:
            continue
        key = str(k)[:300]
        # 0 means "finished, forget it" — see the note beside st.pos in the probe. Anything under a
        # second is not a place worth returning to either.
        if not (t > 1):
            if ent["t"].pop(key, None) is not None:
                changed = True
            continue
        # A whole second of difference, or it is the same place. The probe reports about once a
        # second, and rewriting the same number is a file write for nothing.
        if abs(float(ent["t"].get(key) or 0) - t) >= 1:
            ent["t"][key] = t
            changed = True
    if len(ent["t"]) > _POS_MAX_PER_CARD:
        for key in list(ent["t"])[:len(ent["t"]) - _POS_MAX_PER_CARD]:
            ent["t"].pop(key, None)
    if not ent["t"]:
        st.pop(str(cid), None)
        _pos_dirty = _pos_dirty or changed
        return
    if changed:
        ent["at"] = time.time()
        _pos_dirty = True


# ---------------------------------------------------------------------------
# What the card in front of you is about
#
# The extension can gate YouTube on a video's title, but it has no idea what you are studying.
# Only this side does. So the front of the current card goes out with the status blob, the
# extension pulls keywords out of it locally (keywords.js), and a video whose title carries one
# of them is allowed while everything else is not.
#
# THE FRONT FIELD, NOT THE RENDERED QUESTION, and that choice is doing real work:
#
#   • A cloze card's rendered question has "[...]" where the answer is — so the deleted word,
#     which is the entire subject of the card, is missing from exactly the cards where it
#     matters most. The raw field still says "{{c1::aliasing}}", and the extension knows how to
#     read that.
#   • The rendered question also carries the note type's template, the card styling, and this
#     add-on's own media probe. All of that is furniture, and a probe variable named
#     `probeEverything` is precisely the kind of long alphabetic token that survives every
#     filter on the other side.
#   • It is far smaller. A rendered card can be a page of HTML with a base64 image in it.
#
# The first NON-EMPTY field, because a note whose first field is blank is ordinary, and the
# first field is the front in every stock note type and nearly every custom one.
_card_front = ""
_card_id = 0
# Enough to say what a card is about, and not a byte more. This crosses to the extension twice
# a second while you review; a long card is a long card because of its explanation, and the
# subject is in the first sentence.
CARD_TEXT_MAX = 1200

_SCRIPT_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>", re.I | re.S)
_TAG_RE = re.compile(r"<[^>]*>")
_ENT_RE = re.compile(r"&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);")
_WS_RE = re.compile(r"\s+")


def _card_plain(html):
    """One field's HTML as one line of plain text.

    Deliberately only the size-critical half of the job. The extension does the full clean —
    cloze markers, [sound:] tags, entities — because that is where the keyword tests live, and
    two strippers that disagree about what a card says is two different sets of keywords. What
    is done HERE is what has to be done here: throw away the parts that make a card enormous,
    so a base64 image cannot push the actual words past CARD_TEXT_MAX.

    A tag becomes a SPACE. Deleting it instead welds "signal<br>processing" into one word that
    matches nothing.
    """
    try:
        s = _SCRIPT_RE.sub(" ", str(html or ""))
        s = _TAG_RE.sub(" ", s)
        s = s.replace("&nbsp;", " ")
        s = _ENT_RE.sub(" ", s)
        return _WS_RE.sub(" ", s).strip()[:CARD_TEXT_MAX]
    except Exception:
        return ""


def _card_text(card):
    """The front of this card, as plain text. Empty for anything that cannot be read.

    Touches the collection (card.note()), so GUI thread only — which is where card_will_show
    runs. Every access is defensive: this is called on the path that draws your cards, and an
    exception here would be this add-on breaking the reviewer.
    """
    try:
        note = card.note()
        fields = list(getattr(note, "fields", None) or [])
    except Exception:
        return ""
    for v in fields:
        s = _card_plain(v)
        if s:
            return s
    return ""


# ---------------------------------------------------------------------------
# Locking the collection while the goal is unfinished
#
# The video gate above reads the front of your current card. That makes the card front into a
# key, and a key you can edit is not a key: type "music" into the card you are on, and every
# music video on YouTube is suddenly study material. The gate cannot possibly tell an honest
# music-theory card from one edited thirty seconds ago — the words are identical — so the hole
# cannot be closed by being cleverer about matching. It has to be closed by not letting the card
# change while it is being used as a key.
#
# So: while the extension says the goal is unfinished, editing, adding, deleting and browsing
# are refused. Reviewing is untouched — you can answer cards exactly as normal, which is the
# entire point of the session.
#
# WHERE THE GUARD GOES. Anki funnels all three windows through one call, aqt.dialogs.open:
# the reviewer's Edit button is onEditCurrent → open("EditCurrent"), Add is
# open("AddCards"), Browse is open("Browser"). One wrapper on that one function covers the
# Edit button, the E/A/B shortcuts, the menu items and the toolbar links at once, and it does
# so without this file needing to know the name of a single Anki method that might get renamed.
# Deleting is the one that does not go through a dialog, so the reviewer's own delete is wrapped
# separately.
#
# Browse is included on purpose, even though browsing is not editing. It is the room where the
# editing happens; leaving it open would mean guarding the door and not the window.
#
# THE THREE WAYS OUT, all deliberate, because a lock with no way out is a bug and not a feature:
#   • finish today's goal — the extension stops asking for the lock;
#   • turn the switch off in the extension's Settings — lifts within one poll;
#   • close the browser, disable the extension, or let it crash — LOCK_STALE_SEC lifts it on
#     its own. This one is the important one: nothing about a locked collection may depend on
#     another program staying alive, or uninstalling the extension would leave Anki maimed.
#
# WHAT IT DOES NOT COVER, stated rather than implied: AnkiConnect. Its updateNoteFields endpoint
# writes to the collection over HTTP without touching any of Anki's windows, so somebody willing
# to POST JSON at port 8765 can still change a card. Closing that would mean patching the
# collection itself, which risks breaking real editing for everyone to inconvenience a person
# who has decided to defeat their own study tool with curl. This is a lock on the door you would
# actually reach for in a weak moment, which is what self-discipline features are for.
#
# ADDING is the exception, and it has a switch of its own — see NO NEW CARDS below. That one does
# patch the collection, because the door people actually reach for there is not a window at all:
# it is a browser extension that makes cards through AnkiConnect.
_lock_want = False      # written by the HTTP thread, read on the GUI thread
_lock_at = 0.0          # when that word arrived, for LOCK_STALE_SEC
# No word from the extension for this long and the lock lifts itself. Comfortably more than the
# three-second poll, so an ordinary hiccup never unlocks — and short enough that a browser you
# closed does not leave your collection read-only for the rest of the evening.
LOCK_STALE_SEC = 20.0
_lock_patched = False
_lock_orig = {}
# The three windows through which a card can be changed. Named as Anki names them.
LOCKED_DIALOGS = ("EditCurrent", "AddCards", "Browser")
_LOCK_WHY = {
    "EditCurrent": "Editing cards",
    "AddCards": "Adding cards",
    "Browser": "The card browser",
}

# ---------------------------------------------------------------------------
# LOCKING THE ADD-ON MANAGER — a second, separate switch
#
# Its own flag rather than part of the card lock above, because the two protect against
# different things and a person may reasonably want one without the other. The card lock stops
# you rewriting a card to smuggle a keyword through the YouTube gate. This one stops you walking
# up to Tools → Add-ons and turning THIS add-on off, which would end the session outright: no
# more review counts, no more card keywords, no more window checks, and the collection lock
# lifted by its own staleness timer twenty seconds later. It is the master switch, so it is the
# one worth guarding.
#
# WHERE THE DOOR ACTUALLY IS, checked against Anki's source rather than guessed at. AnkiQt has no
# onAddons method, and setupMenus does not wire the add-ons item at all; the menu is connected in
# AddonManager.__init__ with
#     qconnect(f.actionAdd_ons.triggered, self.onAddonsDialog)
# and that method's whole body is
#     aqt.dialogs.open("AddonsDialog", self)
# So Tools → Add-ons arrives at the SAME aqt.dialogs.open that Edit, Add and Browse go through, and
# the guard already sitting on it covers this for one extra string comparison.
#
# TWO AND A HALF LAYERS:
#   1. aqt.dialogs.open("AddonsDialog") — the door, per the above. A module-level function looked
#      up at call time, so wrapping it is seen no matter who calls it.
#   2. toggleEnabled and deleteAddon — the acts themselves, and this layer is easy to miss: the
#      add-on window may already be OPEN when the session starts. Guarding only the door would
#      leave that window sitting there, fully working. These are reached as self.mgr.toggleEnabled
#      from inside the dialog, so an instance-attribute wrapper is picked up.
#   2½. AddonManager.onAddonsDialog — wrapped for anything that calls it directly, and NOT for the
#      menu item: Qt was handed that bound method in AddonManager.__init__, which runs in
#      setupAddons before a single add-on has been imported, so nothing this file does afterwards
#      can change what the menu click invokes. Layer 1 is what catches the menu. This one is here
#      because it is free, not because it is load-bearing — and saying so is the point, since a
#      guard everyone believes in and nothing fires is worse than no guard at all.
#
# THE WAYS OUT are the same three as the card lock, including the staleness timer, which is what
# keeps this from being able to trap you: a browser that crashes cannot leave you unable to
# manage your own add-ons.
#
# NOT COVERED, said plainly: Anki's debug console (Ctrl+Shift+;) runs arbitrary Python and can
# undo any of this in one line. Nothing short of refusing to load would stop that, and somebody
# opening a Python console has stopped being the distracted person this feature is for.
_lock_addons_want = False
LOCKED_ADDON_DIALOGS = ("AddonsDialog",)

# ---------------------------------------------------------------------------
# NO NEW CARDS — a third, separate switch
#
# While today's goal is unfinished, nothing adds a card: not Anki's Add window, not a browser
# extension posting to AnkiConnect (a YouTube-to-Anki tool, say), not another add-on. Adding is the
# enjoyable half of Anki and reviewing is the half that makes it stick, so this is the rule "today's
# reviews first", enforced where it cannot be walked around.
#
# Its own switch rather than part of the card lock, because it asks something different: that one
# freezes the card you are on so it cannot be rewritten into a key for the video gate, and freezes
# editing and browsing with it. Somebody can want "no new cards until I'm done" without giving up the
# browser, and the reverse.
#
# WHERE THE GUARD GOES — and why this one, unlike the card lock, is on the COLLECTION. The windows
# are not where adding happens for the people who asked for this: AnkiConnect's addNote calls
# collection.addNote, addNotes loops over it, and other add-ons call add_note directly. None of
# them opens a window. Every one of them ends up in a handful of Collection methods, checked against
# this Anki's own source rather than guessed at:
#
#     add_note, add_notes, addNote (which calls add_note), add_image_occlusion_note
#     import_anki_package, import_csv, import_json_file, import_json_string
#
# plus the legacy importers' run methods, which older tools — AnkiConnect's importPackage among them —
# still use and which write through the database rather than through add_note. Wrapped on the CLASS,
# once, at start-up, so every collection this session opens has them and nothing needs re-patching
# after a profile switch. Each wrapper costs one boolean while unlocked and otherwise behaves exactly
# as the method it wraps.
#
# A REFUSAL IS AN EXCEPTION. At this level there is no window to decline to open, and every caller
# expects the add to have happened if the call returns — so it must not return. AnkiConnect turns the
# exception into {"error": "..."} for the tool that asked, which gets the reason in words; Anki
# itself gets a tooltip that says the same thing, because a tool that swallows the error would
# otherwise leave you wondering where your card went.
#
# Two friendlier doors in front of that, for Anki's own Add window: it will not open while locked
# (the same aqt.dialogs.open wrapper as the card lock), and one that was ALREADY open when the goal
# started refuses its Add button with a tooltip — rather than letting the add reach the collection,
# where Anki would report the refusal as an error with a traceback.
#
# THE WAYS OUT are the same three as the other two locks, staleness timer included, so a browser that
# crashes can never leave Anki unable to add cards.
#
# NOT COVERED, said plainly: cards added on your phone and brought over by a sync — a sync is the
# backend merging two collections, not anything adding a note here — and Anki's debug console.
_lock_new_want = False
# When the last "adding is locked" tooltip was shown. A batch add through AnkiConnect refuses once
# per note, and forty identical tooltips in a row is noise, not information.
_lock_new_toast_at = 0.0
_NEW_CARDS_MSG = ("AnkiGate: new cards are locked until today's Anki goal is done. "
                  "Turn off \"No new cards until I'm done\" in AnkiGate's settings to add one now.")
_IMPORT_MSG = ("AnkiGate: importing cards is locked until today's Anki goal is done. "
               "Turn off \"No new cards until I'm done\" in AnkiGate's settings to import now.")


class AnkiGateLocked(Exception):
    """Raised by the no-new-cards guards. Its message is what a caller like AnkiConnect hands back
    to the tool that asked, so it says what happened and how to undo it, in plain words."""


def _lock_fresh():
    """Has the extension spoken recently enough for any lock to count?

    The staleness half of both locks, factored out so the two cannot drift apart. A flag on its
    own would survive the extension being disabled, uninstalled or crashed, and would then need
    a hand-edited config to undo.
    """
    return (time.time() - _lock_at) <= LOCK_STALE_SEC


def _lock_active():
    """Is the collection locked this instant?"""
    if not _lock_want:
        return False
    return _lock_fresh()


def _lock_addons_active():
    """Is the add-on manager locked this instant?

    Independent of _lock_active on purpose — the switches are separate in the extension's
    Settings, so either can be on without the other.
    """
    if not _lock_addons_want:
        return False
    return _lock_fresh()


def _lock_new_active():
    """Is adding new cards refused this instant? The third switch, independent of the other two."""
    if not _lock_new_want:
        return False
    return _lock_fresh()


def _refuse_new(what, msg):
    """Refuse an add at the collection: say so in Anki, then raise.

    Any thread. AnkiConnect answers on the GUI thread, but an add-on or a CollectionOp can reach the
    collection from a background one, and a tooltip must only ever be shown from the GUI thread — so
    it is handed there through Anki's own task manager rather than called directly.
    """
    global _lock_new_toast_at
    try:
        now = time.time()
        if now - _lock_new_toast_at >= 3.0:
            _lock_new_toast_at = now
            tm = getattr(mw, "taskman", None) if mw is not None else None
            if tm is not None:
                tm.run_on_main(lambda: _lock_refuse(what))
    except Exception:
        pass
    raise AnkiGateLocked(msg)


def _lock_refuse(what):
    """Say why, and say how to get out of it.

    A refusal with no explanation is indistinguishable from Anki being broken — the Edit
    button would simply stop working. GUI thread only, which is where every wrapper below
    runs, so the tooltip can be called directly.
    """
    try:
        from aqt.utils import tooltip
        tooltip("🔒 %s is locked until today's Anki goal is done.<br>"
                "Turn it off in the extension's Settings if you need it now." % what,
                period=4000)
    except Exception:
        pass


def _max_positional(fn):
    """How many positional arguments `fn` accepts, or None when there is no limit.

    Every guard below replaces a method that Qt may be calling as a slot, and PyQt decides
    how many of a signal's arguments to hand a slot by reading the slot's signature. A
    wrapper written as `*args` claims to accept anything, so arguments PyQt would have
    withheld from the original get passed in and then forwarded — which is how a menu
    item wired to `QAction.triggered` (one `bool checked`) reached
    `Reviewer.delete_current_note(self)` with two positional arguments and raised
    TypeError. Nothing about the lock was wrong; the wrapper had simply widened the
    signature Qt was inspecting.

    Measuring the wrapped callable and dropping the surplus is what keeps the wrapper
    transparent: the original is called with exactly the arguments it would have received
    had the guard never been installed.
    """
    try:
        import inspect
        params = list(inspect.signature(fn).parameters.values())
    except Exception:
        # Not everything can be measured — a C-implemented callable without a text signature
        # is the usual case. "No limit" is the safe answer: it forwards everything, which is
        # exactly what these guards did before, so an unmeasurable callable is no worse off
        # than it has always been.
        return None
    n = 0
    for p in params:
        if p.kind == p.VAR_POSITIONAL:
            return None
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD):
            n += 1
    return n


def _call_trimmed(fn, limit, args, kwargs):
    """Call `fn`, dropping the positional arguments it cannot accept.

    Trimming rather than catching TypeError on purpose: a TypeError raised *inside* the
    real method would be indistinguishable from an arity mismatch, and retrying it with
    fewer arguments would run half of Anki's delete twice.
    """
    if limit is not None and len(args) > limit:
        args = args[:limit]
    return fn(*args, **kwargs)


def _read_lock_request(path):
    """`POST /lock?on=1`, from the extension, on the HTTP thread.

    Same handoff as /glow and /media: allow-list the parameter, write a module flag, and let
    the GUI thread act on it. Nothing here touches Qt or the collection.

    Restated by the extension on every poll rather than sent once, which is what makes
    LOCK_STALE_SEC work — silence is meaningful, so it has to be silence rather than the
    absence of a second message.

    `addons` is the second switch and is optional. Missing means OFF, not "leave it as it was":
    an extension too old to know about this parameter must not be able to lock the add-on
    manager by omission, and since every poll restates the value, absence is a faithful no.

    `new` is the third — no new cards — and is optional on exactly the same terms.
    """
    global _lock_want, _lock_at, _lock_addons_want, _lock_new_want
    try:
        qs = parse_qs(urlparse(path or "").query or "")
        on = (qs.get("on", [""])[0] or "").strip()
        addons = (qs.get("addons", ["0"])[0] or "0").strip()
        new = (qs.get("new", ["0"])[0] or "0").strip()
    except Exception:
        return False
    if on not in ("0", "1"):
        return False
    # A malformed second or third parameter is treated as off rather than rejecting the whole
    # request: the card lock is the most important of the three and should not fail over a typo in
    # another one.
    _lock_want = (on == "1")
    _lock_addons_want = (addons == "1")
    _lock_new_want = (new == "1")
    _lock_at = time.time()
    return True


def _install_lock_guards():
    """Wrap the ways into editing. Once per session, from _start, on the GUI thread.

    Installed unconditionally rather than when the lock comes on, and that is the safer
    arrangement by some distance: the wrappers ask _lock_active() at the moment they are
    called, so an unlocked collection pays one boolean and behaves exactly as before. The
    alternative — patching and unpatching as the lock comes and goes — means a patch can be
    installed twice, or removed while another add-on's own wrapper sits on top of it, and
    unwinding that correctly is not possible from here.
    """
    global _lock_patched
    if _lock_patched:
        return
    _lock_patched = True

    # 1. Edit, Add and Browse — all three through Anki's one dialog opener.
    try:
        import aqt as _aqt
        dm = getattr(_aqt, "dialogs", None)
        orig_open = getattr(dm, "open", None)
        if dm is not None and callable(orig_open):
            def guarded_open(name, *args, **kwargs):
                try:
                    nm = str(name)
                    if _lock_active() and nm in LOCKED_DIALOGS:
                        _lock_refuse(_LOCK_WHY.get(nm, "That window"))
                        return None
                    if _lock_addons_active() and nm in LOCKED_ADDON_DIALOGS:
                        _lock_refuse("The add-on manager")
                        return None
                    # The Add window is the no-new-cards lock's door too. AnkiConnect's
                    # guiAddCards comes through here as well.
                    if _lock_new_active() and nm == "AddCards":
                        _lock_refuse("Adding new cards")
                        return None
                except Exception:
                    pass
                return orig_open(name, *args, **kwargs)
            dm.open = guarded_open
            _lock_orig["dialogs"] = (dm, orig_open)
    except Exception:
        pass

    # 2. Deleting the card you are on. The only one of the four that opens no window, so it
    #    cannot be caught above. Both spellings are tried because Anki renamed this method —
    #    older builds call it onDelete, newer ones delete_current_note — and wrapping whichever
    #    exists means neither version silently loses the guard.
    try:
        rev = getattr(mw, "reviewer", None)
        if rev is not None:
            for attr in ("delete_current_note", "onDelete"):
                orig_del = getattr(rev, attr, None)
                if not callable(orig_del):
                    continue
                def make(o):
                    # Measured once, at install time, not on every call: the method being
                    # wrapped does not change signature while Anki is running.
                    limit = _max_positional(o)

                    def guarded_delete(*args, **kwargs):
                        try:
                            if _lock_active():
                                _lock_refuse("Deleting cards")
                                return None
                        except Exception:
                            pass
                        return _call_trimmed(o, limit, args, kwargs)
                    return guarded_delete
                setattr(rev, attr, make(orig_del))
                _lock_orig["rev:" + attr] = (rev, orig_del)
    except Exception:
        pass

    # 3. The add-on manager's own methods. Three on one object, wrapped with one loop.
    #
    #    toggleEnabled and deleteAddon are the two that matter: they are the acts that would end
    #    the session, and the add-on window may already have been open when it started, so the
    #    door above would not have been passed through. The dialog reaches them as
    #    self.mgr.toggleEnabled — an attribute lookup at call time — so wrapping the instance is
    #    seen.
    #
    #    onAddonsDialog is wrapped for direct callers only. The menu item does NOT come through
    #    here; see the note at the top of this section for why. It is kept because it costs one
    #    boolean, not because anything depends on it.
    #
    #    A missing name is skipped rather than treated as an error, the same as the delete guard
    #    above, so an Anki that has renamed one of these loses that one guard and keeps the rest.
    try:
        mgr = getattr(mw, "addonManager", None)
        if mgr is not None:
            for attr, why in (("onAddonsDialog", "The add-on manager"),
                              ("toggleEnabled", "Enabling and disabling add-ons"),
                              ("deleteAddon", "Deleting add-ons")):
                orig_am = getattr(mgr, attr, None)
                if not callable(orig_am):
                    continue

                def make_am(o, w):
                    # Same arity guard as the delete wrapper above. onAddonsDialog is the
                    # one at real risk here — it takes no arguments, so anything that wires
                    # it straight to a triggered signal would hit the identical TypeError.
                    limit = _max_positional(o)

                    def guarded_am(*args, **kwargs):
                        try:
                            if _lock_addons_active():
                                _lock_refuse(w)
                                return None
                        except Exception:
                            pass
                        return _call_trimmed(o, limit, args, kwargs)
                    return guarded_am
                setattr(mgr, attr, make_am(orig_am, why))
                _lock_orig["am:" + attr] = (mgr, orig_am)
    except Exception:
        pass

    # 4. No new cards: the collection's own ways of adding, on the class. See NO NEW CARDS above
    #    for why this lock, unlike the other two, lives below the windows.
    _install_new_card_guards()


def _guard_class_method(cls, attr, key, what, msg):
    """Wrap `cls.attr` so it raises AnkiGateLocked while the no-new-cards lock is on.

    Only a method the class defines ITSELF is wrapped — `cls.__dict__`, not getattr — so a method
    inherited from a base class is never copied down onto the subclass, and putting the original back
    restores exactly what was there. A name this Anki does not have is skipped, so a renamed method
    loses its own guard and nothing else.
    """
    try:
        orig = cls.__dict__.get(attr) if cls is not None else None
        if not callable(orig):
            return

        def make(o):
            def guarded_new(*args, **kwargs):
                if _lock_new_active():
                    _refuse_new(what, msg)
                return o(*args, **kwargs)
            try:
                guarded_new.__name__ = getattr(o, "__name__", attr)
                guarded_new.__qualname__ = getattr(o, "__qualname__", attr)
                guarded_new.__doc__ = getattr(o, "__doc__", None)
                guarded_new.__wrapped__ = o
            except Exception:
                pass
            return guarded_new
        setattr(cls, attr, make(orig))
        # "<owner>:<attr>", so _remove_lock_guards puts it back with the rest.
        _lock_orig[key + ":" + attr] = (cls, orig)
    except Exception:
        pass


def _install_new_card_guards():
    """The no-new-cards guards. Called once, from _install_lock_guards."""
    # The collection: adding, and importing. Checked against Anki 25.09's own Collection — addNote is
    # the legacy spelling AnkiConnect's addNote uses, and it calls add_note, so an add it starts is
    # refused at the first of the two it reaches.
    try:
        from anki.collection import Collection as _Col
        for attr in ("add_note", "add_notes", "addNote", "add_image_occlusion_note"):
            _guard_class_method(_Col, attr, "col", "Adding new cards", _NEW_CARDS_MSG)
        for attr in ("import_anki_package", "import_csv", "import_json_file", "import_json_string"):
            _guard_class_method(_Col, attr, "col", "Importing cards", _IMPORT_MSG)
    except Exception:
        pass
    # The legacy importers, which write through the database rather than through add_note and are
    # still what older tools call — AnkiConnect's importPackage is one. Each class that defines its
    # own run is wrapped; AnkiPackageImporter is refused before it unpacks anything.
    for mod_name, cls_name, key in (("anki.importing.apkg", "AnkiPackageImporter", "apkgimp"),
                                    ("anki.importing.anki2", "Anki2Importer", "anki2imp"),
                                    ("anki.importing.noteimp", "NoteImporter", "noteimp")):
        try:
            mod = __import__(mod_name, fromlist=[cls_name])
            _guard_class_method(getattr(mod, cls_name, None), "run", key, "Importing cards", _IMPORT_MSG)
        except Exception:
            pass
    # An Add window that was already open when the goal started. Its Add button and Ctrl+Enter go to
    # AddCards.add_current_note, which is refused here with a tooltip rather than being let through to
    # the collection — where the refusal would be a raised exception, and Anki shows those as an
    # error box with a traceback in it. On the class, so a window opened later is covered the same.
    # Qt hands this slot the button's `checked` flag, hence the same arity trim as the delete guard.
    try:
        import aqt.addcards as _ac
        cls = getattr(_ac, "AddCards", None)
        orig_add = cls.__dict__.get("add_current_note") if cls is not None else None
        if callable(orig_add):
            limit = _max_positional(orig_add)

            def guarded_add_current(*args, **kwargs):
                try:
                    if _lock_new_active():
                        _lock_refuse("Adding new cards")
                        return None
                except Exception:
                    pass
                return _call_trimmed(orig_add, limit, args, kwargs)
            try:
                guarded_add_current.__name__ = "add_current_note"
                guarded_add_current.__wrapped__ = orig_add
            except Exception:
                pass
            setattr(cls, "add_current_note", guarded_add_current)
            _lock_orig["addcards:add_current_note"] = (cls, orig_add)
    except Exception:
        pass


def _remove_lock_guards():
    """Put Anki's own methods back, on the way out of the profile.

    Every wrapper already falls through when unlocked, so leaving them in place would be
    harmless — but this add-on can be disabled or updated without Anki restarting, and a
    wrapper closing over a module that has been reloaded is the kind of thing that fails
    weeks later. Giving them back is cheap and needs no explanation.
    """
    global _lock_patched
    try:
        pair = _lock_orig.pop("dialogs", None)
        if pair:
            dm, orig = pair
            dm.open = orig
    except Exception:
        pass
    # Every "<owner>:<attr>" entry — the reviewer's delete, the add-on manager's three — put back
    # by the same loop. Keyed on the colon rather than on a list of prefixes so a guard added later
    # is restored without anybody having to remember to come back here and add it.
    for key in [k for k in list(_lock_orig) if ":" in k]:
        try:
            obj, orig = _lock_orig.pop(key)
            setattr(obj, key.split(":", 1)[1], orig)
        except Exception:
            pass
    _lock_orig.clear()
    _lock_patched = False


def _on_card_will_show(text, card, kind):
    """Add the probe to every card shown in the reviewer, and start a fresh verdict.

    Question and answer are separate shows, and the answer can carry media the
    question didn't, so both get a new token and a rescan.
    """
    global _media_token, _media, _card_front, _card_id
    try:
        if not isinstance(kind, str) or not kind.startswith("review"):
            return text
        # Read on both the question and the answer show. The same card gives the same answer
        # either way — this is the note's front field, not the side being displayed — so the
        # answer show is a free re-read rather than a different reading, and it repairs the
        # value if the question show happened before the collection was ready.
        try:
            _card_id = int(getattr(card, "id", 0) or 0)
            _card_front = _card_text(card)
        except Exception:
            _card_id, _card_front = 0, ""
        _media_token = "%d-%d" % (int(time.time() * 1000), _next_media_id())
        # Forced, because the card being left is the moment its position stops being written to.
        # Left to the throttle, closing Anki within ten seconds of pausing a video would lose it.
        _pos_save(force=True)
        # Until the probe answers, the state of this card is unknown — not "no
        # media". Carrying the previous card's answer over is exactly the bug this
        # token exists to prevent.
        _media = {"present": False, "playing": False, "readable": False,
                  "waiting": False, "at": 0}
        return (text + _MEDIA_JS
                .replace("__FG_TOKEN__", _media_token)
                .replace("__FG_POS__", _pos_for_card(card)))
    except Exception:
        return text


_media_id = 0


def _next_media_id():
    global _media_id
    _media_id += 1
    return _media_id


def _poll_media():
    """Ask the reviewer's webview for the probe's verdict.

    evalWithCallback is asynchronous, so the answer lands on a later tick. Only one
    request is allowed in flight — without that, a slow webview would queue up a
    request per tick and they would all come back at once.
    """
    global _media_pending, _media, _media_sent_at
    try:
        if getattr(mw, "state", "") != "review":
            _media = {"present": False, "playing": False, "readable": False,
                      "waiting": False, "at": 0}
            return
        web = getattr(getattr(mw, "reviewer", None), "web", None)
        if web is None or not hasattr(web, "evalWithCallback"):
            return
        # Still waiting, and not yet waiting absurdly long. See _MEDIA_PROBE_TIMEOUT: a
        # callback that never arrives used to wedge this permanently.
        if _media_pending and (time.time() - _media_sent_at) < _MEDIA_PROBE_TIMEOUT:
            return
        _media_pending = True
        _media_sent_at = time.time()
        want = _media_token

        def done(val):
            global _media_pending, _media
            _media_pending = False
            try:
                d = json.loads(val) if isinstance(val, str) and val else None
            except Exception:
                d = None
            # A verdict for a card that is no longer showing is not evidence about
            # the card that is.
            if not isinstance(d, dict) or d.get("token") != want:
                return
            # Where each player on this card has got to. Behind the same token check as the verdict,
            # and for the same reason: a reading that belongs to the card before this one would file
            # the previous video's position under this card's id.
            _pos_note(d.get("pos"))
            _media = {
                "present": bool(d.get("has")),
                "playing": bool(d.get("playing")),
                "readable": bool(d.get("readable")),
                "waiting": bool(d.get("waiting")),
                "at": int(time.time() * 1000),
            }

        web.evalWithCallback("JSON.stringify(window.__fgMedia || null)", done)
    except Exception:
        _media_pending = False


def _pause_media():
    """Stop whatever is playing on the card being reviewed. Anki's GUI thread only.

    Asked for by the extension whenever its clock stops for ANY reason — your face left the
    camera, Anki stopped being the window in front, you took a break, the wrong deck is open.
    The reasoning is the same one the media gate itself rests on: a video playing while nothing
    is being credited is the case where the gate achieves nothing at all. You get up, the lecture
    runs on without you, and you come back to a video that is twenty minutes further along and a
    clock that has not moved.

    Fire and forget, with no callback: there is nothing useful to do with the answer, and the
    probe's own 400ms loop will report the new state in a moment anyway. `eval` is preferred over
    `evalWithCallback` for exactly that reason, with the callback form as a fallback because older
    Anki webviews do not all carry both.
    """
    try:
        if getattr(mw, "state", "") != "review":
            return False
        web = getattr(getattr(mw, "reviewer", None), "web", None)
        if web is None:
            return False
        # Wrapped in its own try inside the page as well. A card template that has thrown may
        # have left the probe unset, and an exception out of eval is noise in Anki's log about a
        # thing that does not matter.
        # The number is rebuilt from an int, never interpolated as text. It arrives off the network
        # in a query string, and a string pasted into JavaScript is a string that can carry
        # JavaScript. _read_media_request has already clamped it; this is the second wall.
        js = ("try{window.__fgPauseMedia&&window.__fgPauseMedia(%d)}catch(e){}"
              % int(max(0, min(120, _media_pause_back))))
        if hasattr(web, "eval"):
            web.eval(js)
        elif hasattr(web, "evalWithCallback"):
            web.evalWithCallback(js, lambda *_a: None)
        else:
            return False
        return True
    except Exception:
        return False


def _resume_media():
    """Start again whatever WE stopped on the card being reviewed. Anki's GUI thread only.

    Asked for by the extension once every one of its conditions is satisfied again — your face is back,
    Anki is in front, the break is over — so that the video carries on from a few seconds before it
    stopped without you reaching for the mouse.

    It carries no arguments, and that is a deliberate limit rather than an omission. Which players get
    played is decided inside the page, from marks that __fgPauseMedia left on the ones it actually
    stopped; a video you paused yourself, or one you never started, is not ours to start. If this took a
    target the extension would be able to ask for "play everything on this card", and it has no business
    being able to ask for that.

    Same shape as _pause_media: fire and forget, `eval` preferred, `evalWithCallback` as the fallback for
    older Anki webviews.
    """
    try:
        if getattr(mw, "state", "") != "review":
            return False
        web = getattr(getattr(mw, "reviewer", None), "web", None)
        if web is None:
            return False
        js = "try{window.__fgResumeMedia&&window.__fgResumeMedia()}catch(e){}"
        if hasattr(web, "eval"):
            web.eval(js)
        elif hasattr(web, "evalWithCallback"):
            web.evalWithCallback(js, lambda *_a: None)
        else:
            return False
        return True
    except Exception:
        return False


def _read_media_request(path):
    """`POST /media?action=pause`, from the extension, on the HTTP thread.

    Only a flag is set here; the work happens on the next tick, because touching Qt or the
    webview from this thread is not allowed. In the query string rather than the body for the
    same reason as /glow — _drain_body() throws bodies away so that a half-read request can
    never desynchronise a keep-alive connection.
    """
    global _media_pause_wanted, _media_pause_back, _media_resume_wanted
    try:
        qs = parse_qs(urlparse(path or "").query or "")
    except Exception:
        return False
    action = (qs.get("action", [""])[0] or "").strip().lower()
    # An allow-list of two. Anything else is a caller talking to a version of this add-on that
    # does not exist, and answering 400 says so instead of quietly doing nothing.
    if action == "resume":
        # Nothing else to read: what gets played is decided in the page, from the marks __fgPauseMedia
        # left on the players it stopped. The extension cannot name them and must not be able to —
        # "play everything on this card" is not a thing it should be able to ask for.
        _media_resume_wanted = True
        return True
    if action != "pause":
        return False
    # How far back to wind the player, clamped here rather than trusted. It arrives off the network
    # as text; the settings page's own box allows 0 to 120 and so does this.
    try:
        _media_pause_back = max(0, min(120, int(float(qs.get("back", ["0"])[0] or 0))))
    except Exception:
        _media_pause_back = 0
    # A pause cancels a resume that has not been spent yet. They arrive on different polls and the flags
    # live until the next tick, so without this a stop that lands in the same tick window as a start
    # could be undone by the resume queued a moment earlier.
    _media_resume_wanted = False
    _media_pause_wanted = True
    return True


_MEDIA_UNKNOWN = {"media_present": False, "media_playing": False,
                  "media_readable": False, "media_waiting": False}


def _media_view():
    """What to tell the extension. Anything stale reads as "don't know"."""
    try:
        at = int(_media.get("at") or 0)
        if at <= 0 or (int(time.time() * 1000) - at) > MEDIA_STALE_MS:
            return dict(_MEDIA_UNKNOWN)
        return {
            "media_present": bool(_media.get("present")),
            "media_playing": bool(_media.get("playing")),
            "media_readable": bool(_media.get("readable")),
            "media_waiting": bool(_media.get("waiting")),
        }
    except Exception:
        return dict(_MEDIA_UNKNOWN)


# ---------------------------------------------------------------------------
# Unlock gates that only Anki can answer.
#
# The extension can gate on time and on a raw review count by itself. Three more
# useful conditions it cannot:
#
#   "clear today's due"     AnkiConnect can search for `is:due`, but that search
#                           ignores your daily limits. A 500-card backlog behind a
#                           100-a-day limit answers "500 due" for ever, so the gate
#                           would be a goal you cannot reach — Anki says you're
#                           finished for the day and the sites stay shut. The deck
#                           LIST is the number that respects limits, and only code
#                           inside Anki can read it.
#
#   "N different cards"     getNumCardsReviewedToday counts reviews, not cards, so
#                           one card answered Again forty times fills a forty-card
#                           quota. Distinct cards means reading the review log.
#
#   "get X% right"          needs each answer's ease button, which again is the
#                           review log.
#
# All three are read here, on Anki's GUI thread, because the collection is not
# thread safe — the HTTP thread must never touch it. So the flow is: the extension
# hands its question over as query parameters on the status poll it already makes,
# the HTTP thread only writes that question down, and the next timer tick answers
# it. The reply carries the question it answered (`for`), so the extension can tell
# a fresh answer from one about a question it no longer asks.
#
# Nothing is computed unless it was asked for. A user with none of these gates on
# sends no `want`, and not a single query runs.

# Reviews are cheap to count (an indexed range over today only). The deck list is
# not — it walks the collection — so it is asked for a fifth as often.
GOALS_POLL_EVERY = 4        # every 2 s at a 500 ms tick
GOALS_DUE_EVERY = 20        # every 10 s

# How much of the question we will accept. Kept in step with the extension's own
# GOAL_DECK_LIMIT / GOAL_DECK_NAME_MAX: both sides must trim identically or the
# signature the extension compares against will never match what we echo back.
GOAL_DECK_LIMIT = 100
GOAL_DECK_NAME_MAX = 200

# Written by the HTTP thread, read by the GUI thread. A plain dict of plain data,
# replaced wholesale rather than mutated, so the reader can never see half of one
# question and half of the next.
_goal_req = None
_goals = {"for": "", "due": -1, "cards": 0, "pass": 0, "again": 0, "at": 0}
_goals_tick = 0
# The last deck-list reading, kept between the ticks that don't recompute it.
_due_cache = (-1, "")


def _goal_signature(req):
    """The question, as one string. The extension sends the same thing and compares.

    Two deck lists, because the two questions are scoped differently and a user
    genuinely wants them to be. "Which reviews count towards my goal" is one choice
    ("Only these decks count"); "which deck's backlog must be cleared" is another. You
    might well earn time anywhere in the collection but insist the Backlog deck
    specifically reaches zero — so they cannot share one list.
    """
    if not req:
        return ""
    return "%d|%s|%s|%s" % (req.get("since") or 0,
                            "\x1f".join(req.get("decks") or []),
                            "\x1f".join(req.get("duedecks") or []),
                            ",".join(sorted(req.get("want") or [])))


def _deck_name(did):
    try:
        return str(mw.col.decks.name(did))
    except Exception:
        pass
    try:
        d = mw.col.decks.get(did)
        return str(d.get("name", "")) if d else ""
    except Exception:
        return ""


def _under(name, deck):
    """Is `name` this deck or one of its subdecks? Anki joins them with "::", and the
    separator is checked rather than a bare prefix — otherwise a rule about "Bio"
    would also claim a deck called "Biochem"."""
    return bool(name) and bool(deck) and (name == deck or name.startswith(deck + "::"))


def _wanted_deck(name, decks):
    if not decks:
        return True
    return any(_under(name, d) for d in decks)


def _due_totals(decks):
    """Cards still waiting today: learning + review, from Anki's own deck list.

    New cards are deliberately left out. They are a choice, not a debt — gating on
    them would mean a user who doesn't want to start new material today can never
    finish, and the honest reading of "clear today's due" is the cards Anki is
    asking you to come back to.

    Returns -1 for "couldn't tell", which the extension treats as "don't enforce".
    """
    # The lookup itself is inside the try, not guarded by getattr defaults. A default
    # only suppresses AttributeError, and reaching into a live application's object
    # graph can fail in other ways — so `getattr(col, "sched", None)` is not the safe
    # call it looks like. Found by a test that handed this a collection whose
    # attributes raise.
    try:
        fn = mw.col.sched.deck_due_tree
        if not callable(fn):
            return -1
        root = fn()
    except Exception:
        return -1

    # Full deck name -> (learn, review), plus the top-level names, because "the whole
    # collection" is the sum of the top level and NOT the sum of every node — a
    # parent's counts already include its children. (Anki's own words for these three
    # fields: "counts after adding children+applying limits".)
    counts = {}
    tops = []

    def walk(node, depth):
        for ch in (getattr(node, "children", None) or []):
            # The full name is asked of the deck manager rather than assembled from
            # the tree. A node's own `name` is just the last component — "Ch1", not
            # "Bio::Ch1" — which is why the node also carries a `level`. Joining the
            # components while walking would work, but it is an assumption about a
            # structure we don't own, and the deck id right here answers the same
            # question outright.
            did = int(getattr(ch, "deck_id", 0) or 0)
            name = _deck_name(did) if did else ""
            if not name:
                continue
            counts[name] = (int(getattr(ch, "learn_count", 0) or 0),
                            int(getattr(ch, "review_count", 0) or 0))
            if depth == 0:
                tops.append(name)
            walk(ch, depth + 1)

    try:
        walk(root, 0)
    except Exception:
        return -1

    if decks:
        # Drop any deck that sits under another one we were given, or a parent and
        # its child both being listed would count the child twice.
        picked = [d for d in decks if not any(d != o and _under(d, o) for o in decks)]
        names = [d for d in picked if d in counts]
        # Not one of the chosen decks exists. That is "we could not measure this",
        # NOT "nothing is due" — and the difference decides whether websites open. A
        # hand-typed deck name with a typo in it, or a deck since renamed or deleted,
        # would otherwise total 0 and satisfy the gate outright, which is the one
        # direction a mistake must never fail in. -1 makes the extension stand the
        # gate aside and say so instead.
        if not names:
            return -1
    else:
        names = tops

    total = 0
    for n in names:
        learn, review = counts.get(n, (0, 0))
        total += learn + review
    return total


def _rev_totals(since_ms, decks):
    """From the review log since `since_ms`: how many different cards, and how many
    review answers were right and wrong.

    `since_ms` is the extension's OWN day boundary. That is the point of doing this
    here rather than through a search: Anki's `rated:1` follows Anki's rollover hour,
    which is 04:00 by default while the extension's day starts at midnight — so
    between those two times a search would hand back last evening's cards as today's
    and pay for work already done.

    Pass and fail are counted over `type = 1` reviews only, which is what Anki's own
    "true retention" means. Answering Again on a card you are meeting for the FIRST
    time is what learning looks like, not a mistake, so learning and relearning steps
    must not drag the percentage down — a day of new cards would otherwise score
    around 50% and fail any sensible gate.
    """
    # Inside the try for the same reason as _due_totals: a getattr default does not
    # make attribute access on someone else's live object safe.
    try:
        rows = mw.col.db.all(
            # An allowlist of review types, not "!= manual": Anki has added kinds
            # over the years (manual, rescheduled) and a denylist silently counts
            # each new one as study. ease > 0 drops entries that record no answer.
            "select r.cid, r.ease, r.type, "
            "case when c.odid != 0 then c.odid else c.did end "
            "from revlog r join cards c on c.id = r.cid "
            "where r.id >= ? and r.ease > 0 and r.type in (0, 1, 2, 3)",
            int(since_ms))
    except Exception:
        return (0, 0, 0)

    names = {}
    cards = set()
    passed = 0
    again = 0
    for cid, ease, rtype, did in rows:
        if did not in names:
            names[did] = _deck_name(did)
        if not _wanted_deck(names[did], decks):
            continue
        cards.add(cid)
        if int(rtype) == 1:
            if int(ease) == 1:
                again += 1
            else:
                passed += 1
    return (len(cards), passed, again)


def _compute_goals():
    """Answer whatever the extension last asked for. GUI thread only.

    Never raises. Two reasons that matters beyond tidiness: this runs from a Qt
    timer slot, where an escaping exception can take Anki down with qFatal(); and
    `_goals` is what the HTTP thread is serving, so it must never be left holding
    numbers from one question stamped with a different question's signature.
    """
    global _goals, _due_cache
    req = _goal_req
    sig = _goal_signature(req)
    if not req or not sig:
        _goals = {"for": "", "due": -1, "cards": 0, "pass": 0, "again": 0, "at": 0}
        return
    try:
        if mw.col is None:
            return
    except Exception:
        return

    want = set(req.get("want") or [])
    decks = req.get("decks") or []
    # The due gate's own deck list, separate from the one that decides which reviews
    # count. See _goal_signature for why these are two lists and not one.
    duedecks = req.get("duedecks") or []
    due = -1
    if "due" in want:
        # Recomputed on its own slower beat, and reused in between — but only while
        # the question is the same one. Handing back a count measured for a different
        # set of decks would be worse than handing back nothing.
        cached_due, cached_sig = _due_cache
        if cached_sig == sig and (_goals_tick % GOALS_DUE_EVERY) != 0:
            due = cached_due
        else:
            due = _due_totals(duedecks)
            _due_cache = (due, sig)

    cards = passed = again = 0
    if "rev" in want:
        cards, passed, again = _rev_totals(req.get("since") or 0, decks)

    # Assigned once, at the end, so a failure part-way through cannot publish half an
    # answer. Both readers above already degrade to "could not measure" (-1, or zeros)
    # rather than throwing, so what lands here is always internally consistent.
    _goals = {"for": sig, "due": due, "cards": cards,
              "pass": passed, "again": again, "at": int(time.time() * 1000)}


def _read_goal_request(path):
    """Pull the question off the poll URL. HTTP thread — writes it down, nothing more.

    Read defensively and clamped, because this arrives off the network: the only
    caller is our own extension, but "the only caller" is an assumption and this is
    the one place a stranger's input reaches the collection. A junk `since` would
    make the review query scan the whole log; a thousand deck names would make every
    tick walk a thousand string comparisons.
    """
    global _goal_req
    try:
        q = parse_qs(urlparse(path or "").query, keep_blank_values=False)
        want = [w for w in (q.get("want", [""])[0] or "").split(",") if w in ("due", "rev")]
        if not want:
            _goal_req = None
            return
        try:
            since = int(q.get("since", ["0"])[0])
        except (TypeError, ValueError):
            since = 0
        # A negative or absurd stamp is not a day boundary. 0 disables the review
        # half rather than scanning from the beginning of time.
        now_ms = int(time.time() * 1000)
        if since < 0 or since > now_ms:
            since = 0
        if "rev" in want and not since:
            want = [w for w in want if w != "rev"]
        # The same two limits the extension applies before it builds its signature.
        # If the two sides trimmed differently the signatures would never match, the
        # gates would quietly stand aside, and nothing on either side would say so.
        def deck_list(key):
            out = []
            for d in (q.get(key, [""])[0] or "").split("\x1f"):
                d = d.strip()
                if d:
                    out.append(d[:GOAL_DECK_NAME_MAX])
                if len(out) >= GOAL_DECK_LIMIT:
                    break
            return out

        _goal_req = {"since": since, "decks": deck_list("decks"),
                     "duedecks": deck_list("duedecks"), "want": want} if want else None
    except Exception:
        _goal_req = None


# Set by the HTTP thread, acted on by the next timer tick. Raising a window has
# to happen on Anki's own GUI thread, and the tick already runs there twice a
# second — which is quick enough to feel like a click.
_raise_wanted = False
# When the last raise was granted, for the rate limit in do_POST. Taking the
# keyboard away from someone is not something to do twice in a second, however
# insistently it is asked for.
_last_raise_at = 0.0


def _raise_main_window():
    """Bring Anki's main window to the front, as if you'd clicked its taskbar
    button. Qt first (it works everywhere), then the Win32 calls, because Qt
    alone often only flashes the taskbar entry on Windows.

    ---- why this is more than SetForegroundWindow ----

    Windows does not let a background process take the foreground. `SetForegroundWindow` from a
    program you are not currently using returns TRUE and does nothing except flash the taskbar
    button — which is exactly the reported symptom: Anki MINIMISED came to the front reliably,
    Anki merely sitting behind Chrome blinked orange in the taskbar and stayed where it was.

    The two cases looked different for a reason that is easy to miss. `ShowWindow(SW_RESTORE)` on a
    minimised window is not a request for the foreground, it is a request to be un-minimised, and
    Windows grants that to anyone — restoring a window puts it on top as a side effect. A window
    that is already visible has nothing to restore, so that path did nothing and the only thing
    left was the call Windows refuses.

    So three things happen here, weakest-but-politest first, and each covers what the last one
    cannot:

      1. Qt's own show/raise/activate. Right on every platform, and enough on macOS and Linux.

      2. The Z-ORDER, via a momentary SetWindowPos to topmost and straight back. This is not
         subject to the foreground rules at all — it is about stacking, not about focus — so it is
         what actually lifts Anki out from behind Chrome. Set and unset in the same breath, because
         Anki is not an always-on-top program and leaving it there would be a bug that outlived
         the click. SWP_NOACTIVATE is deliberate: this step is only claiming the top of the pile.

      3. The FOREGROUND, via AttachThreadInput. Attaching our input queue to the current
         foreground window's thread makes Windows treat us as part of the active process for the
         moment, which is the documented way out of the restriction, and it is undone immediately.
         The extension helps from its end by minimising the Chrome window that asked — a
         foreground window that is being minimised releases the lock outright — so on the ordinary
         path this step is a formality and the attach is the belt behind it.

    Every step is wrapped on its own. A refused call must not stop the ones after it, and none of
    them is worth an error dialog in front of somebody who pressed a button in a browser.
    """
    try:
        win = mw
        if win is None:
            return
        try:
            if win.isMinimized():
                win.showNormal()
            else:
                win.show()
        except Exception:
            pass
        try:
            win.raise_()
            win.activateWindow()
        except Exception:
            pass
        api = _win32_api()
        if not api:
            return
        u, k, wintypes = api["u"], api["k"], api["wintypes"]
        try:
            hwnd = wintypes.HWND(int(win.winId()))
        except Exception:
            return
        SW_RESTORE = 9
        SWP_NOSIZE = 0x0001
        SWP_NOMOVE = 0x0002
        SWP_NOACTIVATE = 0x0010
        SWP_SHOWWINDOW = 0x0040
        Z_FLAGS = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW
        # 1. Un-minimise, if it was.
        try:
            if u.IsIconic(hwnd):
                u.ShowWindow(hwnd, SW_RESTORE)
        except Exception:
            pass
        # 2. To the top of the pile. The half that fixes "it is behind Chrome, not minimised".
        try:
            u.SetWindowPos(hwnd, wintypes.HWND(-1), 0, 0, 0, 0, Z_FLAGS)   # HWND_TOPMOST
            u.SetWindowPos(hwnd, wintypes.HWND(-2), 0, 0, 0, 0, Z_FLAGS)   # HWND_NOTOPMOST
        except Exception:
            pass
        try:
            u.BringWindowToTop(hwnd)
        except Exception:
            pass
        # 3. And the keyboard, borrowing the foreground thread's input queue if we have to.
        attached = False
        other = 0
        try:
            fg = u.GetForegroundWindow()
            mine = k.GetCurrentThreadId()
            if fg:
                other = u.GetWindowThreadProcessId(fg, None)
            # Attaching a thread to itself is an error, and a foreground window we already own
            # needs none of this.
            if other and other != mine:
                attached = bool(u.AttachThreadInput(other, mine, True))
        except Exception:
            attached = False
        try:
            u.SetForegroundWindow(hwnd)
        except Exception:
            pass
        if attached:
            try:
                u.AttachThreadInput(other, k.GetCurrentThreadId(), False)
            except Exception:
                pass
    except Exception:
        pass


# ---- the glow around Anki's window ----------------------------------------
#
# Green edge: the clock is running. Red edge: the camera can't see you, so it isn't.
# The point is that it's answerable from inside Anki, where you are actually looking —
# before this, the only way to know whether a minute counted was to leave Anki and go
# and look at the extension, which is precisely the thing the extension is trying to
# stop you doing.
#
# The colour is not decided here. Whether time is counting depends on the face check,
# the deck rules, the idle rules and the spam rules, and all of those live in the
# extension — so it says which colour, and this draws it. See _read_glow_request.
#
# Amber edge: the clock IS running, but your head is outside the pace feature's focus box, so
# it is being credited at the slower of your two speeds. A third colour rather than reusing red,
# because red means "nothing is counting" and that would stop being true — and once a warning
# light means two things it means neither. All three draw the same way, as a still boundary: green
# used to sweep instead and no longer does, see the note above SWEEP_SEC. See _read_glow_request and
# glowColour in the extension, which is where all three are decided.
GLOW_COLOURS = {
    "green": (34, 197, 94),
    "red": (239, 68, 68),
    # #f59e0b — the same amber the focus box and the multiplier badge use in the camera window.
    # One colour for one meaning, in all three places you might be looking.
    "amber": (245, 158, 11),
}
# How far the light reaches in from the edge, how bright it is where it meets the edge, and how
# sharply it falls off. These three are the whole look — THICKNESS up for a deeper haze, ALPHA down
# for a fainter one, POWER up for a softer inner edge.
#
# A soft, deep gradient, and that is the right look rather than a compromise. It was briefly changed
# to a 3px hard line, on the reasoning that the eye finds a hard edge faster and a thin line covers
# nothing. Both of those are true and neither was the point: what the haze gives you is something you
# register WITHOUT looking at it, at the very edge of your vision, while your attention is on the card.
# A hairline needs to be looked at to be seen, which makes it a label rather than an ambient signal.
#
# The falloff curve is what makes it read as light rather than as a translucent frame — see
# _glow_falloff, which explains why it is a curve and not a ramp.
GLOW_THICKNESS = 80
GLOW_PEAK_ALPHA = 95
GLOW_FALLOFF_POWER = 2.6
# The corner the strokes follow. It can afford to be approximate, because a haze hides any mismatch
# with the window's own corner radius; a hard line could not, which is the one thing the 3px version
# got right about it.
GLOW_CORNER = 12
# A small window must not end up as nothing but glow, so the depth is capped at a fifth
# of its shorter side. Anki at 400px tall would otherwise be 80px of haze top and
# bottom with a sliver of card between them.
GLOW_MAX_SHARE = 5
# The two states say different kinds of thing, so they are drawn differently.
#
# Red is a condition: something is wrong and nothing is being counted. It sits still at
# the boundary and stays until that's fixed.
#
# Green USED to be treated as an event — not a border at all, but a band of light sweeping once
# across the whole window. The reasoning was that movement reads as "something happened just now"
# in a way a static colour cannot. It was wrong in practice for a reason the reasoning missed:
# the thing it sweeps across is the card you are reading, several times a minute, and a flourish
# you have to sit through repeatedly is not information any more. Green is a still GLOW now — the
# same soft deep edge red and amber have always had, in green — and the only thing that tells the
# three states apart is the colour, which is all a signal at the edge of your vision can carry.
#
# What follows is still used, for the ONE case that really is an event: the cheer on the day's
# first finish, which happens once.
SWEEP_SEC = 0.8
# How wide the band is, as a share of the window. Wide enough to be a sweep of light
# rather than a line crossing the screen.
SWEEP_BAND_SHARE = 0.45
# Kept low on purpose: this passes over the deck list and over cards, so it has to read
# as a sheen on the glass and not as a green filter.
SWEEP_PEAK_ALPHA = 70
# How far the band leans over. 0 is a vertical bar; this is a comfortable diagonal.
SWEEP_SLANT = 0.55
# 50 frames a second. Higher than it needs to look continuous, because the sweep now
# crosses in half a second: at 30fps that would be fifteen frames, and a fast movement
# in fifteen steps is visibly a series of positions rather than a movement.
ANIM_STEP_MS = 20

# ---- the finish ------------------------------------------------------------
# Done for the day, said properly: a burst of confetti across Anki's own window and one line
# of type. Once a day, when the last gate closes.
#
# Deliberately short. A celebration you have to wait out is a nag, so the whole thing is over
# in about three seconds and it never takes the keyboard — the frame is transparent to input,
# so you can carry on answering cards straight through it.
CHEER_SEC = 3.2
CHEER_PIECES = 90
CHEER_TEXT = "Done for today"
# Anki's own blues and greens, plus warm accents, so it reads as part of the app.
CHEER_COLOURS = ((34, 197, 94), (56, 189, 248), (250, 204, 21), (244, 114, 182),
                 (167, 139, 250), (248, 113, 113))
# Gravity and drag, in fractions of the window per second. Tuned by eye: the pieces should
# rise, hang, and fall out of the bottom rather than dropping like stones.
CHEER_GRAVITY = 1.55
CHEER_DRAG = 0.72
# How long a colour is trusted without hearing again. Generous on purpose: the
# extension states the colour on every poll (about every 3s), but its service worker
# can be evicted and fall back to a 30s alarm, and blinking red off in the gap would
# be worse than holding it — red means "nothing is counting", which is still true of
# an extension that has stopped talking.
GLOW_STALE_SEC = 45.0


# ---- one colour becoming another -------------------------------------------
#
# How long a colour takes to dissolve into the next one, and how long a ring takes to fade away
# when there is nothing to replace it with.
#
# Both exist because the change of colour used to be a single repaint. `set_state` swapped the
# pixmap and called update(), so red became green — or red vanished and the green sweep began — in
# one frame. On a signal you are meant to read out of the corner of your eye while looking at a
# card, a one-frame change is the one thing the eye does not catch: you notice that the edge is
# different now and have to work out when it changed and from what.
#
# 0.28s is FocusGate's figure for the same transition and holds up here for the same reasons. A
# colour arriving from nothing can afford to be leisurely, because the arrival is itself the
# message; a colour REPLACING another is answering a question you have already asked — you sat back
# down and are waiting to be told the clock noticed — and an answer that takes most of a second
# reads as the program being slow. Below about 0.2s a dissolve stops reading as one thing becoming
# another and starts reading as a flicker, so this is not shortened further.
#
# 0.22 rather than 0.28, asked for and reasonable: the change is red leaving as green arrives, and it
# should feel like an answer rather than an animation. It now sits just above that 0.2s floor — eleven
# frames at 50fps, which is still enough for the eye to read it as one colour becoming another — so
# this is as short as it goes without turning into the flicker the note above describes.
GLOW_CROSS_SEC = 0.22
# Fading out with nothing coming in is the end of something rather than a correction, so it is
# allowed to be slower. This is the path taken when the goal is met or the extension is switched
# off — the ring has finished its job and leaving abruptly would look like a fault.
GLOW_OUT_SEC = 0.42
# 50 frames a second, as everything else animated here runs at.
GLOW_FADE_STEP_MS = ANIM_STEP_MS


def _smoothstep(x):
    """0 → 1 with both ends eased. A straight ramp starts and stops abruptly and the eye
    catches both corners; this one has no corners to catch."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    return x * x * (3.0 - 2.0 * x)


def _ease_out(x):
    """Quick off the mark, slow to arrive. CSS calls this ease-out."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    return 1.0 - (1.0 - x) * (1.0 - x)


def _ease_in(x):
    """Slow off the mark, quick to arrive. CSS calls this ease-in."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    return x * x


def _cross_alphas(progress):
    """How opaque the outgoing and the incoming colour are, `progress` of the way through.

    The asymmetry is the whole of why this reads as one colour becoming another rather than as the
    two being mixed, and it is worth spelling out because the obvious version is wrong.

    Two straight ramps cross at half and half. Half-strength red over half-strength green is not a
    halfway house between them, it is a third colour — a dark olive — so a red edge on its way to
    green would spend the middle of the change looking like dirt. That is exactly the problem a
    single interpolated colour has, reproduced by compositing.

    So the one leaving eases OUT (mostly gone by the midpoint) and the one arriving eases IN
    (barely started by the midpoint). They cross at about a quarter each: the frame dips towards
    dark in the middle and comes up the other side in the new colour. Nothing on screen is ever
    both colours at strength.
    """
    return (1.0 - _ease_out(progress)), _ease_in(progress)


def _sweep_strength(progress):
    """How bright the band is, `progress` of the way across (0 → 1).

    Full for the middle of the crossing, easing up as it enters and down as it leaves,
    so it neither springs into existence at one edge nor vanishes at the other.
    """
    if progress <= 0.18:
        return _smoothstep(progress / 0.18)
    if progress >= 0.82:
        return _smoothstep((1.0 - progress) / 0.18)
    return 1.0


# Qt.AlignmentFlag in PyQt6, flat on Qt in PyQt5 — same story as the window flags. Resolved
# once, and combined here rather than at every drawText.
_AF = _enum_home(Qt, "AlignmentFlag", "AlignHCenter")
_ALIGN_TOP_CENTER = _AF.AlignHCenter | _AF.AlignTop


def _cheer_pieces():
    """One burst of confetti, as fixed facts: where each piece starts, where it's heading, how
    big it is and how fast it tumbles.

    Two launch points, from the bottom corners, aimed inwards and up — the shape a pair of
    party cannons makes, which reads as celebration far better than pieces raining from the
    top of the window.

    Everything is a fraction of the window rather than pixels, so the same burst looks right
    whether Anki is a small window or filling a 4K screen.
    """
    pieces = []
    for i in range(CHEER_PIECES):
        left = i % 2 == 0
        x0 = (0.04 if left else 0.96) + random.uniform(-0.02, 0.02)
        # Strictly below the bottom edge, and staggered so they don't all arrive at once.
        # Jittering either side of the edge let some pieces start just inside it, which reads
        # as appearing from nowhere rather than being fired in.
        y0 = 1.03 + random.uniform(0.0, 0.06)
        # Fanned between 25° and 80° above the horizontal, aimed across the window.
        angle = math.radians(random.uniform(25, 80))
        speed = random.uniform(1.5, 2.9)
        vx = math.cos(angle) * speed * (1 if left else -1)
        vy = -math.sin(angle) * speed
        pieces.append((
            x0, y0, vx, vy,
            random.uniform(0.004, 0.009),        # size, as a fraction of the width
            random.uniform(6.0, 16.0),           # spin, radians a second
            random.uniform(0, math.tau),         # so they don't all turn in step
            random.choice(CHEER_COLOURS),
        ))
    return pieces


_falloff_cache = {}


def _glow_falloff(thickness):
    """The glow, as a stack of one-pixel-apart strokes: brightest against the edge,
    fading to nothing `thickness` pixels inward.

    Not a QLinearGradient, because the shape is a rounded-rectangle ring — a linear
    gradient would need one for each side plus a radial one for each corner, and they
    would not agree with each other where they met. Stepping the alpha down along
    concentric rounded rects gives the same result and follows the corners for free.

    A curve rather than a straight ramp. Light doesn't fall off linearly, and a linear
    ramp reads as a flat translucent band with a visible inner edge — which is the
    hard-stroke look this replaced.

    Cached: the same handful of thicknesses come round again and again, and this is
    called while building a pixmap that is itself cached.
    """
    steps = _falloff_cache.get(thickness)
    if steps is None:
        out = []
        for i in range(max(1, thickness)):
            t = i / float(max(1, thickness))
            alpha = int(round(GLOW_PEAK_ALPHA * (1.0 - t) ** GLOW_FALLOFF_POWER))
            if alpha > 0:
                out.append((i, alpha))
        steps = tuple(out)
        _falloff_cache[thickness] = steps
    return steps


class _GlowFrame(QWidget):
    """A ring of colour hugging Anki's window frame, and nothing else.

    A child *window* of mw rather than a widget placed inside it. Anki's centre is a
    QWebEngineView, which owns a native surface and paints over ordinary sibling
    widgets — an in-window overlay is not reliably visible on top of it. A Qt::Tool
    window owned by mw is, and being owned is also what keeps it in its place: the
    window manager holds it directly above its owner, so it follows Anki up and down
    the z-order instead of floating above every other application the way a
    WindowStaysOnTop frame would.

    Transparent to input in three ways, because a frame drawn over Anki's title bar
    that could be clicked would make the title bar unusable.
    """

    def __init__(self, parent):
        super().__init__(
            parent,
            _WT.FramelessWindowHint
            | _WT.Tool
            | _WT.WindowTransparentForInput
            | _WT.WindowDoesNotAcceptFocus,
        )
        self.setAttribute(_WA.WA_TranslucentBackground, True)
        self.setAttribute(_WA.WA_TransparentForMouseEvents, True)
        # Or showing the frame would take the keyboard away from the card you're
        # answering, twice a second.
        self.setAttribute(_WA.WA_ShowWithoutActivating, True)
        self._rgb = GLOW_COLOURS["red"]
        # "ring" is the still border, "sweep" is the band of light crossing the window.
        self._mode = "ring"
        self._anim_timer = None
        self._anim_t = 0.0
        self._cheer = ()
        # The glow, drawn once and kept. A small cache keyed by size and colour, because a
        # cross-fade needs TWO of them at once — the colour going and the colour coming.
        # It held exactly one before, which is why it was a single pixmap and a single key.
        self._pix_cache = {}
        # ---- the colour on its way out ----
        # The ring that is being replaced, while it is being replaced: the rgb it is painted in,
        # how far through the dissolve we are, and how long that dissolve is. None when nothing is
        # leaving, which is almost always.
        #
        # A timer of its own rather than the sweep's. _glow_apply asks `_glow.sweeping()` to find
        # out whether the green sweep has finished, and sharing one timer would have a dissolve
        # answer that question — so returning to Anki would end the sweep early, or a dissolve
        # would be mistaken for one and the green would never be marked done.
        self._fade_rgb = None
        self._fade_t = 0.0
        self._fade_len = GLOW_CROSS_SEC
        self._fade_timer = None
        # True while the fade is the last thing this frame has to do, so it hides itself at the end
        # instead of settling into a colour. See fade_out_and_hide.
        self._fade_hides = False
        # Which curve the INCOMING colour rides in on. "cross" is the steeper ease-in used when a
        # colour is replacing another, so the two never both sit at half strength; "arrive" is the
        # gentler symmetric one used when a ring is appearing out of nothing, where there is nothing
        # to avoid blending with and the arrival is itself the message.
        self._fade_curve = "cross"

    def set_state(self, name, mode):
        rgb = GLOW_COLOURS.get(name)
        # A colour is wanted again while the ring was on its way out — the goal was met and then the
        # bar was raised, the extension was switched off and back on, a poll landed in the quarter
        # second after the last one said "nothing". The fade has to be called off outright rather
        # than merely redirected, because its whole purpose was to end with hide(): left running, it
        # would take the new colour off the screen a moment after putting it there.
        #
        # Before the colour comparison below, so a return to the SAME colour is caught too. That is
        # the commoner of the two, and comparing first would have found nothing changed and left the
        # hide standing.
        if self._fade_hides:
            self.cancel_fade()
            if self._mode == "out":
                self._mode = "ring"
        changed = False
        if rgb is not None and rgb != self._rgb:
            # The colour it HAD goes on being painted for a moment, fading, while the new one comes
            # up through it. Only when there was something to see: a frame that is hidden has no
            # colour on screen to dissolve out of, and crossing from one nobody saw would show up as
            # a delay before anything appeared.
            if self.isVisible() and self._mode in ("ring", "sweep"):
                self._start_fade(self._rgb, GLOW_CROSS_SEC, False)
            self._rgb = rgb
            changed = True
        if mode != self._mode:
            self._mode = mode
            changed = True
        if changed:
            self.update()

    # ---- the dissolve ----
    def _start_fade(self, rgb, length, hides, curve="cross"):
        """Run a transition for `length` seconds.

        `rgb` is the colour on its way OUT, painted underneath whatever comes next — or None for a
        transition with nothing leaving, which is a ring simply appearing. Either way the current
        colour is what comes UP through it, on the `curve` given.
        """
        self._fade_rgb = rgb
        self._fade_t = 0.0
        self._fade_len = max(0.05, float(length))
        self._fade_hides = bool(hides)
        self._fade_curve = curve
        if self._fade_timer is None:
            timer = QTimer(self)
            timer.setInterval(GLOW_FADE_STEP_MS)
            timer.timeout.connect(self._on_fade)
            self._fade_timer = timer
            timer.start()

    def _on_fade(self):
        # A Qt slot, so nothing may escape it. Same reasoning as _on_sweep.
        try:
            self._fade_t += GLOW_FADE_STEP_MS / 1000.0
            if self._fade_t >= self._fade_len:
                hides = self._fade_hides
                self.cancel_fade()
                if hides:
                    self.hide()
                    return
                self.update()
                return
            self.update()
        except Exception:
            pass

    def cancel_fade(self):
        timer, self._fade_timer = self._fade_timer, None
        if timer is not None:
            try:
                timer.stop()
            except Exception:
                pass
        self._fade_rgb = None
        self._fade_t = 0.0
        self._fade_hides = False
        self._fade_curve = "cross"

    def fading(self):
        return self._fade_timer is not None

    def fade_in(self):
        """A ring coming up out of nothing, rather than being switched on.

        For the first appearance of a colour and for every one after a green sweep has taken the
        frame away — green hides the frame when its sweep ends, so the red that follows it is always
        arriving from nothing and would otherwise be the one transition in the set that snapped.

        Only when there is nothing already in hand: a cross-dissolve started by set_state is the
        better answer to the same moment and must not be overwritten by this.
        """
        if self.isVisible() or self.fading():
            return
        self._start_fade(None, GLOW_CROSS_SEC, False, "arrive")

    def fade_out_and_hide(self):
        """Take the ring away gently, rather than in one frame.

        For the two ways a glow ends with nothing replacing it: today's goal is met, or the whole
        thing was switched off. Both are the end of something, and a ring that simply stops being
        there on one frame reads as the add-on having crashed rather than as the work being done.

        Idempotent, because the caller is a tick that runs twice a second: a fade already on its way
        out must not be restarted from full every 500ms, which would be a ring that never leaves.
        """
        if not self.isVisible():
            return False
        if self._fade_hides and self.fading():
            return True                     # already going
        self.cancel_sweep()
        self._mode = "out"
        self._start_fade(self._rgb, GLOW_OUT_SEC, True, "leave")
        self.update()
        return True

    # ---- the sweep ----
    def start_sweep(self):
        """Send the band of light across the window, once, then hide.

        Starts before the first frame is drawn, so the band is still off the left edge
        when the window appears — nothing pops into view at full brightness. Harmless to
        call again while one is running.
        """
        if self._anim_timer is not None:
            return
        self._anim_t = 0.0
        timer = QTimer(self)
        timer.setInterval(ANIM_STEP_MS)
        timer.timeout.connect(self._on_sweep)
        self._anim_timer = timer
        timer.start()

    def cancel_sweep(self):
        timer, self._anim_timer = self._anim_timer, None
        if timer is not None:
            try:
                timer.stop()
            except Exception:
                pass
        self._anim_t = 0.0

    def sweeping(self):
        return self._anim_timer is not None

    def mode(self):
        return self._mode

    # ---- the celebration ----
    def start_cheer(self):
        """Throw the confetti. Same timer as the sweep; the mode decides what gets painted."""
        if self._anim_timer is not None:
            return
        self._anim_t = 0.0
        self._cheer = _cheer_pieces()
        timer = QTimer(self)
        timer.setInterval(ANIM_STEP_MS)
        timer.timeout.connect(self._on_cheer)
        self._anim_timer = timer
        timer.start()

    def _on_cheer(self):
        # A Qt slot, so nothing may escape it. See _on_timer.
        try:
            self._anim_t += ANIM_STEP_MS / 1000.0
            if self._anim_t >= CHEER_SEC:
                self.cancel_sweep()
                self.hide()
                return
            self.update()
        except Exception:
            pass

    def _draw_cheer(self, p):
        """Confetti, and one line of type.

        Each piece is given its heading and spin once, at the start, and its position is worked
        out from the elapsed time — so there is no per-frame state to drift, and a dropped frame
        costs a gap in the motion rather than sending a piece off course.
        """
        rect = self.rect()
        w, h = rect.width(), rect.height()
        if w <= 0 or h <= 0:
            return
        t = self._anim_t
        life = t / CHEER_SEC

        # The words first, so the confetti passes in front of them.
        fade = _smoothstep(min(1.0, t / 0.35)) * (1.0 - _smoothstep(max(0.0, (life - 0.55) / 0.45)))
        if fade > 0.01:
            font = QFont(p.font())
            font.setPointSizeF(max(13.0, min(40.0, h * 0.055)))
            font.setBold(True)
            p.setFont(font)
            # Rises a little as it fades, which is what makes it a flourish rather than a label
            # being switched on and off.
            top = int(h * 0.40 - 18 * _smoothstep(life))
            band = rect.adjusted(0, top, 0, 0)
            # Drawn twice: a dark copy one pixel down, so it stays legible over a white card
            # as well as a dark one.
            p.setPen(QPen(QColor(9, 14, 26, int(160 * fade))))
            p.drawText(band.adjusted(0, 2, 0, 2), _ALIGN_TOP_CENTER, CHEER_TEXT)
            p.setPen(QPen(QColor(255, 255, 255, int(240 * fade))))
            p.drawText(band, _ALIGN_TOP_CENTER, CHEER_TEXT)

        p.setPen(QPen(QColor(0, 0, 0, 0)))
        for x0, y0, vx, vy, size, spin, phase, colour in self._cheer:
            # Drag on the way out, gravity all the way down.
            travel = (1.0 - math.exp(-CHEER_DRAG * t)) / CHEER_DRAG
            x = x0 + vx * travel
            y = y0 + vy * travel + 0.5 * CHEER_GRAVITY * t * t
            if y > 1.25 or x < -0.2 or x > 1.2:
                continue
            alpha = int(235 * (1.0 - _smoothstep(max(0.0, (life - 0.62) / 0.38))))
            if alpha <= 0:
                continue
            r, g, b = colour
            p.setBrush(QBrush(QColor(r, g, b, alpha)))
            # Spinning, and squashed as it turns edge-on. A flat rectangle tumbling is what
            # makes paper read as paper rather than as dots moving.
            half_w = max(1.0, size * w * 0.5 * abs(math.sin(spin * t + phase)))
            half_h = max(1.0, size * w * 0.85)
            p.drawRoundedRect(int(x * w - half_w), int(y * h - half_h),
                              int(half_w * 2), int(half_h * 2), 2, 2)
        p.setBrush(QBrush(QColor(0, 0, 0, 0)))

    def _on_sweep(self):
        # A Qt slot, so nothing may escape it. See _on_timer.
        try:
            self._anim_t += ANIM_STEP_MS / 1000.0
            if self._anim_t >= SWEEP_SEC:
                self.cancel_sweep()
                self.hide()
                return
            self.update()
        except Exception:
            pass

    def _draw_sweep(self, p):
        """One slanted band of light, positioned by how far through the sweep we are.

        A QLinearGradient is exactly right here, unlike for the ring: the band is
        straight, so one axis describes the whole thing. The axis runs across the band
        and is only as long as the band is wide — everything beyond either end takes the
        nearest stop, which is transparent, so the rest of the window is untouched.
        """
        rect = self.rect()
        w, h = rect.width(), rect.height()
        if w <= 0 or h <= 0:
            return
        band = max(40.0, w * SWEEP_BAND_SHARE)
        # Starts wholly off the left edge and finishes wholly off the right one, so the
        # band is never cut in half at a boundary.
        lead = -band + (w + 2 * band) * (self._anim_t / SWEEP_SEC)
        slant = h * SWEEP_SLANT
        grad = QLinearGradient(lead, 0.0, lead + band + slant, float(h))
        r, g, b = self._rgb
        peak = int(round(SWEEP_PEAK_ALPHA * _sweep_strength(self._anim_t / SWEEP_SEC)))
        # Soft on both sides of a bright core: a shine, not a stripe.
        for stop, share in ((0.0, 0.0), (0.28, 0.22), (0.5, 1.0), (0.72, 0.22), (1.0, 0.0)):
            grad.setColorAt(stop, QColor(r, g, b, int(round(peak * share))))
        p.fillRect(rect, QBrush(grad))

    def _draw_glow(self, p, rgb=None):
        """The rings themselves, into whatever `p` is painting.

        `rgb` so a cross-fade can ask for the colour that is LEAVING as well as the one arriving.
        Defaults to the current colour, which is every caller that is not the fade.
        """
        p.setRenderHint(_RH.Antialiasing, True)
        r, g, b = rgb if rgb is not None else self._rgb
        base = self.rect()
        # Deep, but never more than a fifth of the shorter side.
        thickness = min(GLOW_THICKNESS,
                        max(6, min(base.width(), base.height()) // GLOW_MAX_SHARE))
        for offset, alpha in _glow_falloff(thickness):
            box = base.adjusted(offset, offset, -offset, -offset)
            # A window narrower than twice the glow: stop rather than draw inside-out
            # rectangles.
            if box.width() <= 0 or box.height() <= 0:
                break
            pen = QPen(QColor(r, g, b, alpha))
            # Two pixels wide on a one-pixel step, so consecutive strokes overlap.
            # Butted-up 1px strokes leave hairline seams where antialiasing splits them
            # across pixel boundaries, and seams in a gradient are what you notice.
            pen.setWidth(2)
            p.setPen(pen)
            # The corner radius shrinks with the inset, so every ring stays concentric.
            radius = max(0, GLOW_CORNER - offset)
            p.drawRoundedRect(box, radius, radius)

    def _glow_pixmap(self, rgb=None):
        """The ring, rendered once per size and colour.

        Eighty antialiased rounded-rect strokes across a window this size cost real
        milliseconds. Red doesn't animate, so this is mostly about a window being dragged
        or resized — but it also means a repaint provoked by anything else is a blit.

        A cache of a few rather than of one, because a dissolve blits two colours per frame at 50
        frames a second: with a single slot the two would evict each other every frame and the
        whole ring would be redrawn from scratch twice, fourteen milliseconds of stroking per
        frame, for the quarter-second the dissolve lasts. Three colours and a handful of sizes is
        the whole population, and the cache is cleared whenever it could grow past that.
        """
        want = rgb if rgb is not None else self._rgb
        key = (self.width(), self.height(), want)
        got = self._pix_cache.get(key)
        if got is not None:
            return got
        # A resize invalidates every entry at once, so rather than carry stale sizes around the
        # cache is emptied the moment it would grow past the few live keys. GLOW_COLOURS has three
        # entries, and a dissolve needs two of them at one size.
        if len(self._pix_cache) >= 6:
            self._pix_cache.clear()
        pix = None
        try:
            # Built at device resolution and told its own ratio, or it comes out soft
            # (and mispositioned) on a scaled display.
            dpr = 1.0
            try:
                dpr = float(self.devicePixelRatioF())
            except Exception:
                pass
            if not (dpr > 0):
                dpr = 1.0
            pix = QPixmap(max(1, int(self.width() * dpr)), max(1, int(self.height() * dpr)))
            try:
                pix.setDevicePixelRatio(dpr)
            except Exception:
                pass
            pix.fill(QColor(0, 0, 0, 0))
            p = QPainter(pix)
            try:
                self._draw_glow(p, want)
            finally:
                p.end()
        except Exception:
            pix = None
        if pix is not None:
            self._pix_cache[key] = pix
        return pix

    def paintEvent(self, _event):
        # A raising paintEvent is a raising Qt slot, and an exception out of a PyQt
        # slot can end the process. Same reasoning as _on_timer.
        try:
            # How far through a dissolve we are, and therefore how strongly each of the two colours
            # is painted. (1, 0) — full outgoing, nothing incoming — when nothing is dissolving, in
            # which case only one of the two branches below ever runs.
            fading = self._fade_timer is not None
            out_a, in_a = 1.0, 1.0
            if fading:
                x = min(1.0, self._fade_t / self._fade_len)
                if self._fade_curve == "arrive":
                    # Nothing leaving, so there is no blend to route around and the symmetric curve
                    # is the right one: eased at both ends, no corner for the eye to catch.
                    out_a, in_a = 0.0, _smoothstep(x)
                elif self._fade_curve == "leave":
                    # Nothing arriving either. Same curve, run backwards.
                    out_a, in_a = (1.0 - _smoothstep(x)), 0.0
                else:
                    out_a, in_a = _cross_alphas(x)
            p = QPainter(self)
            try:
                p.setRenderHint(_RH.Antialiasing, True)
                # The colour that is leaving goes down FIRST, so whatever replaces it paints over
                # the top. Both are translucent for the middle of the change, which is the point:
                # see _cross_alphas for why the two curves are not the same curve.
                if fading and self._fade_rgb is not None and out_a > 0.004:
                    old = self._glow_pixmap(self._fade_rgb)
                    if old is not None:
                        p.setOpacity(out_a)
                        p.drawPixmap(0, 0, old)
                        p.setOpacity(1.0)
                # And then whatever this frame is now. "out" is the fade-out mode: the ring above is
                # the whole of it, so there is nothing to draw on top.
                if self._mode == "cheer":
                    self._draw_cheer(p)
                elif self._mode == "sweep":
                    # The sweep carries its own easing in and out (see _sweep_strength), so it is
                    # not dimmed further by the cross — it would be eased twice and arrive faint.
                    self._draw_sweep(p)
                elif self._mode != "out":
                    pix = self._glow_pixmap()
                    if pix is not None:
                        if in_a < 0.996:
                            p.setOpacity(in_a)
                        p.drawPixmap(0, 0, pix)
                        p.setOpacity(1.0)
            finally:
                p.end()
        except Exception:
            pass


_glow = None            # the frame, made the first time it's needed
_glow_want = "off"      # written by the HTTP thread, read on Anki's GUI thread
_glow_at = 0.0          # when that word arrived, for GLOW_STALE_SEC
_glow_rect = None       # last geometry pushed, so we only move it when it moved
_glow_want_fg = True    # was Anki in front when that colour was worked out?
# Set by a POST, spent by the next tick. One shot: the extension only sends it on the day's
# first finish, and the tick clears it whether or not it could be shown.
_cheer_wanted = False
# The green sweep. The frame runs the animation itself, so all that's kept here is
# whether one is under way and whether this green has already had its turn — the timing
# deliberately does NOT start when the extension asks, because that word can be up to a
# poll old and the sweep would be half over before it was ever drawn.
_green_sweeping = False
_green_done = False
# Whether you were in Anki last tick, so arriving can be told apart from being here.
_glow_in_anki = False


def _read_glow_request(path):
    """`POST /glow?state=green|amber|red|off`, from the extension, on the HTTP thread.

    In the query string rather than the body because _drain_body() throws bodies away
    on purpose — see it for the request-smuggling reason — and because there is
    nothing here worth hiding: it is one word naming a colour.

    Same handoff as _raise_wanted: write a module flag, let the next tick act on it,
    because touching Qt from this thread is not allowed.
    """
    global _glow_want, _glow_at, _glow_want_fg, _green_sweeping, _green_done
    try:
        qs = parse_qs(urlparse(path or "").query or "")
        want = (qs.get("state", [""])[0] or "").strip().lower()
        # Whether Anki had the foreground in the reading this colour came from. Absent from
        # an older extension, which is read as "don't know" and trusted — that build only
        # ever pushed on its slow poll, so there was no race to guard against.
        fg = (qs.get("fg", ["1"])[0] or "1").strip()
    except Exception:
        return False
    if want not in ("off", "green", "red", "amber", "cheer"):
        return False
    _glow_want_fg = fg != "0"
    if want == "cheer":
        # Not a colour but a moment, so it doesn't go through _glow_want at all: that value is
        # a standing state which the extension restates every poll, and a celebration restated
        # every three seconds would never stop. Armed once here, spent once by the next tick.
        global _cheer_wanted
        _cheer_wanted = True
        _glow_at = time.time()
        _draw_glow_now()
        return True
    changed = want != _glow_want
    if changed:
        # A different answer, so green has earned a fresh sweep. Repeats of the same word
        # — the extension states it on every poll — deliberately do not reset this, or
        # the light would cross the window again every three seconds forever.
        _green_sweeping = False
        _green_done = False
    _glow_want = want
    _glow_at = time.time()
    if changed:
        _draw_glow_now()
    return True


def _draw_glow_now():
    """Redraw immediately instead of on the next tick.

    The tick runs twice a second, so waiting for it added up to half a second to
    something whose whole purpose is to be instant — the edge should light as the camera
    loses you, not a beat later. Qt cannot be touched from this thread, so this goes
    through Anki's own task manager, the same route the port-bind warning uses.

    Only on a change of colour, so the once-per-poll repeats don't queue work.
    """
    try:
        from aqt import mw as _mw
        if _mw is None:
            return
        _mw.taskman.run_on_main(_glow_apply_guarded)
    except Exception:
        pass


def _glow_apply_guarded():
    try:
        _glow_apply()
    except Exception:
        pass


def _in_anki_now(win):
    """Are you working in Anki this instant?

    Asked of Windows here and now rather than read out of the last sample. The sample can
    be half a second old, and half a second is most of the delay this path is trying to
    remove — the difference between the sweep starting as you arrive and starting after
    you've already begun reading. Two Win32 calls once the handle is cached.

    "cam" is AnkiGate's own camera window and counts, exactly as it does for the clock
    itself. "unknown" is a non-Windows build, where there is nothing to go on but the last
    sample.
    """
    try:
        if win is not None and win.isMinimized():
            return False
    except Exception:
        pass
    kind = _foreground_kind()
    if kind == "unknown":
        return bool(_state.get("focused"))
    return kind in ("anki", "cam")


# ---- telling the extension the instant you leave Anki ----------------------
# Chrome cannot see this. It is told the moment you switch TO Anki, because Chrome loses
# focus — but switching from Anki to Notepad changes nothing about Chrome, so no event of
# any kind reaches the extension. It used to find out by asking, and asking has a floor:
# ask five times a second and you are still a fifth of a second late, and you have spent
# five requests a second to be late.
#
# So the extension asks ONCE and this side holds the answer back until there is something
# to say. /wait blocks here, on this connection's own thread, checking a Win32 call that
# costs microseconds — so the latency is one step of the loop below plus a localhost round
# trip, and a quiet hour costs a couple of requests rather than eighteen thousand.
#
# The longest one request may hold its thread. A client that has gone away without saying
# so is noticed when this expires; the extension simply asks again.
WAIT_MAX_SEC = 25.0
# The whole latency budget. GetForegroundWindow costs microseconds, so this is not about
# saving work — it is that nothing a person does to a window happens faster than this.
WAIT_STEP_SEC = 0.01


def _minimized_now(s, kind):
    """Is Anki minimised, as far as this instant can tell?

    Windows cannot give the foreground to a minimised window, so ANKI'S OWN window being in
    front settles it: not minimised, whatever the tick last wrote down. Otherwise the stored
    flag stands.

    That mattered for one case: restoring Anki from the taskbar changes the foreground
    immediately, but the stored flag still said minimised, and `focused` is "Anki is in front
    AND not minimised" — so bringing Anki back up was not believed until the next sample. It
    was the one place where the wait loop's ten milliseconds were thrown away by half a second.

    "cam" deliberately does not count. The camera window owning the foreground says nothing
    about Anki, which may well be the thing you just minimised — and the extension allows the
    camera window to inherit Anki's foreground for a few seconds, so claiming Anki was up
    would hand out credit for sitting in front of a minimised Anki.
    """
    if kind == "anki":
        return False
    return bool(s.get("minimized"))


def _fg_token():
    """An opaque stamp of everything the extension's foreground decision depends on.

    The extension never parses this. It echoes back whatever it was last given and asks
    /wait to hold on until it differs, which is the point: only one side has an opinion
    about what counts as a change, so the two cannot drift apart over it. Adding something
    to this tuple is all it takes to make the extension notice a new kind of change.

    `ts` is deliberately absent. It moves every tick, so including it would make every
    wait return immediately and turn the whole thing back into polling.
    """
    s = _state
    kind = _foreground_kind()
    if kind == "unknown":
        # No Win32 to tell us apart, so the sample's own flag is the most that can be said.
        kind = "u" + ("1" if s.get("focused") else "0")
    # Worked out exactly as _live_state does it, and it has to be: this is the value the
    # extension waits on and that is the value it then acts on. Two different answers here
    # would mean either a change that never wakes the wait, or a wait that wakes for nothing.
    return "%s|%d|%d|%d|%.3f" % (
        kind,
        1 if _minimized_now(s, kind) else 0,
        1 if s.get("fullscreen") else 0,
        1 if s.get("maximized") else 0,
        float(s.get("coverage") or 0.0),
    )


def _live_state():
    """The status blob, with the foreground read at the moment of asking.

    _state is refreshed by the 500ms tick, which was fine while the extension only asked
    every three seconds — but it now asks the instant Chrome loses focus, which is the
    instant you switch to Anki. Served from the sample, that request gets an answer from
    before the switch: the extension concludes you are still in the browser, and the sweep
    waits for a poll that hasn't happened yet.

    Safe on this thread precisely because it is the one thing here that needs no Qt:
    GetForegroundWindow and GetWindowThreadProcessId are Win32 calls, and `minimized` is
    left as the tick last saw it.
    """
    blob = dict(_state)
    kind = _foreground_kind()
    if kind != "unknown":
        blob["focus_kind"] = kind
        blob["cam_focused"] = kind == "cam"
        # `minimized` came off the tick here and could be half a second stale — see
        # _minimized_now, which is also what the token is built from.
        blob["minimized"] = _minimized_now(blob, kind)
        blob["focused"] = kind in ("anki", "cam") and not blob["minimized"]
    # Carried on every answer, so the extension always has a current one to wait on and
    # never needs a separate request to fetch one. Its presence is also how the extension
    # knows this add-on is new enough to be waited on at all.
    blob["fgtoken"] = _fg_token()
    return blob


def _glow_target(now):
    """The colour that should be on screen this instant, or "off"."""
    if _glow_want not in GLOW_COLOURS:
        return "off"
    if (now - _glow_at) > GLOW_STALE_SEC:
        return "off"
    # The frame can't rise above other applications, but it would still be drawn around
    # an Anki sitting behind them, and a green edge on a background window says
    # "counting" when nothing is being counted.
    if not _glow_in_anki:
        return "off"
    # This colour was worked out while you were in another application, so it describes
    # being in another application — "red, you're not in Anki" is the wrong thing to show
    # the instant you arrive in Anki. Wait for the next word, which is milliseconds away
    # now that Chrome losing focus brings the poll forward.
    #
    # The extension says so outright rather than this being inferred from timestamps. The
    # timestamp version raced: the push can now land before this add-on's own tick has
    # noticed the switch, and it was then thrown away as stale — so arriving in Anki showed
    # nothing at all until the poll after next.
    if not _glow_want_fg:
        return "off"
    return _glow_want


def _glow_geometry(win):
    """Where the frame sits: Anki's window, minus the strip along the top that the
    title bar, the menus and Anki's own toolbar occupy.

    The glow used to start at the very top of the window, so a deep one washed over the
    File/Edit/View menus and the Decks/Add/Browse/Stats/Sync row — the things you click.
    It now begins underneath them, and the ring closes just below the toolbar instead.

    Measured from the widgets rather than assumed: the toolbar is hidden while you're
    reviewing, the menu bar can be hidden too, and both change height with the theme and
    the display scale. Whichever of them reaches furthest down wins; if neither can be
    read the frame covers the window as before, which is the old behaviour rather than a
    broken one.

    The sweep uses the same rectangle. It could have the whole window, being a moment
    rather than a fixture — but a band of light that crosses the menus and then the deck
    list is two animations that don't line up, and holding one edge for both keeps them
    the same thing.
    """
    geo = win.frameGeometry()
    bottom = None
    candidates = (
        getattr(win, "toolbarWeb", None),                      # newer Anki
        getattr(getattr(win, "toolbar", None), "web", None),    # older Anki
        win.menuBar() if hasattr(win, "menuBar") else None,
    )
    for widget in candidates:
        try:
            if widget is None or not widget.isVisible():
                continue
            edge = widget.mapToGlobal(widget.rect().bottomLeft()).y()
            bottom = edge if bottom is None else max(bottom, edge)
        except Exception:
            continue
    if bottom is not None and geo.top() < bottom < geo.bottom():
        geo.setTop(bottom + 1)
    return geo


def _glow_apply():
    """Put the frame where it belongs. GUI thread only — called from _tick."""
    global _glow, _glow_rect, _glow_in_anki
    global _green_sweeping, _green_done, _cheer_wanted
    win = mw
    now = time.time()

    # Coming back to Anki earns another sweep, so returning to your cards always gets an
    # answer to "is this counting?" — that being the moment the question is asked.
    here = win is not None and _in_anki_now(win)
    if here != _glow_in_anki:
        _glow_in_anki = here
        if here:
            _green_sweeping = False
            _green_done = False

    # Finished for the day. Takes precedence over any colour, and is spent whether or not it
    # could be shown — a celebration held over until you next happen to open Anki would arrive
    # with no idea what it was for.
    if _cheer_wanted:
        _cheer_wanted = False
        if win is not None and _glow_in_anki:
            if _glow is None:
                _glow = _GlowFrame(win)
            _glow.cancel_sweep()
            _glow.set_state("green", "cheer")
            geo = _glow_geometry(win)
            _glow_rect = (geo.x(), geo.y(), geo.width(), geo.height())
            _glow.setGeometry(geo)
            _glow.start_cheer()
            if not _glow.isVisible():
                _glow.show()
                _glow.raise_()
            # Green has nothing to add on top of this.
            _green_done = True
            return

    # While the confetti is in the air, nothing else repaints over it.
    if _glow is not None and _glow.mode() == "cheer" and _glow.sweeping():
        return

    colour = _glow_target(now) if win is not None else "off"

    if colour == "green":
        if _green_done:
            colour = "off"
        # The frame hid itself, which is how it reports the sweep is over. Checked here
        # rather than timed here, so the two can't disagree about when that was — if they
        # did, the next tick would find the frame hidden, decide green is still wanted and
        # send the light across again.
        elif _green_sweeping and _glow is not None and not _glow.sweeping():
            _green_sweeping = False
            _green_done = True
            colour = "off"

    if colour == "off":
        _glow_hide()
        return

    if _glow is None:
        _glow = _GlowFrame(win)
    # Every colour is a still boundary now, green included.
    #
    # Green used to sweep — a band of light crossing the whole window, diagonally, once per change.
    # The idea was that a movement reads as "this just started counting" in a way a static colour
    # cannot. In use it read as a green glare washing over the card you were trying to read, and a
    # thing you have to wait out twice a minute stops being information and becomes weather.
    #
    # The sweep machinery below is left intact and simply unused for green: _draw_sweep, SWEEP_SEC
    # and the rest still serve the one-off "cheer" on the day's first finish, which IS a single
    # event and is the one place a flourish belongs.
    _glow.set_state(colour, "ring")

    geo = _glow_geometry(win)
    rect = (geo.x(), geo.y(), geo.width(), geo.height())
    if rect != _glow_rect:
        _glow_rect = rect
        _glow.setGeometry(geo)

    if colour == "green":
        # Before the show(), so the first frame drawn has the band still off the left
        # edge instead of already across the window.
        if not _green_sweeping:
            _green_sweeping = True
            _glow.start_sweep()
    else:
        # Red is a fixture. If it arrived mid-sweep, that animation would otherwise carry
        # on and hide the red when it finished.
        _glow.cancel_sweep()
        # Coming up out of nothing, so it comes up rather than being switched on. This is the case
        # green cannot be in — its sweep hides the frame when it ends, so the red that follows a
        # finished sweep always arrives to an empty screen, and it was the last transition here that
        # still snapped. A dissolve already in hand from set_state is left alone; see fade_in.
        _glow.fade_in()

    if not _glow.isVisible():
        _glow.show()
        _glow.raise_()


def _glow_hide():
    """Take the glow away.

    Fading rather than vanishing, when there is something on screen to fade. The two ways to get
    here with a ring still up are the day's goal being met and the extension being switched off, and
    both are the end of something — a red edge that disappears between one frame and the next reads
    as the add-on having died, which is the opposite of the news.

    fade_out_and_hide does the hiding itself when it finishes, and is safe to call on every tick:
    a fade already running is left to run rather than restarted. Green is the exception and needs no
    help — its sweep eases itself out and hides the frame at the end, and by the time this is
    reached for green the frame is already gone.
    """
    if _glow is None:
        return
    if _glow.isVisible() and _glow.mode() in ("ring", "out"):
        _glow.fade_out_and_hide()
        return
    _glow.cancel_sweep()
    _glow.cancel_fade()
    if _glow.isVisible():
        _glow.hide()


def _glow_destroy():
    global _glow, _glow_rect
    frame, _glow, _glow_rect = _glow, None, None
    if frame is None:
        return
    try:
        # Both timers stopped before the widget goes. They are children of it, so deleteLater would
        # take them in the end — but "in the end" is after the event loop next spins, and a 20ms
        # timer can fire once more in between and repaint a widget that is being torn down.
        frame.cancel_sweep()
        frame.cancel_fade()
    except Exception:
        pass
    try:
        frame.hide()
        frame.setParent(None)
        frame.deleteLater()
    except Exception:
        pass


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # A client that opens a connection and then says nothing must not be able to
    # hold a thread forever. ThreadingHTTPServer starts one thread per connection,
    # so without this a page could open sockets in a loop and grow threads and
    # handles inside Anki until it was restarted.
    timeout = 5

    def _reply(self, code, body=b""):
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            # Kept permissive so the extension's service worker is never blocked by
            # CORS. It is NOT what decides who may call: see _caller_allowed.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)
        except Exception:
            pass

    def _caller_allowed(self):
        """Only the extension, not any web page you happen to have open.

        This server answers on localhost with no authentication, so before this
        check ANY website could fetch it: read whether Anki is focused, full
        screen and on the review screen, and — worse — hit /focus in a loop to
        yank Anki to the foreground over and over.

        A browser always sends Origin on a cross-origin fetch, and for a web page
        that Origin is http(s). An extension's own request either sends no Origin
        or sends chrome-extension://. So allowing exactly those two shapes lets
        the extension through and shuts every website out.

        "null" used to be on the allowed list and should never have been. It looks
        like "no origin", but it is what a SANDBOXED document sends — an iframe with
        sandbox="allow-scripts", a srcdoc document, a data: URL — and any web page
        can create one of those in a line of HTML. So it was not "no origin at all",
        it was "attacker-supplied origin, spelled null", and it let any site take the
        foreground away from whatever you were typing in.

        Host is checked too. A missing Origin is normal for a same-origin request,
        and a site can make itself same-origin with this server through DNS
        rebinding: point evil.example at 127.0.0.1 and the browser stops sending
        Origin at all. It cannot forge the Host header, though, so requiring Host to
        be a literal loopback address closes that off.

        This is not a defence against another program on the machine — nothing served
        on loopback can be, and a process that can bind port 8766 before Anki does
        can impersonate this add-on outright. It is a defence against the one
        attacker who arrives without being installed: a web page.
        """
        origin = (self.headers.get("Origin") or "").strip().lower()
        if not (origin == "" or origin.startswith("chrome-extension://")):
            return False
        host = (self.headers.get("Host") or "").strip().lower()
        # A bracketed IPv6 literal is stripped by its bracket, not by counting colons.
        # "[::1]:8766" has three colons, so the count test left the port attached and the
        # request was refused — against an address that is on the list below, which is
        # what shows it was not the intent.
        if host.startswith("["):
            hostname = host[1:].split("]", 1)[0]
        else:
            hostname = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
        # No "" any more. HTTP/1.1 requires a Host header, so a blank one is not something
        # a browser produces — it is a hand-written client, which is exactly the caller
        # this check exists to keep out.
        return hostname in ("127.0.0.1", "localhost", "::1")

    def _drain_body(self):
        """Read and throw away the request body.

        Not optional, and not tidiness. This is HTTP/1.1 with keep-alive, so the
        connection is reused — and an unread body is still sitting in the socket when
        the next request is parsed off it. That makes the body BE the next request,
        and a request smuggled in that way carries whatever headers the attacker
        typed rather than the ones the browser adds. Which means no Origin header,
        which the check above treats as "this is the extension".

        The whole hole in one line of page JavaScript: POST to any path with a body
        that spells out "POST /focus HTTP/1.1". Request one is refused, its body
        becomes request two, and Anki is dragged to the foreground — in a loop, for
        as long as the page likes, so you cannot type anywhere.
        """
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            n = -1
        # Chunked, or a length we can't trust: nothing safe to do but hang up.
        if n < 0 or (self.headers.get("Transfer-Encoding") or "").strip().lower():
            self.close_connection = True
            return False
        if n > 1 << 16:            # nobody legitimately posts 64KB here
            self.close_connection = True
            return False
        while n > 0:
            chunk = self.rfile.read(min(n, 8192))
            if not chunk:
                self.close_connection = True
                return False
            n -= len(chunk)
        return True

    def do_OPTIONS(self):
        self._drain_body()
        self._reply(204)

    def _path(self):
        return (self.path or "/").split("?")[0].rstrip("/").lower()

    def _serve_wait(self):
        """Hold this request open until the foreground changes, then answer at once.

        This is the whole reason the extension can notice you leaving Anki in about ten
        milliseconds instead of asking over and over and still being late. See _fg_token.

        Safe to block in: ThreadingHTTPServer gives every connection its own thread, so
        nothing else waits on this one, and the thread is a daemon — Anki closing does not
        wait for it either. Nothing here touches Qt or the collection, which is what makes
        it legal off the GUI thread at all.

        `timeout = 5` on the handler is a SOCKET timeout, on each read and write. Sleeping
        does not touch the socket, so it does not apply to how long this may wait; the cap
        is WAIT_MAX_SEC.

        Deliberately does NOT call _read_goal_request. That function cancels the pending
        unlock-gate question when a request carries no `want`, and this request carries
        none — so routing it through here would hold the due, retention and unique-card
        gates in "never measured today", which is the state where they stand aside.
        """
        token = ""
        limit = WAIT_MAX_SEC
        try:
            q = parse_qs(urlparse(self.path or "").query or "")
            # Capped: this is echoed straight back from our own previous answer, but it
            # arrives off the network and there is no reason to hold an arbitrary string.
            token = (q.get("token", [""])[0] or "")[:200]
            ms = float(q.get("ms", ["0"])[0])
            if ms > 0:
                limit = min(WAIT_MAX_SEC, ms / 1000.0)
        except Exception:
            pass
        end = time.time() + limit
        changed = False
        while True:
            # An empty token — the extension's first ask — differs from everything, so the
            # answer is immediate and it gets a token to wait on next time.
            if _fg_token() != token:
                changed = True
                break
            # _server is set to None by _stop, so a profile closing releases this at once
            # rather than making the socket linger for up to WAIT_MAX_SEC.
            if time.time() >= end or _server is None:
                break
            time.sleep(WAIT_STEP_SEC)
        blob = _live_state()
        # False means "nothing happened, I just ran out of time" — the extension uses it to
        # tell a real change from an expiry, so an expiry costs no poll.
        blob["changed"] = changed
        self._reply(200, json.dumps(blob).encode("utf-8"))

    def do_GET(self):
        # Treated as fatal here as well as in do_POST, which is where it always was. The
        # smuggling hole itself is shut either way — _drain_body hangs up on every failure
        # path — but ignoring the answer meant a GET carrying a chunked body still had its
        # query string acted on, and this is the request that records the unlock-gate
        # question. Two routes in, one rule.
        if not self._drain_body():
            self._reply(400, b'{"error":"bad body"}')
            return
        if not self._caller_allowed():
            # The connection is dropped, not kept alive. A refused caller has no
            # business reusing the socket, and hanging up removes any chance of a
            # second request being parsed out of whatever it sent.
            self.close_connection = True
            self._reply(403, b'{"error":"forbidden"}')
            return
        # The extension's unlock-gate question rides along on this poll's query
        # string. Only written down here; the next timer tick answers it on Anki's
        # GUI thread, because the collection must not be touched from this one.
        #
        # Safe to accept on a GET precisely because it changes nothing observable:
        # it selects which read-only numbers get computed. The one thing this server
        # does that has an effect on your machine — raising the window — stays a
        # POST, for the reasons in do_POST.
        # Routed before the goal question is read, because this one must not touch it.
        if self._path() == "/wait":
            self._serve_wait()
            return
        _read_goal_request(self.path)
        # Raising the window is a POST (see do_POST). A GET to /focus is answered
        # like any other path — with the status blob — so an <img> or a stray link
        # can't trigger it even if the Origin check somehow passes.
        self._reply(200, json.dumps(_live_state()).encode("utf-8"))

    def do_POST(self):
        """Bring Anki to the front — the extension's "open Anki" click.

        POST, not GET, on purpose. The Origin check above leans on the browser
        sending an Origin header, and it does for fetch() — but not for
        `<img src="http://127.0.0.1:8766/focus">`, which sends none at all and
        therefore looked like the extension. Any web page could put that in a loop
        and yank Anki to the foreground over and over. An <img>, a <link>, an
        <iframe> and a plain navigation can only ever issue a GET, so requiring
        POST closes that whole class off without needing a custom header (which
        would force a CORS preflight on every poll).
        """
        if not self._drain_body():
            self._reply(400, b'{"error":"bad body"}')
            return
        if not self._caller_allowed():
            self.close_connection = True
            self._reply(403, b'{"error":"forbidden"}')
            return
        path = self._path()
        if path == "/glow":
            # No rate limit and no ceremony: this decides the colour of a border on
            # Anki's own window, so the worst a caller who got past the Origin and
            # Host checks could do is make it flicker. /focus below is the one that
            # takes the keyboard away from whatever you're typing in, which is why
            # that one is throttled.
            ok = _read_glow_request(self.path)
            body = json.dumps({"ok": ok, "glow": _glow_want, "version": VERSION})
            self._reply(200 if ok else 400, body.encode("utf-8"))
            return
        if path == "/lock":
            # Unthrottled, like /glow and /media. The worst a caller who got past the Origin and
            # Host checks can do with this is refuse to open your card browser for twenty
            # seconds — and it cannot even hold that, because the lock expires on its own unless
            # something keeps asking. /focus stays the throttled one, being the only route that
            # takes the keyboard away from what you are typing in.
            ok = _read_lock_request(self.path)
            body = json.dumps({"ok": ok, "lock": bool(_lock_active()),
                               "lock_addons": bool(_lock_addons_active()),
                               "lock_new": bool(_lock_new_active()),
                               "version": VERSION})
            self._reply(200 if ok else 400, body.encode("utf-8"))
            return
        if path == "/media":
            # Unthrottled here, like /glow and unlike /focus. The worst a caller who got past the
            # Origin and Host checks can do with this is pause a video, which is both harmless and
            # undoable by pressing play. /focus is the one that takes the keyboard away from what
            # you are typing in, which is why that one has a rate limit.
            ok = _read_media_request(self.path)
            body = json.dumps({"ok": ok, "version": VERSION})
            self._reply(200 if ok else 400, body.encode("utf-8"))
            return
        if path != "/focus":
            self._reply(404, b'{"error":"not found"}')
            return
        # At most one raise every two seconds, whoever is asking. Raising a window
        # takes the keyboard away from whatever you were typing in, so even a bug on
        # our own side — a retry loop in the extension, a double click — must not be
        # able to make Anki flap in front of you. It is also a second wall behind the
        # Origin and Host checks above, so a hole in either one degrades to a
        # nuisance instead of making the machine unusable.
        global _raise_wanted, _last_raise_at
        now = time.time()
        if now - _last_raise_at < 2.0:
            self._reply(429, b'{"error":"too many requests"}')
            return
        _last_raise_at = now
        _raise_wanted = True
        self._reply(200, json.dumps({"ok": True, "raised": True, "version": VERSION}).encode("utf-8"))

    def handle_one_request(self):
        """The same as the stdlib's, except that a client hanging up is not an error.

        This is HTTP/1.1 with keep-alive (see protocol_version), so after answering a
        request the thread goes straight back to a blocking read, waiting for the next one
        on the same connection. Chrome closes idle sockets after a few seconds — always,
        by design, nothing to do with this add-on — and on Windows that close arrives as
        WSAECONNABORTED, raised out of the read as ConnectionAbortedError (WinError 10053).

        The stdlib catches TimeoutError there and nothing else, so the exception travelled
        up through socketserver, which printed the traceback to stderr. Anki turns anything
        written to stderr into "Anki encountered a problem. The problem may be caused by an
        add-on" — so a browser closing a socket exactly the way browsers close sockets put a
        crash dialog in front of the user, with a traceback that names this add-on.

        Nothing was actually wrong on either side, and nothing needs recovering: the
        connection is gone, so the only honest response is to stop using it.
        """
        try:
            return BaseHTTPRequestHandler.handle_one_request(self)
        except (ConnectionError, TimeoutError):
            # ConnectionError covers aborted, reset and broken-pipe, which are the three
            # ways "the other end is gone" reaches us.
            self.close_connection = True
            return

    def log_message(self, fmt, *args):
        pass


# Set when the port could not be bound, so the failure has somewhere to show.
_bind_error = ""


class _Server(ThreadingHTTPServer):
    """The status server.

    allow_reuse_address is turned OFF, which is the opposite of the stdlib default
    and the first reason this subclass exists. That default sets SO_REUSEADDR, and on
    Windows SO_REUSEADDR lets a SECOND process bind a port the first one is already
    listening on — both binds "succeed" and which one gets a given connection is
    anybody's guess. Two consequences, both bad: a second Anki profile started
    silently instead of reporting the port was taken, and any ordinary program on the
    machine could bind 8766 after Anki and answer "focused: true, maximised: true"
    for ever, which defeats the window check completely.

    On Windows the honest version of "don't share this port" is
    SO_EXCLUSIVEADDRUSE, so that is set as well where it exists.
    """

    allow_reuse_address = False
    daemon_threads = True

    def handle_error(self, request, client_address):
        """Nothing from a request thread may reach stderr.

        Anki installs its own stderr and shows "Anki encountered a problem" for whatever
        arrives on it, so socketserver's default here — print the traceback and carry on —
        is a crash dialog generator. It fired for connections Chrome had simply closed.

        handle_one_request above deals with that specific case at the point it happens; this
        is the net under everything else, including any future bug of our own. A real bug
        still gets its full traceback, printed to STDOUT instead, where it lands in Anki's
        console output without being announced to the user as a crash. The user cannot act
        on it either way: this server reports window state, so a failed request costs one
        poll and the next one is two seconds behind it.
        """
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)):
            return
        try:
            print("[AnkiGate Bridge] request from %s failed:\n%s"
                  % (client_address, traceback.format_exc()))
        except Exception:
            pass

    def server_bind(self):
        if sys.platform.startswith("win"):
            try:
                import socket
                # SO_EXCLUSIVEADDRUSE is defined by Winsock as ~SO_REUSEADDR, and
                # SO_REUSEADDR is 4, so the value is -5. Not exposed by the socket
                # module on every Python build, hence the literal fallback.
                opt = getattr(socket, "SO_EXCLUSIVEADDRUSE", -5)
                self.socket.setsockopt(socket.SOL_SOCKET, opt, 1)
            except Exception:
                pass
        return ThreadingHTTPServer.server_bind(self)


# The running server, so _stop can close the socket instead of leaving it to the
# daemon thread's death at interpreter exit — which races the next Anki start for the
# port.
_server = None
# A bind is in flight. Needed because _server is assigned on the serving THREAD, while
# the two callers of _start_server both run on the GUI thread — profile_did_open, then
# main_window_did_init a moment later. Without a flag set synchronously, the second call
# still sees _server as None, starts a second thread, and the two race for the port:
# one wins, the other raises and pops the "another program is using it" warning on a
# perfectly ordinary Anki start.
_server_starting = False


def _serve():
    global _bind_error, _server, _server_starting
    # Did we get the port at all? The warning below says "another program is using it",
    # which is only ever true of a failure to BIND. A failure that happens later, while
    # serving, is a different fault and blaming the port for it sends people looking in
    # the wrong place — so a raise from serve_forever is left quiet, and the extension's
    # ordinary "add-on not answering" state covers it.
    bound = False
    try:
        server = _Server(("127.0.0.1", PORT), _Handler)
        _server = server
        _bind_error = ""
        _server_starting = False
        bound = True
        server.serve_forever()
    except Exception as e:
        _server_starting = False
        if bound:
            return
        # Port busy (a second Anki profile, a leftover process, or something else
        # squatting on it). This used to be swallowed in silence, which produced
        # the worst possible symptom: the extension says "add-on not found" and
        # tells you to install it, while the add-on is installed and running fine.
        # Nothing anywhere said the port was the problem.
        _bind_error = "%s: %s" % (type(e).__name__, e)
        print("[AnkiGate Bridge] could not listen on 127.0.0.1:%d — %s" % (PORT, _bind_error))
        try:
            from aqt.utils import showWarning
            from aqt import mw as _mw
            _mw.taskman.run_on_main(lambda: showWarning(
                "AnkiGate Bridge could not open port %d.\n\n%s\n\n"
                "Another Anki profile or program is probably using it. "
                "The extension will keep saying the add-on is missing until this "
                "port is free." % (PORT, _bind_error)))
        except Exception:
            pass


def _on_timer():
    # Wrapped whole, because this is a Qt slot on Anki's GUI thread. An unhandled
    # exception out of a PyQt slot doesn't just log — it can take the process down
    # with qFatal(). This add-on watching a window must never be able to kill Anki,
    # so nothing gets out of here.
    try:
        _tick()
    except Exception:
        pass


def _tick():
    # An "open Anki" request from the extension arrived on the HTTP thread; do it
    # here, where we're on Anki's GUI thread.
    global _raise_wanted
    if _raise_wanted:
        _raise_wanted = False
        _raise_main_window()
    # "Your clock has stopped, so stop the video too" — same arrangement as the raise above: the
    # request arrived on the HTTP thread, and the webview may only be touched from here.
    global _media_pause_wanted, _media_resume_wanted
    if _media_pause_wanted:
        _media_pause_wanted = False
        _pause_media()
    # And the other way: "everything is in order again, put back what you stopped." Only ever the
    # players __fgPauseMedia marked — see _resume_media. Checked after the pause and with `elif`
    # deliberately: both flags standing at once means two requests arrived inside one tick window, and
    # in that case the stop is the one to honour. Undoing a pause the extension asked for half a second
    # ago, because a resume queued just before it, would leave a video running with a stopped clock —
    # which is the exact thing this pair exists to prevent.
    elif _media_resume_wanted:
        _media_resume_wanted = False
        _resume_media()
    # Pin first so the camera window's handle is known before we decide who has
    # the foreground — otherwise clicking it would look like "another app".
    # Two cheap Win32 calls once the handle is cached, so every tick is fine, and
    # anything slower would let the window slip behind Anki for a moment.
    _pin_camera_window()
    # Every other tick. Asking the webview is the one part of this that costs
    # anything, and a play/pause gate does not need it twice a second.
    global _media_tick
    _media_tick += 1
    if _media_tick % MEDIA_POLL_EVERY == 0:
        _poll_media()
        # Self-throttling, so this is a comparison against a timestamp on most ticks and a file
        # write on very few. Here rather than inside _pos_note because that runs from an eval
        # callback, and a disk write is not something to do on the way out of one.
        _pos_save()
    # The unlock-gate numbers, if the extension has asked for any. Same reasoning as
    # the media probe: this is the part that costs something, so it does not run at
    # the tick rate, and it does not run at all for a user with these gates off.
    global _goals_tick
    _goals_tick += 1
    if _goal_req is not None and _goals_tick % GOALS_POLL_EVERY == 0:
        try:
            _compute_goals()
        except Exception:
            pass
    # Before _sample, because _sample is what copies the reading into the blob the HTTP
    # thread serves. The other way round and every answer would carry an idle time from
    # half a second ago — which is harmless at these timeouts but would make the two
    # readings in one payload describe two different instants for no reason.
    _sample_input()
    _sample()
    # After _sample, so the frame decides on this tick's foreground reading rather
    # than the last one — that's the difference between the glow going out as you
    # leave Anki and half a second later.
    try:
        _glow_apply()
    except Exception:
        pass


_started = False


def _start_server():
    """Put the listener back on the port, unless it is already there.

    Its own function, and called from profile_did_open as well as from _start, because
    the server used to be launched only from _start — which is guarded by `_started` and
    runs once per Anki session. _stop closes the socket on profile_will_close, and that
    hook fires when you SWITCH profiles as well as when you quit. So the first profile
    switch of a session took the bridge away for good: the 500 ms timer went on sampling
    and pinning and drawing the glow, while the extension reported "add-on not
    installed" and told the user to install one that was loaded and running.

    Idempotent, so re-entering it costs nothing and cannot end up with two threads racing
    for the port — see _server_starting for why `_server is not None` is not enough on its
    own. A bind that FAILED clears the flag without setting _server, so the next profile
    open tries again, which is what you want when the port was briefly held by something
    else.
    """
    global _server_starting
    if _server is not None or _server_starting:
        return
    _server_starting = True
    try:
        threading.Thread(target=_serve, daemon=True).start()
    except Exception:
        _server_starting = False


def _start():
    # This hook also fires when you switch profiles, so only ever start once.
    global _started
    if _started:
        return
    _started = True
    # Do this first, so even a session where nothing else happens leaves Windows
    # able to start Anki for AnkiGate.
    _register_launcher()
    # Before the timer and before the server, so the guards are in place by the time anything
    # can ask for the lock. main_window_did_init has run, which is what makes mw.reviewer exist
    # to be wrapped; installing from a hook that fires earlier would silently skip the delete
    # guard. They pass through until the extension asks — see _install_lock_guards.
    try:
        _install_lock_guards()
    except Exception:
        pass
    try:
        timer = QTimer(mw)
        timer.timeout.connect(_on_timer)
        timer.start(500)
        mw._ankigate_timer = timer      # keep a reference so Qt doesn't collect it
        # Paired with _sample for the same reason as in the tick: the first blob the HTTP
        # thread can serve is written here, and without this it would carry the -1 the
        # module was initialised with — read as "cannot tell", so the tracker would stand
        # aside for the first half second of every Anki session.
        _sample_input()
        _sample()
    except Exception:
        pass
    _start_server()


def _stop():
    """Give back what should not outlive this session.

    Note what is deliberately NOT given back: the URL handler in the registry. That
    key is the whole mechanism for starting Anki when Anki is CLOSED, so removing it
    on the way out would destroy the feature it exists for — the one moment it is
    needed is the one moment this function has just run. It is registered fresh on
    every profile open, which repairs it after an Anki update or a move.

    Two things do go back: the listening socket, and WS_EX_TOPMOST on the camera
    window. Neither used to. The socket relied on the daemon thread dying with the
    interpreter, which races a new Anki start; and the camera window was left stuck
    above every other application until the user closed it by hand.
    """
    global _server, _server_starting, _lock_want, _lock_addons_want, _lock_new_want
    # First, before anything that can fail: the resume positions. The tick writes them at most
    # every ten seconds, so pausing a video and quitting straight away would otherwise lose the one
    # position you most obviously meant to keep.
    try:
        _pos_save(force=True)
    except Exception:
        pass
    # The glow frame belongs to this profile's main window, so it goes with it.
    try:
        _glow_destroy()
    except Exception:
        pass
    # Let go of the camera window rather than leaving it stuck above everything.
    try:
        api = _win32_api()
        if api:
            u, wintypes = api["u"], api["wintypes"]
            FLAGS = 0x0001 | 0x0002 | 0x0010
            for h in list(_cam_hwnds):
                try:
                    hw = wintypes.HWND(h)
                    if u.IsWindow(hw):
                        u.SetWindowPos(hw, wintypes.HWND(-2), 0, 0, 0, 0, FLAGS)
                except Exception:
                    pass
    except Exception:
        pass
    # And the title bar's buttons, which is the more important of the two. A window left
    # always-on-top is annoying; a window left with no ✕ cannot be closed at all, and this is
    # the last code that will run before the add-on stops sampling. The extension closes the
    # window shortly after Anki goes anyway — it notices the bridge falling silent — but that
    # depends on the extension being alive and enabled, so it is a second line of defence and
    # not this one's excuse.
    try:
        _restore_cam_close_buttons()
    except Exception:
        pass
    # The collection goes back to being editable, and Anki's own methods go back to being its
    # own. Both halves matter: _lock_want is module state that a profile switch should not carry
    # into the next profile, and a wrapper left behind by a disabled add-on has nothing good to
    # do. The staleness timeout would have lifted the lock anyway within twenty seconds; this
    # makes it immediate, which is what somebody quitting Anki to get their browser back wants.
    _lock_want = False
    _lock_addons_want = False
    _lock_new_want = False
    try:
        _remove_lock_guards()
    except Exception:
        pass
    # Free the port properly, so the next Anki start doesn't race a dying socket.
    srv = _server
    _server = None
    # Cleared here too. A profile closing while a bind was still in flight would otherwise
    # leave the flag set for the rest of the session, and _start_server would decline to
    # bring the port back on the next profile open.
    _server_starting = False
    if srv is not None:
        # Both calls, in this order, on ONE background thread.
        #
        # They used to be split: shutdown() on a thread, server_close() straight after on
        # the GUI thread. shutdown() only asks serve_forever to stop and then blocks until
        # it does — up to half a second, its poll interval — so server_close() closed the
        # listening socket out from under the selector serve_forever was still waiting on.
        # On Windows that comes back as an OSError from select(), which propagates out of
        # serve_forever into _serve's handler and pops the "could not open port 8766 —
        # another Anki profile or program is probably using it" warning on an ordinary
        # profile close or quit, with _bind_error left set afterwards.
        def _close():
            try:
                srv.shutdown()
            except Exception:
                pass
            try:
                srv.server_close()
            except Exception:
                pass

        try:
            threading.Thread(target=_close, daemon=True).start()
        except Exception:
            pass


gui_hooks.main_window_did_init.append(_start)
# profile_will_close fires on quit and on switching profiles, which is when the port
# and the pinned window should go back. _start only ever runs once, so the launcher is
# re-registered on profile open instead — it is idempotent, and this also repairs it
# after Anki is updated or moved.
try:
    gui_hooks.profile_will_close.append(_stop)
except Exception:
    pass
def _on_profile_open():
    # The launcher, because it is idempotent and this repairs it after Anki is moved or
    # updated. And the port, because _stop gave it back when the previous profile closed
    # and nothing else would ever ask for it again this session — see _start_server.
    _register_launcher()
    _start_server()
    # And the lock guards, for the same reason as the port: _stop took them off when the previous
    # profile closed, and _start only ever runs once — so after switching profiles every lock would
    # have been a switch wired to nothing. Idempotent: on the first profile of a session _start has
    # already put them on and this does nothing.
    try:
        _install_lock_guards()
    except Exception:
        pass


try:
    gui_hooks.profile_did_open.append(_on_profile_open)
except Exception:
    pass
# The media probe rides along with the card's own HTML. Wrapped in try/except
# because a missing hook on an old Anki must cost the media check only, not the
# window check that everything else depends on.
try:
    gui_hooks.card_will_show.append(_on_card_will_show)
except Exception:
    pass
