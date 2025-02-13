/**
 * Vertical Workspaces
 * recentFilesSearchProvider.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2022 - 2023
 * @license    GPL-3.0
 */

'use strict';

const { GLib, Gio, Meta, St, Shell, Gtk } = imports.gi;

const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Settings = Me.imports.lib.settings;
const _Util = Me.imports.lib.util;

// gettext
const _ = Settings._;

const shellVersion = Settings.shellVersion;

const ModifierType = imports.gi.Clutter.ModifierType;

let recentFilesSearchProvider;
let _enableTimeoutId = 0;

// prefix helps to eliminate results from other search providers
// so it needs to be something less common
// needs to be accessible from vw module
var prefix = 'fq//';

var opt;

function getOverviewSearchResult() {
    return Main.overview._overview.controls._searchController._searchResults;
}

function update(reset = false) {
    opt = Me.imports.lib.settings.opt;
    if (!reset && opt.RECENT_FILES_SEARCH_PROVIDER_ENABLED && !recentFilesSearchProvider) {
        enable();
    } else if (reset || !opt.RECENT_FILES_SEARCH_PROVIDER_ENABLED) {
        disable();
        opt = null;
    }
}

function enable() {
    // delay because Fedora had problem to register a new provider soon after Shell restarts
    _enableTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        2000,
        () => {
            if (!recentFilesSearchProvider) {
                recentFilesSearchProvider = new RecentFilesSearchProvider(opt);
                getOverviewSearchResult()._registerProvider(recentFilesSearchProvider);
            }
            _enableTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }
    );
}

function disable() {
    if (recentFilesSearchProvider) {
        getOverviewSearchResult()._unregisterProvider(recentFilesSearchProvider);
        recentFilesSearchProvider = null;
    }
    if (_enableTimeoutId) {
        GLib.source_remove(_enableTimeoutId);
        _enableTimeoutId = 0;
    }
}

