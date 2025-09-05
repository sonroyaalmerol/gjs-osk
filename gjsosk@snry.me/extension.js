import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Shell from 'gi://Shell';

import * as EdgeDragAction from 'resource:///org/gnome/shell/ui/edgeDragAction.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as KeyboardManager from 'resource:///org/gnome/shell/misc/keyboardManager.js';
import * as KeyboardUI from 'resource:///org/gnome/shell/ui/keyboard.js';
import * as InputSourceManager from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js'
const [major, minor] = Config.PACKAGE_VERSION.split('.').map(s => Number(s));
import { Dialog } from 'resource:///org/gnome/shell/ui/dialog.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const State = {
  OPENED: 0,
  CLOSED: 1,
  OPENING: 2,
  CLOSING: 3,
};

class KeyboardMenuToggle extends QuickSettings.QuickMenuToggle {
  static {
    GObject.registerClass(this);
  }

  constructor(extensionObject) {
    super({
      title: _('Screen Keyboard'),
      iconName: 'input-keyboard-symbolic',
      toggleMode: true,
    });

    this.extensionObject = extensionObject;
    this.settings = extensionObject.getSettings();

    this.menu.setHeader('input-keyboard-symbolic', _('Screen Keyboard'), _('Opening Mode'));
    this._itemsSection = new PopupMenu.PopupMenuSection();
    this._itemsSection.addMenuItem(new PopupMenu.PopupImageMenuItem(_('Never'), this.settings.get_int("enable-tap-gesture") == 0 ? 'emblem-ok-symbolic' : null));
    this._itemsSection.addMenuItem(new PopupMenu.PopupImageMenuItem(_("Only on Touch"), this.settings.get_int("enable-tap-gesture") == 1 ? 'emblem-ok-symbolic' : null));
    this._itemsSection.addMenuItem(new PopupMenu.PopupImageMenuItem(_("Always"), this.settings.get_int("enable-tap-gesture") == 2 ? 'emblem-ok-symbolic' : null));
    for (var i in this._itemsSection._getMenuItems()) {
      const item = this._itemsSection._getMenuItems()[i]
      const num = i
      item.connect('activate', () => this.settings.set_int("enable-tap-gesture", num))
    }

    this.menu.addMenuItem(this._itemsSection);
    this.settings.bind('indicator-enabled',
      this, 'checked',
      Gio.SettingsBindFlags.DEFAULT);
    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    const settingsItem = this.menu.addAction(_('More Settings'),
      () => this.extensionObject.openPreferences());
    settingsItem.visible = Main.sessionMode.allowSettings;
    this.menu._settingsActions[this.extensionObject.uuid] = settingsItem;
  }

  _refresh() {
    for (var i in this._itemsSection._getMenuItems()) {
      this._itemsSection._getMenuItems()[i].setIcon(this.settings.get_int("enable-tap-gesture") == i ? 'emblem-ok-symbolic' : null)
    }
  }
};


let keycodes;
let layouts;
let currentMonitorId = 0;
let extract_dir = GLib.get_user_cache_dir() + "/gjs-osk";
// [insert handwriting 1]

export default class GjsOskExtension extends Extension {
  _openKeyboard(instant) {
    if (this.Keyboard.state == State.CLOSED) {
      this.Keyboard.open(null, !instant ? null : true);
    }
  }

  _closeKeyboard(instant) {
    if (this.Keyboard.state == State.OPENED) {
      this.Keyboard.close(!instant ? null : true);
    }
  }

  _toggleKeyboard(instant = false) {
    if (!this.Keyboard.opened) {
      this._openKeyboard(instant);
      this.Keyboard.openedFromButton = true;
      this.Keyboard.closedFromButton = false
    } else {
      this._closeKeyboard(instant);
      this.Keyboard.openedFromButton = false;
      this.Keyboard.closedFromButton = true;
    }
  }

  _connectFocusSignals() {
    if (this._focusConn) return;
    this._focusConn = global.stage.connect('notify::key-focus', () => {
      if (!this.Keyboard || this.Keyboard._dragging) return;

      const f = global.stage.key_focus;
      const allowTap = [false, true, true][this.settings.get_int("enable-tap-gesture")]; // example policy
      const shouldOpen = !!f && f instanceof Clutter.Text && allowTap;

      // Respect manual toggles
      if (shouldOpen && !this.Keyboard.opened && !this.Keyboard.closedFromButton) {
        this._openKeyboard();
      } else if (!shouldOpen && this.Keyboard.opened && !this.Keyboard.openedFromButton) {
        this._closeKeyboard();
      }
    });
  }

  _disconnectFocusSignals() {
    if (this._focusConn) {
      global.stage.disconnect(this._focusConn);
      this._focusConn = 0;
    }
  }

