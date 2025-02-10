/*
 * This file is part of the Dash-To-Panel extension for Gnome 3
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import Gio from 'gi://Gio'
import Shell from 'gi://Shell'

import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js'
import { EventEmitter } from 'resource:///org/gnome/shell/misc/signals.js'

import * as Utils from './utils.js'

const tracker = Shell.WindowTracker.get_default()
const knownCorrespondances = {
  'org.gnome.Evolution': [/^org\.gnome\.[eE]volution([.-].+)?$/g],
}

export const NotificationsMonitor = class extends EventEmitter {
  constructor() {
    super()

    this._state = {}
    this._signalsHandler = new Utils.GlobalSignalsHandler()

    // pretty much useless, but might as well keep it for now
    this._launcherEntryId = Gio.DBus.session.signal_subscribe(
      null, // sender
      'com.canonical.Unity.LauncherEntry', // iface
      'Update', // member
      null, // path
      null, // arg0
      Gio.DBusSignalFlags.NONE,
      (
        connection,
        senderName,
        objectPath,
        interfaceName,
        signalName,
        parameters,
      ) => this._handleLauncherUpdate(senderName, parameters),
    )

    this._signalsHandler.add([
      tracker,
      'notify::focus-app',
      () => {
        // reset notifications from message tray on app focus
        if (tracker.focus_app)
          this._updateState(tracker.focus_app.id, { trayCount: 0 }, true)
      },
    ])
    this._acquireUnityDBus()

    this._checkNotifications()
  }

  destroy() {
    if (this._launcherEntryId)
      Gio.DBus.session.signal_unsubscribe(this._launcherEntryId)

    this._releaseUnityDBus()
    this._signalsHandler.destroy()
  }

  _updateState(appId, state, ignoreMapping) {
    // depending of the notification source, some app id end
    // with ".desktop" and some don't ¯\_(ツ)_/¯
    appId = appId.replace('.desktop', '')
    appId = `${appId}.desktop`

    // some app have different source app id, deamon and such,
    // but it maps to a desktop app so match those here
    if (!ignoreMapping && !knownCorrespondances[appId])
      appId =
        Object.keys(knownCorrespondances).find((k) =>
          knownCorrespondances[k].some((regex) => appId.match(regex)),
        ) || appId

    this._state[appId] = this._state[appId] || {}
    this._mergeState(appId, state)

    this.emit(`update-${appId}`)
  }

  getState(app) {
    return this._state[app.id]
  }

  _mergeState(appId, state) {
    this._state[appId] = Object.assign(this._state[appId], state)

    if (tracker.focus_app?.id == appId) this._state[appId].trayCount = 0

    this._state[appId].urgent =
      state.urgent ||
      (this._state[appId].trayUrgent && this._state[appId].trayCount) ||
      false

    this._state[appId].total =
      ((this._state[appId]['count-visible'] || 0) &&
        (this._state[appId].count || 0)) + (this._state[appId].trayCount || 0)
  }

  _acquireUnityDBus() {
    if (!this._unityBusId) {
      this._unityBusId = Gio.DBus.session.own_name(
        'com.canonical.Unity',
        Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT,
        null,
        null,
      )
    }
  }

  _releaseUnityDBus() {
    if (this._unityBusId) {
      Gio.DBus.session.unown_name(this._unityBusId)
      this._unityBusId = 0
    }
  }

  _handleLauncherUpdate(senderName, parameters) {
    if (!senderName || !parameters) return

    let [appUri, properties] = parameters.deep_unpack()
    let appId = appUri.replace(/(^\w+:|^)\/\//, '')
    let updates = {}

    // https://wiki.ubuntu.com/Unity/LauncherAPI#Low_level_DBus_API:_com.canonical.Unity.LauncherEntry
    for (let property in properties)
      updates[property] = properties[property].unpack()

    this._updateState(appId, updates)
  }

  _checkNotifications() {
    let addSource = (tray, source) => {
      let appId = source?._appId || source?.app?.id
      let updateTray = () => {
        this._updateState(appId, {
          trayCount: source.count, // always source.unseenCount might be less annoying
          trayUrgent: !!source.notifications.find(
            (n) => n.urgency > MessageTray.Urgency.NORMAL,
          ),
        })
      }

      if (!appId) return

      this._signalsHandler.addWithLabel(appId, [
        source,
        'notify::count',
        updateTray,
      ])

      updateTray()
    }

    this._signalsHandler.add(
      [Main.messageTray, 'source-added', addSource],
      [
        Main.messageTray,
        'source-removed',
        (tray, source) => {
          if (source?._appId)
            this._signalsHandler.removeWithLabel(source._appId)
        },
      ],
    )

    Main.messageTray.getSources().forEach((s) => addSource(null, s))
  }
}