function makeResult(window, i) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    const appName = app ? app.get_name() : 'Unknown';
    const windowTitle = window.get_title();
    const wsIndex = window.get_workspace().index();

    return {
        'id': i,
        // convert all accented chars to their basic form and lower case for search
        'name': `${wsIndex + 1}: ${windowTitle} ${appName}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
        appName,
        windowTitle,
        window,
    };
}

const closeSelectedRegex = /^\/x!$/;
const closeAllResultsRegex = /^\/xa!$/;
const moveToWsRegex = /^\/m[0-9]+$/;
const moveAllToWsRegex = /^\/ma[0-9]+$/;

const RecentFilesSearchProvider = class RecentFilesSearchProvider {
    constructor() {
        this.id = 'recent-files';
        this.appInfo = Gio.AppInfo.create_from_commandline('/usr/bin/nautilus -w', _('Recent Files'), null);
        this.appInfo.get_description = () => _('Search recent files');
        this.appInfo.get_name = () => _('Recent Files');
        this.appInfo.get_id = () => 'org.gnome.Nautilus.desktop';
        this.appInfo.get_icon = () => Gio.icon_new_for_string('document-open-recent-symbolic');
        this.appInfo.should_show = () => true;

        this.canLaunchSearch = true;
        this.isRemoteProvider = false;
    }

    getInitialResultSet(terms, callback /* , cancellable = null*/) {
        // In GS 43 callback arg has been removed
        /* if (shellVersion >= 43)
            cancellable = callback; */

        const filesDict = {};
        const files = Gtk.RecentManager.get_default().get_items().filter(f => f.exists());

        // Detect whether time stamps are in int, or in GLib.DateTime object
        this._timeNeedsConversion = files[0].get_modified().to_unix;

        for (let file of files)
            filesDict[file.get_uri()] = file;


        this.files = filesDict;

        if (shellVersion >= 43)
            return new Promise(resolve => resolve(this._getResultSet(terms)));
        else
            callback(this._getResultSet(terms));

        return null;
    }

    _getResultSet(terms) {
        if (!terms[0].startsWith(prefix))
            return [];
        // do not modify original terms
        let termsCopy = [...terms];
        // search for terms without prefix
        termsCopy[0] = termsCopy[0].replace(prefix, '');

        const candidates = this.files;
        const _terms = [].concat(termsCopy);
        // let match;

        const term = _terms.join(' ');
        /* match = s => {
            return fuzzyMatch(term, s);
        }; */

        const results = [];
        let m;
        for (let id in candidates) {
            const file = this.files[id];
            const name = `${file.get_age()}d: ${file.get_display_name()} ${file.get_uri_display().replace(`/${file.get_display_name()}`, '')}`;
            if (opt.SEARCH_FUZZY)
                m = _Util.fuzzyMatch(term, name);
            else
                m = _Util.strictMatch(term, name);

            if (m !== -1)
                results.push({ weight: m, id });
        }

        if (this._timeNeedsConversion)
            results.sort((a, b) => this.files[a.id].get_modified().to_unix() < this.files[b.id].get_modified().to_unix());
        else
            results.sort((a, b) => this.files[a.id].get_modified() < this.files[b.id].get_modified());

        this.resultIds = results.map(item => item.id);
        return this.resultIds;
    }

    getResultMetas(resultIds, callback = null) {
        const metas = resultIds.map(id => this.getResultMeta(id));
        if (shellVersion >= 43)
            return new Promise(resolve => resolve(metas));
        else if (callback)
            callback(metas);
        return null;
    }

    getResultMeta(resultId) {
        const result = this.files[resultId];
        return {
            'id': resultId,
            'name': `${result.get_age()}:  ${result.get_display_name()}`,
            'description': `${result.get_uri_display().replace(`/${result.get_display_name()}`, '')}`,
            'createIcon': size => {
                let icon = this.getIcon(result, size);
                return icon;
            },
        };
    }

    getIcon(result, size) {
        let file = Gio.File.new_for_uri(result.get_uri());
        let info = file.query_info(Gio.FILE_ATTRIBUTE_THUMBNAIL_PATH,
            Gio.FileQueryInfoFlags.NONE, null);
        let path = info.get_attribute_byte_string(
            Gio.FILE_ATTRIBUTE_THUMBNAIL_PATH);

        let icon, gicon;

        if (path) {
            gicon = Gio.FileIcon.new(Gio.File.new_for_path(path));
        } else {
            const appInfo = Gio.AppInfo.get_default_for_type(result.get_mime_type(), false);
            if (appInfo)
                gicon = appInfo.get_icon();
        }

        if (gicon)
            icon = new St.Icon({ gicon, icon_size: size });
        else
            icon = new St.Icon({ icon_name: 'icon-missing', icon_size: size });


        return icon;
    }

    launchSearch(terms, timeStamp) {
        const appInfo = Gio.AppInfo.create_from_commandline('/usr/bin/nautilus -w recent:///', 'Nautilus', null);
        appInfo.launch([], global.create_app_launch_context(timeStamp, -1));

        // unlike on 42, on 44 if a window with the same uri is already open it will not get focus/activation
        // Gio.app_info_launch_default_for_uri('recent:///', global.create_app_launch_context(timeStamp, -1));

        // following solution for some reason ignores the recent:/// uri
        // this.appInfo.launch_uris(['recent:///'], global.create_app_launch_context(timeStamp, -1));
    }

    activateResult(resultId, terms, timeStamp) {
        const uri = resultId;
        const context = global.create_app_launch_context(timeStamp, -1);
        if (_Util.isShiftPressed()) {
            Main.overview.toggle();
            this.appInfo.launch_uris([uri], context);
        } else if (Gio.app_info_launch_default_for_uri(uri, context)) {
            // update recent list after (hopefully) successful activation
            const recentManager = Gtk.RecentManager.get_default();
            recentManager.add_item(resultId);
        } else {
            this.appInfo.launch_uris([uri], context);
        }
    }

    filterResults(results /* , maxResults*/) {
        // return results.slice(0, maxResults);
        return results.slice(0, 20);
    }

    getSubsearchResultSet(previousResults, terms, callback) {
        if (shellVersion < 43) {
            this.getSubsearchResultSet42(terms, callback);
            return null;
        }
        return this.getInitialResultSet(terms);
    }

    getSubsearchResultSet42(terms, callback) {
        callback(this._getResultSet(terms));
    }
};