  enable() {
    // Load settings
    this.settings = this.getSettings();
    this.darkSchemeSettings = this.getSettings('org.gnome.desktop.interface');
    this.inputLanguageSettings = InputSourceManager.getInputSourceManager();
    this.gnomeKeyboardSettings = this.getSettings('org.gnome.desktop.a11y.applications');

    // Force off GNOME's built-in OSK while our extension is enabled
    this.isGnomeKeyboardEnabled = this.gnomeKeyboardSettings.get_boolean(
      'screen-keyboard-enabled'
    );
    this.gnomeKeyboardSettings.set_boolean('screen-keyboard-enabled', false);
    this.isGnomeKeyboardEnabledHandler = this.gnomeKeyboardSettings.connect(
      'changed',
      () => {
        // Keep it disabled while extension is active
        this.gnomeKeyboardSettings.set_boolean('screen-keyboard-enabled', false);
      }
    );

    // Determine scheme suffix
    this.settings.scheme =
      this.darkSchemeSettings.get_string('color-scheme') === 'prefer-dark'
        ? '-dark'
        : '';

    // Quick Settings toggle
    this._toggle = new KeyboardMenuToggle(this);
    this._quick_settings_indicator = new QuickSettings.SystemIndicator();
    this._quick_settings_indicator.quickSettingsItems.push(this._toggle);
    Main.panel.statusArea.quickSettings.addExternalIndicator(
      this._quick_settings_indicator
    );

    // Panel indicator (create once; reuse on setting changes)
    this._indicator = null;
    if (this.settings.get_boolean('indicator-enabled')) {
      this._indicator = new PanelMenu.Button(0.0, 'GJS OSK Indicator', false);
      const icon = new St.Icon({
        gicon: new Gio.ThemedIcon({ name: 'input-keyboard-symbolic' }),
        style_class: 'system-status-icon',
      });
      this._indicator.add_child(icon);

      this._indicator.connect('button-press-event', () => this._toggleKeyboard());
      this._indicator.connect('touch-event', (_actor, event) => {
        if (event.type() === Clutter.EventType.TOUCH_END) this._toggleKeyboard();
      });
      Main.panel.addToStatusArea('GJS OSK Indicator', this._indicator);
    }

    // Prepare cache dirs and load layouts/keycodes for current layout
    let [okL, contentsL] = GLib.file_get_contents(this.path + '/physicalLayouts.json');
    if (okL) layouts = JSON.parse(contentsL);

    extract_dir = GLib.get_user_cache_dir() + '/gjs-osk';
    const ensureKeycodesReady = () => {
      return new Promise(resolve => {
        const layoutId =
          KeyboardManager.getKeyboardManager().currentLayout?.id ?? 'us';
        const keycodesPath = `${extract_dir}/keycodes/${layoutId}.json`;

        const needExtract =
          !Gio.File.new_for_path(extract_dir).query_exists(null) ||
          !Gio.File.new_for_path(extract_dir + '/keycodes').query_exists(null) ||
          !Gio.File.new_for_path(keycodesPath).query_exists(null);

        if (needExtract) {
          try {
            Gio.File.new_for_path(extract_dir).make_directory_with_parents(null);
          } catch { }
          try {
            Gio.File.new_for_path(extract_dir + '/keycodes').make_directory_with_parents(null);
          } catch { }
          Gio.Subprocess.new(
            ['tar', '-Jxf', this.path + '/keycodes.tar.xz', '-C', extract_dir + '/keycodes'],
            Gio.SubprocessFlags.NONE
          )
            .wait_check_async(null)
            .then(() => {
              const [ok, contents] = GLib.file_get_contents(keycodesPath);
              if (ok) keycodes = JSON.parse(contents);
              resolve();
            })
            .catch(() => resolve());
        } else {
          const [ok, contents] = GLib.file_get_contents(keycodesPath);
          if (ok) keycodes = JSON.parse(contents);
          resolve();
        }
      });
    };

    // Build keyboard once keycodes are ready
    this.Keyboard = null;
    const buildKeyboard = () => {
      if (this.Keyboard) {
        this.Keyboard.destroy();
        this.Keyboard = null;
      }
      this.Keyboard = new Keyboard(this.settings, this);
      this.Keyboard.refresh = () => this._applySettings?.();
    };

    // Override lastDeviceIsTouchscreen to behave consistently
    this._originalLastDeviceIsTouchscreen =
      KeyboardUI.KeyboardManager.prototype._lastDeviceIsTouchscreen;
    KeyboardUI.KeyboardManager.prototype._lastDeviceIsTouchscreen = () => false;

    // Debounced settings apply
    this._settingsIdle = 0;
    this._applySettings = () => {
      const wasOpen = this.Keyboard?.opened ?? false;

      // Update scheme flag quickly
      this.settings.scheme =
        this.darkSchemeSettings.get_string('color-scheme') === 'prefer-dark'
          ? '-dark'
          : '';

      // Decide whether we can do a cosmetic update or need a rebuild.
      // For simplicity and safety, we rebuild here because many options
      // (layout/monitor/percent sizing) affect geometry.
      if (this.Keyboard) {
        this.Keyboard.destroy();
        this.Keyboard = null;
      }

      // Reload keycodes for current layout (if layout changed)
      const layoutId = KeyboardManager.getKeyboardManager().currentLayout?.id ?? 'us';
      const keycodesPath = `${extract_dir}/keycodes/${layoutId}.json`;
      const [ok, contents] = GLib.file_get_contents(keycodesPath);
      if (ok) keycodes = JSON.parse(contents);

      // Recreate the keyboard
      this.Keyboard = new Keyboard(this.settings, this);
      this.Keyboard.refresh = () => this._applySettings();

      // Reuse indicator actor: toggle visibility only
      if (this._indicator) {
        this._indicator.visible = this.settings.get_boolean('indicator-enabled');
      } else if (this.settings.get_boolean('indicator-enabled')) {
        // Create only if needed and missing
        this._indicator = new PanelMenu.Button(0.0, 'GJS OSK Indicator', false);
        const icon = new St.Icon({
          gicon: new Gio.ThemedIcon({ name: 'input-keyboard-symbolic' }),
          style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);
        this._indicator.connect('button-press-event', () => this._toggleKeyboard());
        this._indicator.connect('touch-event', (_actor, event) => {
          if (event.type() === Clutter.EventType.TOUCH_END) this._toggleKeyboard();
        });
        Main.panel.addToStatusArea('GJS OSK Indicator', this._indicator);
      }

      // Restore state
      if (wasOpen && this.Keyboard) this._toggleKeyboard(true);
    };

    const scheduleSettingsApply = () => {
      if (this._settingsIdle) return;
      this._settingsIdle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
        this._settingsIdle = 0;
        this._applySettings();
        return GLib.SOURCE_REMOVE;
      });
    };

    // Settings handlers (debounced)
    const settingsChanged = () => scheduleSettingsApply();
    this.settingsHandlers = [
      this.settings.connect('changed', settingsChanged),
      this.darkSchemeSettings.connect('changed', (_s, key) => {
        if (key === 'color-scheme') settingsChanged();
      }),
      this.inputLanguageSettings.connect('current-source-changed', settingsChanged),
    ];

    // Open command toggle key (reuse existing schema)
    this.openBit = this.settings.get_child('indicator');
    this.openFromCommandHandler = this.openBit.connect('changed', () => {
      this.openBit.set_boolean('opened', false);
      this._toggleKeyboard();
    });

    // Build initial UI
    ensureKeycodesReady().then(() => buildKeyboard());

    // Event-driven focus tracking (replaces polling open_interval)
    this._focusConn = 0;
    this._connectFocusSignals = () => {
      if (this._focusConn) return;
      this._focusConn = global.stage.connect('notify::key-focus', () => {
        if (!this.Keyboard || this.Keyboard._dragging) return;

        const f = global.stage.key_focus;
        const mode = this.settings.get_int('enable-tap-gesture');
        // 0: Never, 1: Only on Touch (handled elsewhere if you need), 2: Always
        const allowAlways = mode === 2;

        const shouldOpen = !!f && f instanceof Clutter.Text && allowAlways;
        if (shouldOpen && !this.Keyboard.opened && !this.Keyboard.closedFromButton) {
          this._openKeyboard();
        } else if (!shouldOpen && this.Keyboard.opened && !this.Keyboard.openedFromButton) {
          this._closeKeyboard();
        }
      });
    };
    this._disconnectFocusSignals = () => {
      if (this._focusConn) {
        global.stage.disconnect(this._focusConn);
        this._focusConn = 0;
      }
    };
    this._connectFocusSignals();

    // Keep z-order correct only when opening (no recurring timers)
    this._openKeyboard = instant => {
      if (this.Keyboard.state === State.CLOSED) {
        this.Keyboard.open(null, !instant ? null : true);
        // Ensure on top once
        const p = this.Keyboard.get_parent();
        if (p) p.set_child_at_index(this.Keyboard, p.get_n_children() - 1);
        this.Keyboard.set_child_at_index(
          this.Keyboard.box,
          this.Keyboard.get_n_children() - 1
        );
      }
    };
    this._closeKeyboard = instant => {
      if (this.Keyboard.state === State.OPENED) {
        this.Keyboard.close(!instant ? null : true);
      }
    };
    this._toggleKeyboard = (instant = false) => {
      if (!this.Keyboard.opened) {
        this._openKeyboard(instant);
        this.Keyboard.openedFromButton = true;
        this.Keyboard.closedFromButton = false;
      } else {
        this._closeKeyboard(instant);
        this.Keyboard.openedFromButton = false;
        this.Keyboard.closedFromButton = true;
      }
    };

    // Listen to monitor changes to rebuild only when needed
    this._monitorsConn = global.backend
      .get_monitor_manager()
      .connect('monitors-changed', () => {
        // Rebuild on orientation/geometry changes
        scheduleSettingsApply();
      });
  }

  disable() {
    if (this.isGnomeKeyboardEnabledHandler) {
      this.gnomeKeyboardSettings.disconnect(this.isGnomeKeyboardEnabledHandler);
      this.isGnomeKeyboardEnabledHandler = 0;
    }
    if (this.gnomeKeyboardSettings) {
      this.gnomeKeyboardSettings.set_boolean(
        'screen-keyboard-enabled',
        this.isGnomeKeyboardEnabled
      );
    }

    if (this._focusConn) {
      global.stage.disconnect(this._focusConn);
      this._focusConn = 0;
    }

    if (this._monitorsConn) {
      global.backend.get_monitor_manager().disconnect(this._monitorsConn);
      this._monitorsConn = 0;
    }

    if (this.settingsHandlers) {
      if (this.settingsHandlers[0]) this.settings.disconnect(this.settingsHandlers[0]);
      if (this.settingsHandlers[1])
        this.darkSchemeSettings.disconnect(this.settingsHandlers[1]);
      if (this.settingsHandlers[2])
        this.inputLanguageSettings.disconnect(this.settingsHandlers[2]);
      this.settingsHandlers = null;
    }

    if (this._settingsIdle) {
      GLib.source_remove(this._settingsIdle);
      this._settingsIdle = 0;
    }

    if (this.openBit && this.openFromCommandHandler) {
      this.openBit.disconnect(this.openFromCommandHandler);
      this.openFromCommandHandler = 0;
    }
    this.openBit = null;

    if (this._quick_settings_indicator) {
      this._quick_settings_indicator.quickSettingsItems.forEach(item => item.destroy());
      this._quick_settings_indicator.destroy();
      this._quick_settings_indicator = null;
    }
    if (this._toggle) {
      this._toggle.destroy();
      this._toggle = null;
    }

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    if (this.Keyboard) {
      this.Keyboard.destroy();
      this.Keyboard = null;
    }

    if (this._originalLastDeviceIsTouchscreen != null) {
      KeyboardUI.KeyboardManager.prototype._lastDeviceIsTouchscreen =
        this._originalLastDeviceIsTouchscreen;
      this._originalLastDeviceIsTouchscreen = null;
    }

    this.settings = null;
    this.darkSchemeSettings = null;
    this.inputLanguageSettings = null;
    this.gnomeKeyboardSettings = null;

    layouts = null;
    keycodes = null;
  }
}

// [insert handwriting 3]

class Keyboard extends Dialog {
  static [GObject.signals] = {
    'drag-begin': {},
    'drag-end': {}
  };

  static {
    GObject.registerClass(this);
  }

  _init(settings, extensionObject) {
    this.settingsOpenFunction = extensionObject.openPrefs
    this.inputDevice = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    this.settings = settings;
    let monitor = Main.layoutManager.monitors[currentMonitorId];
    super._init(Main.layoutManager.modalDialogGroup, 'db-keyboard-content');
    this.box = new St.Widget({
      reactive: true,
      layout_manager: new Clutter.GridLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
      })
    });
    this.widthPercent = (monitor.width > monitor.height) ? settings.get_int("landscape-width-percent") / 100 : settings.get_int("portrait-width-percent") / 100;
    this.heightPercent = (monitor.width > monitor.height) ? settings.get_int("landscape-height-percent") / 100 : settings.get_int("portrait-height-percent") / 100;
    this.nonDragBlocker = new Clutter.Actor();
    this.buildUI();
    this.draggable = false;
    // [insert handwriting 4]
    this.add_child(this.box);
    this.close();
    this.box.set_name("osk-gjs")
    this.mod = [];
    this.modBtns = [];
    this.capsL = false;
    this.shift = false;
    this.alt = false;
    this.opened = false;
    this.state = State.CLOSED;
    this.delta = [];
    this.monitorChecker = global.backend.get_monitor_manager().connect('monitors-changed', () => {
      if (Main.layoutManager.monitors.length > 0) {
        this.refresh();
      }
    });
    this._pressed = new Set();
    this._releaseTimeouts = new Map();
    this._dragging = false;
    let side = null;
    switch (this.settings.get_int("default-snap")) {
      case 0:
      case 1:
      case 2:
        side = St.Side.TOP;
        break;
      case 3:
        side = St.Side.LEFT;
        break;
      case 5:
        side = St.Side.RIGHT;
        break;
      case 6:
      case 7:
      case 8:
        side = St.Side.BOTTOM;
        break;
    }
    this.oldBottomDragAction = global.stage.get_action('osk');
    if (this.oldBottomDragAction !== null && this.oldBottomDragAction instanceof Clutter.Action)
      global.stage.remove_action(this.oldBottomDragAction);
    if (side != null) {
      const mode = Shell.ActionMode.ALL & ~Shell.ActionMode.LOCK_SCREEN;
      const bottomDragAction = new EdgeDragAction.EdgeDragAction(side, mode);
      bottomDragAction.connect('activated', () => {
        this.open(true);
        this.openedFromButton = true;
        this.closedFromButton = false;
        this.gestureInProgress = false;
      });
      bottomDragAction.connect('progress', (_action, progress) => {
        if (!this.gestureInProgress)
          this.open(false)
        this.setOpenState(Math.min(Math.max(0, (progress / (side % 2 == 0 ? this.box.height : this.box.width)) * 100), 100))
        this.gestureInProgress = true;
      });
      bottomDragAction.connect('gesture-cancel', () => {
        if (this.gestureInProgress) {
          this.close()
          this.openedFromButton = false;
          this.closedFromButton = true;
        }
        this.gestureInProgress = false;
        return Clutter.EVENT_PROPAGATE;
      });
      global.stage.add_action_full('osk', Clutter.EventPhase.CAPTURE, bottomDragAction);
      this.bottomDragAction = bottomDragAction;
    } else {
      this.bottomDragAction = null;
    }
    this._oldMaybeHandleEvent = Main.keyboard.maybeHandleEvent
    Main.keyboard.maybeHandleEvent = (e) => {
      let lastInputMethod = [e.type() == 11, e.type() == 11, e.type() == 7 || e.type() == 11][this.settings.get_int("enable-tap-gesture")]
      let ac = global.stage.get_event_actor(e)
      if (this.contains(ac)) {
        ac.event(e, true);
        ac.event(e, false);
        return true;
      } else if (ac instanceof Clutter.Text && lastInputMethod && !this.opened) {
        this.open();
      }
      return false
    }
  }

  _press(code) {
    if (!this._pressed.has(code)) {
      this.inputDevice.notify_key(Clutter.get_current_event_time(), code, Clutter.KeyState.PRESSED);
      this._pressed.add(code);
    }
  }

  _release(code) {
    if (this._pressed.has(code)) {
      this.inputDevice.notify_key(Clutter.get_current_event_time(), code, Clutter.KeyState.RELEASED);
      this._pressed.delete(code);
    }
    // Cancel any pending timeout for this code
    const t = this._releaseTimeouts.get(code);
    if (t) {
      clearTimeout(t);
      this._releaseTimeouts.delete(code);
    }
  }

  destroy() {
    Main.keyboard.maybeHandleEvent = this._oldMaybeHandleEvent
    global.stage.remove_action_by_name('osk')
    if (this.oldBottomDragAction !== null && this.oldBottomDragAction instanceof Clutter.Action)
      global.stage.add_action_full('osk', Clutter.EventPhase.CAPTURE, this.oldBottomDragAction)
    if (this.textboxChecker !== null) {
      clearInterval(this.textboxChecker);
      this.textboxChecker = null;
    }
    if (this.stateTimeout !== null) {
      clearTimeout(this.stateTimeout);
      this.stateTimeout = null;
    }
    if (this.keyTimeout !== null) {
      clearTimeout(this.keyTimeout);
      this.keyTimeout = null;
    }
    this.keymap.disconnect(this.capslockConnect);
    this.keymap.disconnect(this.numLockConnect);
    global.backend.get_monitor_manager().disconnect(this.monitorChecker)
    super.destroy();
    if (this.nonDragBlocker !== null) {
      Main.layoutManager.removeChrome(this.nonDragBlocker)
    }
  }

  startDragging(event, delta) {
    if (this.draggable) {
      if (this._dragging)
        return Clutter.EVENT_PROPAGATE;
      this._dragging = true;
      this.box.set_opacity(255);
      this.box.ease({
        opacity: 200,
        duration: 100,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => { }
      });
      let device = event.get_device();
      let sequence = event.get_event_sequence();
      this._grab = global.stage.grab(this);
      this._grabbedDevice = device;
      this._grabbedSequence = sequence;
      this.emit('drag-begin');
      let [absX, absY] = event.get_coords();
      this.snapMovement(absX - delta[0], absY - delta[1]);
      return Clutter.EVENT_STOP;
    } else {
      return Clutter.EVENT_PROPAGATE;
    }
  }

  endDragging() {
    if (this.draggable) {
      if (this._dragging) {
        if (this._releaseId) {
          this.disconnect(this._releaseId);
          this._releaseId = 0;
        }
        if (this._grab) {
          this._grab.dismiss();
          this._grab = null;
        }

        this.box.set_opacity(200);
        this.box.ease({
          opacity: 255,
          duration: 100,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => { }
        });
        this._grabbedSequence = null;
        this._grabbedDevice = null;
        this._dragging = false;
        this.delta = [];
        this.emit('drag-end');
        this._dragging = false;
      }
      this.draggable = false;
      return Clutter.EVENT_STOP;
    } else {
      return Clutter.EVENT_STOP;
    }
  }

  motionEvent(event) {
    if (this.draggable) {
      let [absX, absY] = event.get_coords();
      this.snapMovement(absX - this.delta[0], absY - this.delta[1]);
      return Clutter.EVENT_STOP
    } else {
      return Clutter.EVENT_STOP
    }
  }

  snapMovement(xPos, yPos) {
    let monitor = Main.layoutManager.monitors[currentMonitorId]
    if (xPos < monitor.x || yPos < monitor.y || xPos > monitor.x + monitor.width || yPos > monitor.y + monitor.width) {
      this.set_translation(xPos, yPos, 0);
      return;
    }
    xPos -= monitor.x;
    yPos -= monitor.y;
    let snap_px = this.settings.get_int("snap-spacing-px")
    if (Math.abs(xPos - ((monitor.width * .5) - ((this.width * .5)))) <= 50) {
      xPos = ((monitor.width * .5) - ((this.width * .5)));
    } else if (Math.abs(xPos - snap_px) <= 50) {
      xPos = snap_px;
    } else if (Math.abs(xPos - (monitor.width - this.width - snap_px)) <= 50) {
      xPos = monitor.width - this.width - snap_px
    }
    if (Math.abs(yPos - (monitor.height - this.height - snap_px)) <= 50) {
      yPos = monitor.height - this.height - snap_px;
    } else if (Math.abs(yPos - snap_px) <= 50) {
      yPos = snap_px;
    } else if (Math.abs(yPos - ((monitor.height * .5) - (this.height * .5))) <= 50) {
      yPos = (monitor.height * .5) - (this.height * .5);
    }
    this.set_translation(xPos + monitor.x, yPos + monitor.y, 0);
  }

  setOpenState(percent) {
    let monitor = Main.layoutManager.monitors[currentMonitorId];
    let posX = [this.settings.get_int("snap-spacing-px"), ((monitor.width * .5) - ((this.width * .5))), monitor.width - this.width - this.settings.get_int("snap-spacing-px")][(this.settings.get_int("default-snap") % 3)];
    let posY = [this.settings.get_int("snap-spacing-px"), ((monitor.height * .5) - ((this.height * .5))), monitor.height - this.height - this.settings.get_int("snap-spacing-px")][Math.floor((this.settings.get_int("default-snap") / 3))];
    let mX = [-this.box.width, 0, this.box.width][(this.settings.get_int("default-snap") % 3)];
    let mY = [-this.box.height, 0, this.box.height][Math.floor((this.settings.get_int("default-snap") / 3))]
    let [dx, dy] = [posX + mX * ((100 - percent) / 100) + monitor.x, posY + mY * ((100 - percent) / 100) + monitor.y]
    let op = 255 * (percent / 100);
    this.set_translation(dx, dy, 0)
    this.box.set_opacity(op)
  }

  open(noPrep = null, instant = null) {
    if (this.updateCapsLock) this.updateCapsLock()
    if (this.updateNumLock) this.updateNumLock()
    if (noPrep == null || !noPrep) {
      this.prevKeyFocus = global.stage.key_focus
      this.inputDevice = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
      this.state = State.OPENING
      this.show();
    }
    if (noPrep == null || noPrep) {
      let monitor = Main.layoutManager.monitors[currentMonitorId];
      let posX = [this.settings.get_int("snap-spacing-px"), ((monitor.width * .5) - ((this.width * .5))), monitor.width - this.width - this.settings.get_int("snap-spacing-px")][(this.settings.get_int("default-snap") % 3)];
      let posY = [this.settings.get_int("snap-spacing-px"), ((monitor.height * .5) - ((this.height * .5))), monitor.height - this.height - this.settings.get_int("snap-spacing-px")][Math.floor((this.settings.get_int("default-snap") / 3))];
      if (noPrep == null) {
        let mX = [-this.box.width, 0, this.box.width][(this.settings.get_int("default-snap") % 3)];
        let mY = [-this.box.height, 0, this.box.height][Math.floor((this.settings.get_int("default-snap") / 3))]
        this.set_translation(posX + mX + monitor.x, posY + mY + monitor.y, 0)
      }
      this.box.ease({
        opacity: 255,
        duration: instant == null || !instant ? 100 : 0,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          if (this.stateTimeout !== null) {
            clearTimeout(this.stateTimeout);
            this.stateTimeout = null;
          }
          this.stateTimeout = setTimeout(() => {
            this.state = State.OPENED
          }, 500);
        }
      });
      this.ease({
        translation_x: posX + monitor.x,
        translation_y: posY + monitor.y,
        duration: instant == null || !instant ? 100 : 0,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD
      })
      if (!this.settings.get_boolean("enable-drag") && this.nonDragBlocker !== null) {
        Main.layoutManager.addChrome(this.nonDragBlocker, {
          affectsStruts: true,
          trackFullscreen: true,
        })
      }
      this.opened = true;
      // [insert handwriting 5]
    }
  }

  close(instant = null) {
    this.prevKeyFocus = null;
    let monitor = Main.layoutManager.monitors[currentMonitorId];
    let posX = [this.settings.get_int("snap-spacing-px"), ((monitor.width * .5) - ((this.width * .5))), monitor.width - this.width - this.settings.get_int("snap-spacing-px")][(this.settings.get_int("default-snap") % 3)];
    let posY = [this.settings.get_int("snap-spacing-px"), ((monitor.height * .5) - ((this.height * .5))), monitor.height - this.height - this.settings.get_int("snap-spacing-px")][Math.floor((this.settings.get_int("default-snap") / 3))];
    let mX = [-this.box.width, 0, this.box.width][(this.settings.get_int("default-snap") % 3)];
    let mY = [-this.box.height, 0, this.box.height][Math.floor((this.settings.get_int("default-snap") / 3))]
    this.state = State.CLOSING
    this.box.ease({
      opacity: 0,
      duration: instant == null || !instant ? 100 : 0,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        this.opened = false;
        this.hide();
        if (this.stateTimeout !== null) {
          clearTimeout(this.stateTimeout);
          this.stateTimeout = null;
        }
        this.stateTimeout = setTimeout(() => {
          this.state = State.CLOSED
        }, 500);
      },
    });
    this.ease({
      translation_x: posX + mX + monitor.x,
      translation_y: posY + mY + monitor.y,
      duration: instant == null || !instant ? 100 : 0,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD
    })
    if (!this.settings.get_boolean("enable-drag") && this.nonDragBlocker !== null) {
      Main.layoutManager.removeChrome(this.nonDragBlocker, {
        affectsStruts: true,
        trackFullscreen: true,
      })
    }
    this.openedFromButton = false
    this.releaseAllKeys();
    // [insert handwrting 6]
  }

  vfunc_button_press_event() {
    this.delta = [Clutter.get_current_event().get_coords()[0] - this.translation_x, Clutter.get_current_event().get_coords()[1] - this.translation_y];
    return this.startDragging(Clutter.get_current_event(), this.delta)
  }

  vfunc_button_release_event() {
    if (this._dragging && !this._grabbedSequence) {
      return this.endDragging();
    }
    return Clutter.EVENT_PROPAGATE;
  }

  vfunc_motion_event() {
    let event = Clutter.get_current_event();
    if (this._dragging && !this._grabbedSequence) {
      this.motionEvent(event);
    }
    return Clutter.EVENT_PROPAGATE;
  }

  vfunc_touch_event() {
    let event = Clutter.get_current_event();
    let sequence = event.get_event_sequence();

    if (!this._dragging && event.type() == Clutter.EventType.TOUCH_BEGIN) {
      this.delta = [event.get_coords()[0] - this.translation_x, event.get_coords()[1] - this.translation_y];
      this.startDragging(event, this.delta);
      return Clutter.EVENT_STOP;
    } else if (this._grabbedSequence && sequence.get_slot() === this._grabbedSequence.get_slot()) {
      if (event.type() == Clutter.EventType.TOUCH_UPDATE) {
        return this.motionEvent(event);
      } else if (event.type() == Clutter.EventType.TOUCH_END) {
        return this.endDragging();
      }
    }

    return Clutter.EVENT_PROPAGATE;
  }

  buildUI() {
    this.box.set_opacity(0);
    this.keys = [];
    let monitor = Main.layoutManager.monitors[currentMonitorId]
    let layoutName = Object.keys(layouts)[(monitor.width > monitor.height) ? this.settings.get_int("layout-landscape") : this.settings.get_int("layout-portrait")];
    this.box.width = Math.round((monitor.width - this.settings.get_int("snap-spacing-px") * 2) * (layoutName.includes("Split") ? 1 : this.widthPercent))
    this.box.height = Math.round((monitor.height - this.settings.get_int("snap-spacing-px") * 2) * this.heightPercent)

    if (!this.settings.get_boolean("enable-drag")) {
      this.nonDragBlocker = new Clutter.Actor();
      switch (this.settings.get_int("default-snap")) {
        case 0:
        case 1:
        case 2:
          this.nonDragBlocker.x = monitor.x;
          this.nonDragBlocker.y = monitor.y;
          this.nonDragBlocker.width = monitor.width;
          this.nonDragBlocker.height = this.box.height + 2 * this.settings.get_int("snap-spacing-px");
          break;
        case 3:
          this.nonDragBlocker.x = monitor.x;
          this.nonDragBlocker.y = monitor.y;
          this.nonDragBlocker.width = this.box.width + 2 * this.settings.get_int("snap-spacing-px");
          this.nonDragBlocker.height = monitor.height;
          break;
        case 5:
          this.nonDragBlocker.x = monitor.x + monitor.width - (this.box.width + 2 * this.settings.get_int("snap-spacing-px"));
          this.nonDragBlocker.y = monitor.y;
          this.nonDragBlocker.width = this.box.width + 2 * this.settings.get_int("snap-spacing-px");
          this.nonDragBlocker.height = monitor.height;
          break;
        case 6:
        case 7:
        case 8:
          this.nonDragBlocker.x = monitor.x;
          this.nonDragBlocker.y = monitor.y + monitor.height - (this.box.height + 2 * this.settings.get_int("snap-spacing-px"));
          this.nonDragBlocker.width = monitor.width;
          this.nonDragBlocker.height = this.box.height + 2 * this.settings.get_int("snap-spacing-px");
          break;
      }
      if (this.settings.get_int("default-snap") == 4) {
        this.nonDragBlocker.destroy();
        this.nonDragBlocker = null;
      }
    } else {
      this.nonDragBlocker.destroy();
      this.nonDragBlocker = null;
    }

    const grid = this.box.layout_manager
    grid.set_row_homogeneous(true)
    grid.set_column_homogeneous(!layoutName.includes("Split"))

    let gridLeft;
    let gridRight;
    let currentGrid = grid;
    let left;
    let right;
    let topBtnWidth;

    if (layoutName.includes("Split")) {
      this.box.reactive = false;
      left = new St.Widget({
        reactive: true,
        layout_manager: new Clutter.GridLayout({
          orientation: Clutter.Orientation.HORIZONTAL,
          row_homogeneous: true,
          column_homogeneous: true
        }),
        width: Math.round((monitor.width - this.settings.get_int("snap-spacing-px") * 2) * this.widthPercent) / 2
      })
      gridLeft = left.layout_manager;
      let middle = new St.Widget({
        reactive: false,
        width: this.box.width * (1 - this.widthPercent) - 10 + this.settings.get_int("border-spacing-px")
      });
      right = new St.Widget({
        reactive: true,
        layout_manager: new Clutter.GridLayout({
          orientation: Clutter.Orientation.HORIZONTAL,
          row_homogeneous: true,
          column_homogeneous: true
        }),
        width: Math.round((monitor.width - this.settings.get_int("snap-spacing-px") * 2) * this.widthPercent) / 2
      })
      gridRight = right.layout_manager;
      this.box.add_child(left)
      this.box.add_child(middle)
      this.box.add_child(right)
    }

    this.shiftButtons = [];
    // [insert handwriting 7]

    let currentLayout = layouts[layoutName];
    let width = 0;
    for (const c of currentLayout[0]) {
      width += (Object.hasOwn(c, "width") ? c.width : 1)
    }
    let rowSize;
    let halfSize;
    let r = 0;
    let c;
    const doAddKey = (keydef) => {
      const i = Object.hasOwn(keydef, "key") ? keycodes[keydef.key] : Object.hasOwn(keydef, "split") ? "split" : "empty space";
      if (i != null && typeof i !== 'string') {
        if (i.layers.default == null) {
          for (var key of Object.keys(i.layers)) {
            i.layers[key] = i.layers["_" + key]
          }
        }
        let params = {
          x_expand: true,
          y_expand: true
        }

        let iconKeys = ["left", "up", "right", "down", "space"]
        if (this.settings.get_boolean("show-icons")) {
          iconKeys = ["left", "up", "right", "down", "backspace", "tab", "capslock", "shift", "enter", "ctrl", "super", "alt", "space"]
        }
        // [insert handwriting 8]
        if (iconKeys.some(j => { return i.layers.default.toLowerCase() == j })) {
          params.style_class = i.layers.default.toLowerCase() + "_btn"
          for (var key of Object.keys(i.layers)) {
            i.layers["_" + key] = i.layers[key]
            i.layers[key] = null
          }
        } else {
          params.label = i.layers.default
        }
        i.isMod = false
        if ([42, 54, 29, 125, 56, 100, 97, 58, 69].some(j => { return i.code == j })) {
          i.isMod = true;
        }
        const keyBtn = new St.Button(params)
        keyBtn.add_style_class_name('key')
        keyBtn.char = i
        if (i.code == 58) {
          this.keymap = Clutter.get_default_backend().get_default_seat().get_keymap()
          this.capslockConnect = this.keymap.connect("state-changed", (a, e) => {
            this.setCapsLock(keyBtn, this.keymap.get_caps_lock_state())
          })
          this.updateCapsLock = () => this.setCapsLock(keyBtn, this.keymap.get_caps_lock_state())
        } else if (i.code == 69) {
          this.keymap = Clutter.get_default_backend().get_default_seat().get_keymap()
          this.numLockConnect = this.keymap.connect("state-changed", (a, e) => {
            this.setNumLock(keyBtn, this.keymap.get_num_lock_state())
          })
          this.updateNumLock = () => this.setNumLock(keyBtn, this.keymap.get_num_lock_state())
        } else if (i.code == 42 || i.code == 54) {
          this.shiftButtons.push(keyBtn)
        }
        currentGrid.attach(keyBtn, c, 5 + r, (Object.hasOwn(keydef, "width") ? keydef.width : 1) * 2, r == 0 ? 3 : (Object.hasOwn(keydef, "height") ? keydef.height : 1) * 4)
        keyBtn.visible = true
        c += (Object.hasOwn(keydef, "width") ? keydef.width : 1) * 2
        this.keys.push(keyBtn)
        // [insert handwriting 9]
      } else if (i == "empty space") {
        c += (Object.hasOwn(keydef, "width") ? keydef.width : 1) * 2
      } else if (i == "split") {
        currentGrid = gridRight
        const size = c
        if (!halfSize) halfSize = size
      }
    }

    for (const kRow of currentLayout) {
      c = 0;
      if (layoutName.includes("Split")) {
        currentGrid = gridLeft;
      }
      for (const keydef of kRow) {
        if (keydef instanceof Array) {
          keydef.forEach(i => { doAddKey(i); r += 2; c -= (Object.hasOwn(i, "width") ? i.width : 1) * 2 });
          c += (Object.hasOwn(keydef[0], "width") ? keydef[0].width : 1) * 2;
          r -= 4;
        } else {
          doAddKey(keydef)
        }
      }
      if (!topBtnWidth) topBtnWidth = ((Object.hasOwn(kRow[kRow.length - 1], "width") && (Object.hasOwn(kRow[kRow.length - 1], "key"))) ? kRow[kRow.length - 1].width : 1)
      const size = c;
      if (!rowSize) rowSize = size;
      r += r == 0 ? 3 : 4
    }

    if (left != null) {
      this.set_reactive(false)
      left.add_style_class_name("boxLay");
      right.add_style_class_name("boxLay");
      if (this.settings.get_boolean("system-accent-col") && major >= 47) {
        if (this.settings.scheme == "-dark") {
          left.set_style("background-color: st-darken(-st-accent-color, 30%); padding: " + this.settings.get_int("outer-spacing-px") + "px;")
          right.set_style("background-color: st-darken(-st-accent-color, 30%); padding: " + this.settings.get_int("outer-spacing-px") + "px;")
        } else {
          left.set_style("background-color: st-lighten(-st-accent-color, 10%); padding: " + this.settings.get_int("outer-spacing-px") + "px;")
          right.set_style("background-color: st-lighten(-st-accent-color, 10%); padding: " + this.settings.get_int("outer-spacing-px") + "px;")
        }
      } else {
        left.set_style("background-color: rgba(" + this.settings.get_double("background-r" + this.settings.scheme) + "," + this.settings.get_double("background-g" + this.settings.scheme) + "," + this.settings.get_double("background-b" + this.settings.scheme) + ", " + this.settings.get_double("background-a" + this.settings.scheme) + "); padding: " + this.settings.get_int("outer-spacing-px") + "px;")
        right.set_style("background-color: rgba(" + this.settings.get_double("background-r" + this.settings.scheme) + "," + this.settings.get_double("background-g" + this.settings.scheme) + "," + this.settings.get_double("background-b" + this.settings.scheme) + ", " + this.settings.get_double("background-a" + this.settings.scheme) + "); padding: " + this.settings.get_int("outer-spacing-px") + "px;")
      }
      if (this.lightOrDark()) {
        left.add_style_class_name("inverted");
        right.add_style_class_name("inverted");
      } else {
        left.add_style_class_name("regular");
        right.add_style_class_name("regular");
      }
      const settingsBtn = new St.Button({
        x_expand: true,
        y_expand: true
      })
      settingsBtn.add_style_class_name("settings_btn")
      settingsBtn.add_style_class_name("key")
      settingsBtn.connect("clicked", () => {
        this.settingsOpenFunction();
      })
      gridLeft.attach(settingsBtn, 0, 0, 2 * topBtnWidth, 3)
      this.keys.push(settingsBtn)

      const closeBtn = new St.Button({
        x_expand: true,
        y_expand: true
      })
      closeBtn.add_style_class_name("close_btn")
      closeBtn.add_style_class_name("key")
      closeBtn.connect("clicked", () => {
        this.close();
        this.closedFromButton = true;
      })
      gridRight.attach(closeBtn, (rowSize - 2 * topBtnWidth), 0, 2 * topBtnWidth, 3)
      this.keys.push(closeBtn)

      let moveHandleLeft = new St.Button({
        x_expand: true,
        y_expand: true
      })
      moveHandleLeft.add_style_class_name("moveHandle")
      moveHandleLeft.set_style("font-size: " + this.settings.get_int("font-size-px") + "px; border-radius: " + (this.settings.get_boolean("round-key-corners") ? "5px;" : "0;") + "background-size: " + this.settings.get_int("font-size-px") + "px; font-weight: " + (this.settings.get_boolean("font-bold") ? "bold" : "normal") + "; border: " + this.settings.get_int("border-spacing-px") + "px solid transparent;");
      if (this.lightOrDark()) {
        moveHandleLeft.add_style_class_name("inverted");
      } else {
        moveHandleLeft.add_style_class_name("regular");
      }

      moveHandleLeft.connect("event", (actor, event) => {
        if (event.type() == Clutter.EventType.BUTTON_PRESS || event.type() == Clutter.EventType.TOUCH_BEGIN) {
          this.draggable = this.settings.get_boolean("enable-drag");
        }
        this.event(event, false)
      })
      gridLeft.attach(moveHandleLeft, 2 * topBtnWidth, 0, (halfSize - 2 * topBtnWidth), 3)

      let moveHandleRight = new St.Button({
        x_expand: true,
        y_expand: true
      })
      moveHandleRight.add_style_class_name("moveHandle")
      moveHandleRight.set_style("font-size: " + this.settings.get_int("font-size-px") + "px; border-radius: " + (this.settings.get_boolean("round-key-corners") ? "5px;" : "0;") + "background-size: " + this.settings.get_int("font-size-px") + "px; font-weight: " + (this.settings.get_boolean("font-bold") ? "bold" : "normal") + "; border: " + this.settings.get_int("border-spacing-px") + "px solid transparent;");
      if (this.lightOrDark()) {
        moveHandleRight.add_style_class_name("inverted");
      } else {
        moveHandleRight.add_style_class_name("regular");
      }

      moveHandleRight.connect("event", (actor, event) => {
        if (event.type() == Clutter.EventType.BUTTON_PRESS || event.type() == Clutter.EventType.TOUCH_BEGIN) {
          this.draggable = this.settings.get_boolean("enable-drag");
        }
        this.event(event, false)
      })
      gridRight.attach(moveHandleRight, halfSize, 0, (rowSize - halfSize - 2 * topBtnWidth), 3)
      gridLeft.attach(new St.Widget({ x_expand: true, y_expand: true }), 0, 3, halfSize, 1)
      gridRight.attach(new St.Widget({ x_expand: true, y_expand: true }), halfSize, 3, (rowSize - halfSize), 1)
    } else {
      this.box.add_style_class_name("boxLay");
      if (this.settings.get_boolean("system-accent-col") && major >= 47) {
        if (this.settings.scheme == "-dark") {
          this.box.set_style("background-color: st-darken(-st-accent-color, 30%); padding: " + this.settings.get_int("outer-spacing-px") + "px;")
        } else {
          this.box.set_style("background-color: st-lighten(-st-accent-color, 10%); padding: " + this.settings.get_int("outer-spacing-px") + "px;")
        }
      } else {
        this.box.set_style("background-color: rgba(" + this.settings.get_double("background-r" + this.settings.scheme) + "," + this.settings.get_double("background-g" + this.settings.scheme) + "," + this.settings.get_double("background-b" + this.settings.scheme) + ", " + this.settings.get_double("background-a" + this.settings.scheme) + "); padding: " + this.settings.get_int("outer-spacing-px") + "px;")
      }
      if (this.lightOrDark()) {
        this.box.add_style_class_name("inverted");
      } else {
        this.box.add_style_class_name("regular");
      }

      const settingsBtn = new St.Button({
        x_expand: true,
        y_expand: true
      })
      settingsBtn.add_style_class_name("settings_btn")
      settingsBtn.add_style_class_name("key")
      settingsBtn.connect("clicked", () => {
        this.settingsOpenFunction();
      })
      grid.attach(settingsBtn, 0, 0, 2 * topBtnWidth, 3)
      this.keys.push(settingsBtn)

      const closeBtn = new St.Button({
        x_expand: true,
        y_expand: true
      })
      closeBtn.add_style_class_name("close_btn")
      closeBtn.add_style_class_name("key")
      closeBtn.connect("clicked", () => {
        this.close();
        this.closedFromButton = true;
      })
      grid.attach(closeBtn, (rowSize - 2 * topBtnWidth), 0, 2 * topBtnWidth, 3)
      this.keys.push(closeBtn)

      // [insert handwriting 10]

      let moveHandle = new St.Button({
        x_expand: true,
        y_expand: true
      })
      moveHandle.add_style_class_name("moveHandle")
      moveHandle.set_style("font-size: " + this.settings.get_int("font-size-px") + "px; border-radius: " + (this.settings.get_boolean("round-key-corners") ? "5px;" : "0;") + "background-size: " + this.settings.get_int("font-size-px") + "px; font-weight: " + (this.settings.get_boolean("font-bold") ? "bold" : "normal") + "; border: " + this.settings.get_int("border-spacing-px") + "px solid transparent;");
      if (this.lightOrDark()) {
        moveHandle.add_style_class_name("inverted");
      } else {
        moveHandle.add_style_class_name("regular");
      }

      moveHandle.connect("event", (actor, event) => {
        if (event.type() == Clutter.EventType.BUTTON_PRESS || event.type() == Clutter.EventType.TOUCH_BEGIN) {
          this.draggable = this.settings.get_boolean("enable-drag");
        }
        this.event(event, false)
      })
      grid.attach(moveHandle, 2 * topBtnWidth, 0, (rowSize - 4 * topBtnWidth), 3) // [insert handwriting 11]
      grid.attach(new St.Widget({ x_expand: true, y_expand: true }), 0, 3, rowSize, 1)
    }

    this.keys.forEach(item => {
      item.set_style("font-size: " + this.settings.get_int("font-size-px") + "px; border-radius: " + (this.settings.get_boolean("round-key-corners") ? (this.settings.get_int("border-spacing-px") + 5) + "px;" : "0;") + "background-size: " + this.settings.get_int("font-size-px") + "px; font-weight: " + (this.settings.get_boolean("font-bold") ? "bold" : "normal") + "; border: " + this.settings.get_int("border-spacing-px") + "px solid transparent;");
      if (this.lightOrDark()) {
        item.add_style_class_name("inverted");
      } else {
        item.add_style_class_name("regular");
      }
      item.set_pivot_point(0.5, 0.5)
      item.connect("destroy", () => {
        if (item.button_pressed !== null) {
          clearTimeout(item.button_pressed)
          item.button_pressed == null
        }
        if (item.button_repeat !== null) {
          clearInterval(item.button_repeat)
          item.button_repeat == null
        }
        if (item.tap_pressed !== null) {
          clearTimeout(item.tap_pressed)
          item.tap_pressed == null
        }
        if (item.tap_repeat !== null) {
          clearInterval(item.tap_repeat)
          item.tap_repeat == null
        }
      })
      let pressEv = (evType) => {
        this.box.set_child_at_index(item, this.box.get_children().length - 1);
        item.space_motion_handler = null
        item.set_scale(1.2, 1.2)
        item.add_style_pseudo_class("pressed")
        let player
        if (this.settings.get_boolean("play-sound")) {
          player = global.display.get_sound_player();
          player.play_from_theme("dialog-information", "tap", null)
        }
        if (["delete_btn", "backspace_btn", "up_btn", "down_btn", "left_btn", "right_btn"].some(e => item.has_style_class_name(e))) {
          item.button_pressed = setTimeout(() => {
            const oldModBtns = this.modBtns
            item.button_repeat = setInterval(() => {
              if (this.settings.get_boolean("play-sound")) {
                player.play_from_theme("dialog-information", "tap", null)
              }
              this.decideMod(item.char)

              for (var i of oldModBtns) {
                this.decideMod(i.char, i)
              }
            }, 100);
          }, 750);
        } else if (item.has_style_class_name("space_btn")) {
          item.button_pressed = setTimeout(() => {
            let lastPos = (item.get_transformed_position()[0] + item.get_transformed_size()[0] / 2)
            if (evType == "mouse") {
              item.space_motion_handler = item.connect("motion_event", (actor, event) => {
                let absX = event.get_coords()[0];
                if (Math.abs(absX - lastPos) > 20) {
                  if (absX > lastPos) {
                    this.sendKey([106])
                  } else {
                    this.sendKey([105])
                  }
                  lastPos = absX
                }
              })
            } else {
              item.space_motion_handler = item.connect("touch_event", (actor, event) => {
                if (event.type() == Clutter.EventType.TOUCH_UPDATE) {
                  let absX = event.get_coords()[0];
                  if (Math.abs(absX - lastPos) > 20) {
                    if (absX > lastPos) {
                      this.sendKey([106])
                    } else {
                      this.sendKey([105])
                    }
                    lastPos = absX
                  }
                }
              })
            }
          }, 750)
        } else {
          item.key_pressed = true;
          item.button_pressed = setTimeout(() => {
            releaseEv()
          }, 1000);
        }
      }
      let releaseEv = () => {
        item.remove_style_pseudo_class("pressed")
        item.ease({
          scale_x: 1,
          scale_y: 1,
          duration: 100,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => { item.set_scale(1, 1); }
        })
        if (item.button_pressed !== null) {
          clearTimeout(item.button_pressed)
          item.button_pressed == null
        }
        if (item.button_repeat !== null) {
          clearInterval(item.button_repeat)
          item.button_repeat == null
        }
        if (item.space_motion_handler !== null) {
          item.disconnect(item.space_motion_handler)
          item.space_motion_handler = null;
        } else if (item.key_pressed == true || item.space_motion_handler == null) {
          try {
            if (!item.char.isMod) {
              this.decideMod(item.char)
            } else {
              const modButton = item;
              this.decideMod(item.char, modButton)
            }
          } catch { }
        }
        item.key_pressed = false;
      }
      item.connect("button-press-event", () => pressEv("mouse"))
      item.connect("button-release-event", releaseEv)
      item.connect("touch-event", () => {
        if (Clutter.get_current_event().type() == Clutter.EventType.TOUCH_BEGIN) {
          pressEv("touch")
        } else if (Clutter.get_current_event().type() == Clutter.EventType.TOUCH_END || Clutter.get_current_event().type() == Clutter.EventType.TOUCH_CANCEL) {
          releaseEv()
        }
      })
    });
  }

  lightOrDark() {
    let r, g, b;
    if (this.settings.get_boolean("system-accent-col")) {
      return this.settings.scheme != "-dark"
    } else {
      r = this.settings.get_double("background-r" + this.settings.scheme);
      g = this.settings.get_double("background-g" + this.settings.scheme);
      b = this.settings.get_double("background-b" + this.settings.scheme);
    }
    var hsp;
    hsp = Math.sqrt(
      0.299 * (r * r) +
      0.587 * (g * g) +
      0.114 * (b * b)
    );
    return hsp > 127.5
  }
  releaseAllKeys() {
    for (const code of Array.from(this._pressed)) {
      this.inputDevice.notify_key(Clutter.get_current_event_time(), code, Clutter.KeyState.RELEASED);
      this._pressed.delete(code);
    }

    for (const t of this._releaseTimeouts.values()) clearTimeout(t);
    this._releaseTimeouts.clear();

    this.keys.forEach(item => {
      item.key_pressed = false;
      if (item.button_pressed !== null) {
        clearTimeout(item.button_pressed)
        item.button_pressed == null
      }
      if (item.button_repeat !== null) {
        clearInterval(item.button_repeat)
        item.button_repeat == null
      }
      if (item.space_motion_handler !== null) {
        item.disconnect(item.space_motion_handler)
        item.space_motion_handler = null;
      }
    })
  }

  sendKey(keys) {
    try {
      const newlyPressed = [];
      for (const code of keys) {
        if (!this._pressed.has(code)) {
          this.inputDevice.notify_key(Clutter.get_current_event_time(), code, Clutter.KeyState.PRESSED);
          this._pressed.add(code);
          newlyPressed.push(code);
        }
      }
      const timeout = setTimeout(() => {
        for (let i = newlyPressed.length - 1; i >= 0; i--) {
          const code = newlyPressed[i];
          this._release(code);
        }
      }, 100);
      for (const c of newlyPressed) this._releaseTimeouts.set(c, timeout);
    } catch (err) {
      throw new Error("GJS-OSK error:\n" + err);
    }
  }

  decideMod(i, mBtn) {
    if (i.code == 29 || i.code == 56 || i.code == 97 || i.code == 125) {
      this.setNormMod(mBtn);
    } else if (i.code == 100) {
      this.setAlt(mBtn);
    } else if (i.code == 42 || i.code == 54) {
      this.setShift(mBtn);
    } else if (i.code == 58 || i.code == 69) {
      this.sendKey([mBtn.char.code]);
    } else {
      this.mod.push(i.code);
      this.sendKey(this.mod);
      this.mod = [];
      this.modBtns.forEach(button => button.remove_style_class_name("selected"));
      this.shiftButtons.forEach(k => k.remove_style_class_name("selected"));
      this.resetAllMod();
      this.modBtns = [];
    }
  }

  setCapsLock(button, state) {
    if (state) {
      button.add_style_class_name("selected");
      this.capsL = true;
    } else {
      button.remove_style_class_name("selected");
      this.capsL = false;
    }
    this.updateKeyLabels();
  }

  setNumLock(button, state) {
    if (state) {
      button.add_style_class_name("selected");
      this.numsL = true;
    } else {
      button.remove_style_class_name("selected");
      this.numsL = false;
    }
    this.updateKeyLabels();
  }

  setAlt(button) {
    this.alt = !this.alt;
    this.updateKeyLabels();
    if (!this.alt) {
      this.sendKey([button.char.code]);
    }
    this.setNormMod(button);
  }

  setShift(button) {
    this.shift = !this.shift;
    this.updateKeyLabels();
    if (!this.shift) {
      this.sendKey([button.char.code]);
      this.shiftButtons.forEach(i => { i.remove_style_class_name("selected") })
    } else {
      this.shiftButtons.forEach(i => { i.add_style_class_name("selected") })
    }
    this.setNormMod(button);
  }

  updateKeyLabels() {
    this.keys.forEach(key => {
      if (key.char != undefined) {
        let layer = (this.alt ? 'alt' : '') + (this.shift ? 'shift' : '') + (this.numsL ? 'num' : '') + (this.capsL ? 'caps' : '') + (this.numsL || this.capsL ? 'lock' : '')
        if (layer == '') layer = 'default'
        key.label = key.char.layers[layer];
      }
    });
  }


  setNormMod(button) {
    const code = button.char.code;
    const idx = this.mod.indexOf(code);
    if (idx !== -1) {
      this.mod.splice(idx, 1);
      const iBtn = this.modBtns.indexOf(button);
      if (iBtn !== -1) this.modBtns.splice(iBtn, 1);
      if (code !== 42 && code !== 54)
        button.remove_style_class_name("selected");
      this._release(code);
    } else {
      this.mod.push(code);
      this.modBtns.push(button);
      if (code !== 42 && code !== 54) button.add_style_class_name("selected");
      this._press(code);
    }
  }

  resetAllMod() {
    this.shift = false;
    this.alt = false;
    this.updateKeyLabels()
  }
}
