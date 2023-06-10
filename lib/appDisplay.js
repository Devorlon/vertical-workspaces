/**
 * V-Shell (Vertical Workspaces)
 * appDisplay.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2022 - 2023
 * @license    GPL-3.0
 *
 */

'use strict';

const { Clutter, GLib, GObject, Gio, Meta, Shell, St, Graphene, Pango } = imports.gi;

const DND = imports.ui.dnd;
const Main = imports.ui.main;
const AppDisplay = imports.ui.appDisplay;
const IconGrid = imports.ui.iconGrid;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Settings = Me.imports.lib.settings;
const IconGridOverride = Me.imports.lib.iconGrid;
const _Util = Me.imports.lib.util;

const DIALOG_SHADE_NORMAL = Clutter.Color.from_pixel(0x00000022);
const DIALOG_SHADE_HIGHLIGHT = Clutter.Color.from_pixel(0x00000000);

// gettext
const _ = Me.imports.lib.settings._;

let _overrides;
let _timeouts;

let _appGridLayoutSettings;
let _appDisplayScrollConId;
let _appSystemStateConId;
let _appGridLayoutConId;
let _origAppViewItemAcceptDrop;
let _updateFolderIcons;

let opt;
let shellVersion = _Util.shellVersion;
let _firstRun = true;


function update(reset = false) {
    opt = Me.imports.lib.settings.opt;
    const moduleEnabled = opt.get('appDisplayModule', true);
    reset = reset || !moduleEnabled;

    // don't even touch this module if disabled
    if (_firstRun && reset)
        return;

    _firstRun = false;

    if (_timeouts) {
        Object.keys(_timeouts).forEach(id => {
            if (_timeouts[id])
                GLib.source_remove(_timeouts[id]);
        });
    }
    _timeouts = {};

    if (_overrides)
        _overrides.removeAll();
    if (reset) {
        _setAppDisplayOrientation(false);
        _updateAppDisplayProperties(reset);
        _updateDND(reset);
        _restoreOverviewGroup();
        _removeStatusMessage();
        _overrides = null;
        _timeouts = null;
        opt = null;
        return;
    }

    _overrides = new _Util.Overrides();

    // Common
    _overrides.addOverride('FolderView', AppDisplay.FolderView.prototype, FolderView);
    _overrides.addOverride('FolderIcon', AppDisplay.FolderIcon.prototype, FolderIcon);
    _overrides.addOverride('AppIcon', AppDisplay.AppIcon.prototype, AppIcon);
    _overrides.addOverride('AppDisplay', AppDisplay.AppDisplay.prototype, AppDisplayCommon);
    _overrides.addOverride('AppViewItem', AppDisplay.AppViewItem.prototype, AppViewItemCommon);
    _overrides.addOverride('BaseAppViewCommon', AppDisplay.BaseAppView.prototype, BaseAppViewCommon);

    if (opt.ORIENTATION === Clutter.Orientation.VERTICAL) {
        _overrides.addOverride('AppDisplayVertical', AppDisplay.AppDisplay.prototype, AppDisplayVertical);
        _overrides.addOverride('BaseAppViewVertical', AppDisplay.BaseAppView.prototype, BaseAppViewVertical);
    }

    // Custom App Grid
    _overrides.addOverride('AppFolderDialog', AppDisplay.AppFolderDialog.prototype, AppFolderDialog);
    if (shellVersion >= 43) {
        // const defined class needs to be touched before real access
        AppDisplay.BaseAppViewGridLayout;
        _overrides.addOverride('BaseAppViewGridLayout', AppDisplay.BaseAppViewGridLayout.prototype, BaseAppViewGridLayout);
    }

    _setAppDisplayOrientation(opt.ORIENTATION === Clutter.Orientation.VERTICAL);
    _updateDND();
    if (!Main.sessionMode.isGreeter)
        _updateAppDisplayProperties();
}

function _setAppDisplayOrientation(vertical = false) {
    const CLUTTER_ORIENTATION = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
    const scroll = vertical ? 'vscroll' : 'hscroll';
    // app display to vertical has issues - page indicator not working
    // global appDisplay orientation switch is not built-in
    let appDisplay = Main.overview._overview._controls._appDisplay;
    // following line itself only changes in which axis will operate overshoot detection which switches appDisplay pages while dragging app icon to vertical
    appDisplay._orientation = CLUTTER_ORIENTATION;
    appDisplay._grid.layoutManager._orientation = CLUTTER_ORIENTATION;
    appDisplay._swipeTracker.orientation = CLUTTER_ORIENTATION;
    appDisplay._swipeTracker._reset();
    if (vertical) {
        appDisplay._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.EXTERNAL);

        // move and change orientation of page indicators
        const pageIndicators = appDisplay._pageIndicators;
        pageIndicators.vertical = true;
        appDisplay._box.vertical = false;
        pageIndicators.x_expand = false;
        pageIndicators.y_align = Clutter.ActorAlign.CENTER;
        pageIndicators.x_align = Clutter.ActorAlign.START;

        const scrollContainer = appDisplay._scrollView.get_parent();
        if (shellVersion < 43) {
            // remove touch friendly side navigation bars / arrows
            if (appDisplay._hintContainer && appDisplay._hintContainer.get_parent())
                scrollContainer.remove_child(appDisplay._hintContainer);
        } else {
            // moving these bars needs more patching of the appDisplay's code
            // for now we just change bars style to be more like vertically oriented arrows indicating direction to prev/next page
            appDisplay._nextPageIndicator.add_style_class_name('nextPageIndicator');
            appDisplay._prevPageIndicator.add_style_class_name('prevPageIndicator');
        }

        // setting their x_scale to 0 removes the arrows and avoid allocation issues compared to .hide() them
        appDisplay._nextPageArrow.scale_x = 0;
        appDisplay._prevPageArrow.scale_x = 0;
    } else {
        appDisplay._scrollView.set_policy(St.PolicyType.EXTERNAL, St.PolicyType.NEVER);
        if (_appDisplayScrollConId) {
            appDisplay._adjustment.disconnect(_appDisplayScrollConId);
            _appDisplayScrollConId = 0;
        }

        // restore original page indicators
        const pageIndicators = appDisplay._pageIndicators;
        pageIndicators.vertical = false;
        appDisplay._box.vertical = true;
        pageIndicators.x_expand = true;
        pageIndicators.y_align = Clutter.ActorAlign.END;
        pageIndicators.x_align = Clutter.ActorAlign.CENTER;

        // put back touch friendly navigation bars/buttons
        const scrollContainer = appDisplay._scrollView.get_parent();
        if (appDisplay._hintContainer && !appDisplay._hintContainer.get_parent()) {
            scrollContainer.add_child(appDisplay._hintContainer);
            // the hit container covers the entire app grid and added at the top of the stack blocks DND drops
            // so it needs to be pushed below
            scrollContainer.set_child_below_sibling(appDisplay._hintContainer, null);
        }

        appDisplay._nextPageArrow.scale_x = 1;
        appDisplay._prevPageArrow.scale_x = 1;

        appDisplay._nextPageIndicator.remove_style_class_name('nextPageIndicator');
        appDisplay._prevPageIndicator.remove_style_class_name('prevPageIndicator');
    }

    // value for page indicator is calculated from scroll adjustment, horizontal needs to be replaced by vertical
    appDisplay._adjustment = appDisplay._scrollView[scroll].adjustment;

    // no need to connect already connected signal (wasn't removed the original one before)
    if (!vertical) {
        // reset used appDisplay properties
        Main.overview._overview._controls._appDisplay.scale_y = 1;
        Main.overview._overview._controls._appDisplay.scale_x = 1;
        Main.overview._overview._controls._appDisplay.opacity = 255;
        return;
    }

    // update appGrid dot pages indicators
    _appDisplayScrollConId = appDisplay._adjustment.connect('notify::value', adj => {
        const value = adj.value / adj.page_size;
        appDisplay._pageIndicators.setCurrentPosition(value);
    });
}

// Set App Grid columns, rows, icon size, incomplete pages
function _updateAppDisplayProperties(reset = false) {
    opt._appGridNeedsRedisplay = false;
    // columns, rows, icon size
    const appDisplay = Main.overview._overview._controls._appDisplay;
    appDisplay.visible = true;
    if (reset) {
        appDisplay._grid.layoutManager.fixedIconSize = -1;
        appDisplay._grid.layoutManager.allow_incomplete_pages = true;
        appDisplay._grid._currentMode = -1;
        appDisplay._grid.setGridModes();
        if (_appGridLayoutSettings) {
            _appGridLayoutSettings.disconnect(_appGridLayoutConId);
            _appGridLayoutConId = 0;
            _appGridLayoutSettings = null;
        }
        appDisplay._redisplay();

        appDisplay._grid.set_style('');
        _updateAppGrid(reset);
    } else {
        // update grid on layout reset
        if (!_appGridLayoutSettings) {
            _appGridLayoutSettings = ExtensionUtils.getSettings('org.gnome.shell');
            _appGridLayoutConId = _appGridLayoutSettings.connect('changed::app-picker-layout', _updateLayout);
        }

        appDisplay._grid.layoutManager.allow_incomplete_pages = opt.APP_GRID_ALLOW_INCOMPLETE_PAGES;
        appDisplay._grid.set_style(`column-spacing: ${opt.APP_GRID_SPACING}px; row-spacing: ${opt.APP_GRID_SPACING}px;`);

        // force redisplay
        appDisplay._grid._currentMode = -1;
        appDisplay._grid.setGridModes();
        appDisplay._grid.layoutManager.fixedIconSize = opt.APP_GRID_ICON_SIZE;
        // avoid resetting appDisplay before startup animation
        // x11 shell restart skips startup animation
        if (!Main.layoutManager._startingUp) {
            _updateAppGrid();
        } else if (Main.layoutManager._startingUp && (Meta.is_restart() || _Util.dashIsDashToDock())) {
            _timeouts.three = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                _updateAppGrid();
                _timeouts.three = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}

function _updateDND(reset) {
    if (!reset) {
        if (!_appSystemStateConId && opt.APP_GRID_INCLUDE_DASH >= 3) {
            _appSystemStateConId = Shell.AppSystem.get_default().connect(
                'app-state-changed',
                () => {
                    _updateFolderIcons = true;
                    Main.overview._overview._controls._appDisplay._redisplay();
                }
            );
        }
    } else if (_appSystemStateConId) {
        Shell.AppSystem.get_default().disconnect(_appSystemStateConId);
        _appSystemStateConId = 0;
    }
    if (opt.APP_GRID_ORDER && !reset) {
        if (!_origAppViewItemAcceptDrop)
            _origAppViewItemAcceptDrop = AppDisplay.AppViewItem.prototype.acceptDrop;
        AppDisplay.AppViewItem.prototype.acceptDrop = () => false;
    } else if (_origAppViewItemAcceptDrop) {
        AppDisplay.AppViewItem.prototype.acceptDrop = _origAppViewItemAcceptDrop;
    }
}

function _restoreOverviewGroup() {
    Main.overview.dash.showAppsButton.checked = false;
    Main.layoutManager.overviewGroup.opacity = 255;
    Main.layoutManager.overviewGroup.scale_x = 1;
    Main.layoutManager.overviewGroup.scale_y = 1;
    Main.layoutManager.overviewGroup.hide();
    Main.overview._overview._controls._appDisplay.translation_x = 0;
    Main.overview._overview._controls._appDisplay.translation_y = 0;
    Main.overview._overview._controls._appDisplay.visible = true;
    Main.overview._overview._controls._appDisplay.opacity = 255;
}

// update all invalid positions that may be result of grid/icon size change
function _updateIconPositions() {
    const appDisplay = Main.overview._overview._controls._appDisplay;
    const layout = JSON.stringify(global.settings.get_value('app-picker-layout').recursiveUnpack());
    // if app grid layout is empty, sort source alphabetically to avoid misplacing
    if (layout === JSON.stringify([]) && appDisplay._sortOrderedItemsAlphabetically)
        appDisplay._sortOrderedItemsAlphabetically();
    const icons = [...appDisplay._orderedItems];
    for (let i = 0; i < icons.length; i++)
        appDisplay._moveItem(icons[i], -1, -1);
}

function _removeIcons() {
    const appDisplay = Main.overview._overview._controls._appDisplay;
    const icons = [...appDisplay._orderedItems];
    for (let i = 0; i < icons.length; i++) {
        const icon = icons[i];
        if (icon._dialog)
            Main.layoutManager.overviewGroup.remove_child(icon._dialog);
        appDisplay._removeItem(icon);
        icon.destroy();
    }
    appDisplay._folderIcons = [];
}

function _removeStatusMessage() {
    if (Settings._vShellStatusMessage) {
        if (Settings._vShellMessageTimeoutId) {
            GLib.source_remove(Settings._vShellMessageTimeoutId);
            Settings._vShellMessageTimeoutId = 0;
        }
        Settings._vShellStatusMessage.destroy();
        Settings._vShellStatusMessage = null;
    }
}

function _updateLayout(settings, key) {
    const currentValue = JSON.stringify(settings.get_value(key).deep_unpack());
    const emptyValue = JSON.stringify([]);
    const customLayout = currentValue !== emptyValue;
    if (!customLayout) {
        _updateAppGrid();
    }
}

function _updateAppGrid(reset = false) {
    const appDisplay = Main.overview._overview._controls._appDisplay;
    // reset the grid only if called directly without args or if all folders where removed by using reset button in Settings window
    // otherwise this function is called every time a user moves icon to another position as a settings callback

    // force update icon size using adaptToSize(), the page size cannot be the same as the current one
    appDisplay._grid.layoutManager._pageWidth += 1;
    appDisplay._grid.layoutManager.adaptToSize(appDisplay._grid.layoutManager._pageWidth - 1, appDisplay._grid.layoutManager._pageHeight);

    // don't delay the first screen lock on GS < 44, removing icons takes a time and with other 15 enabled extensions it can be multiplied by 15
    if (!Main.sessionMode.isLocked)
        _removeIcons();

    appDisplay._redisplay();

    // don't realize appDisplay on disable
    if (reset)
        return;

    // workaround - silently realize appDisplay
    // appDisplay and its content must be "visible" (opacity > 0) on the screen (within monitor geometry)
    // to realize its objects
    // this action takes some time and affects animations during the first use
    // if we do it invisibly before user needs it, it can improve the user's experience

    exposeAppGrid();

    // let the main loop process our changes before continuing
    _timeouts.one = GLib.idle_add(GLib.PRIORITY_LOW, () => {
        _updateIconPositions();
        if (appDisplay._sortOrderedItemsAlphabetically) {
            appDisplay._sortOrderedItemsAlphabetically();
            appDisplay._grid.layoutManager._pageWidth += 1;
            appDisplay._grid.layoutManager.adaptToSize(appDisplay._grid.layoutManager._pageWidth - 1, appDisplay._grid.layoutManager._pageHeight);
            appDisplay._setLinearPositions(appDisplay._orderedItems);
        }

        appDisplay._redisplay();

        if (reset) {
            _restoreOverviewGroup();
            _removeStatusMessage();
            return GLib.SOURCE_REMOVE;
        }
        // realize also all app folders (by opening them) so the first popup is as smooth as the second one
        // let the main loop process our changes before continuing
        _timeouts.two = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            restoreAppGrid();
            Settings._resetInProgress = false;
            _removeStatusMessage();
            _timeouts.two = 0;
            return GLib.SOURCE_REMOVE;
        });
        _timeouts.one = 0;
        return GLib.SOURCE_REMOVE;
    });
}

function exposeAppGrid() {
    const overviewGroup = Main.layoutManager.overviewGroup;
    if (!overviewGroup.visible) {
        // scale down the overviewGroup so it don't cover uiGroup
        overviewGroup.scale_y = 0.001;
        // make it invisible to the eye, but visible for the renderer
        overviewGroup.opacity = 1;
        // if overview is hidden, show it
        overviewGroup.visible = true;
    }

    const appDisplay = Main.overview._overview._controls._appDisplay;
    appDisplay.opacity = 1;

    // find usable value, sometimes it's one, sometime the other...
    const [x, y] = appDisplay.get_position();
    const { x1, y1 } = appDisplay.allocation;
    const translationX = x ? x : x1;
    const translationY = y ? y : y1;
    appDisplay.translation_x = -translationX;
    appDisplay.translation_y = -translationY;
    exposeAppFolders();
}

function exposeAppFolders() {
    const appDisplay = Main.overview._overview._controls._appDisplay;
    appDisplay._folderIcons.forEach(d => {
        d._ensureFolderDialog();
        d._dialog._updateFolderSize();
        d._dialog.scale_y = 0.0001;
        d._dialog.show();
    });
}

function restoreAppGrid() {
    const appDisplay = Main.overview._overview._controls._appDisplay;
    appDisplay.translation_x = 0;
    appDisplay.translation_y = 0;
    appDisplay.opacity = 0;
    hideAppFolders();

    const overviewGroup = Main.layoutManager.overviewGroup;
    if (!Main.overview._shown)
        overviewGroup.hide();
    overviewGroup.scale_y = 1;
    overviewGroup.opacity = 255;

    _removeStatusMessage();
}

function hideAppFolders() {
    const appDisplay = Main.overview._overview._controls._appDisplay;
    appDisplay._folderIcons.forEach(d => {
        d._dialog._updateFolderSize();
        d._dialog.hide();
        d._dialog.scale_y = 1;
    });
}

function _getWindowApp(metaWin) {
    const tracker = Shell.WindowTracker.get_default();
    return tracker.get_window_app(metaWin);
}

function _getAppLastUsedWindow(app) {
    let recentWin;
    global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null).forEach(metaWin => {
        const winApp = _getWindowApp(metaWin);
        if (!recentWin && winApp === app)
            recentWin = metaWin;
    });
    return recentWin;
}

function _getAppRecentWorkspace(app) {
    const recentWin = _getAppLastUsedWindow(app);
    if (recentWin)
        return recentWin.get_workspace();

    return null;
}

const AppDisplayVertical = {
    // correction of the appGrid size when page indicators were moved from the bottom to the right
    adaptToSize(width, height) {
        const [, indicatorWidth] = this._pageIndicators.get_preferred_width(-1);
        width -= indicatorWidth;

        this._grid.findBestModeForSize(width, height);

        const adaptToSize = AppDisplay.BaseAppView.prototype.adaptToSize.bind(this);
        adaptToSize(width, height);
    },
};

const AppDisplayCommon = {
    _ensureDefaultFolders() {
        // disable creation of default folders if user deleted them
    },

    _redisplay() {
        this._folderIcons.forEach(icon => {
            icon.view._redisplay();
        });

        BaseAppViewCommon._redisplay.bind(this)();
    },

    // apps load adapted for custom sorting and including dash items
    _loadApps() {
        let appIcons = [];
        const runningApps = Shell.AppSystem.get_default().get_running().map(a => a.id);

        this._appInfoList = Shell.AppSystem.get_default().get_installed().filter(appInfo => {
            try {
                appInfo.get_id(); // catch invalid file encodings
            } catch (e) {
                return false;
            }

            const appIsRunning = runningApps.includes(appInfo.get_id());
            const appIsFavorite = this._appFavorites.isFavorite(appInfo.get_id());
            const excludeApp = (opt.APP_GRID_EXCLUDE_RUNNING && appIsRunning) || (opt.APP_GRID_EXCLUDE_FAVORITES && appIsFavorite);

            return this._parentalControlsManager.shouldShowApp(appInfo) && !excludeApp;
        });

        let apps = this._appInfoList.map(app => app.get_id());

        let appSys = Shell.AppSystem.get_default();

        const appsInsideFolders = new Set();
        this._folderIcons = [];
        if (!opt.APP_GRID_ORDER) {
            let folders = this._folderSettings.get_strv('folder-children');
            folders.forEach(id => {
                let path = `${this._folderSettings.path}folders/${id}/`;
                let icon = this._items.get(id);
                if (!icon) {
                    icon = new AppDisplay.FolderIcon(id, path, this);
                    icon.connect('apps-changed', () => {
                        this._redisplay();
                        this._savePages();
                    });
                    icon.connect('notify::pressed', () => {
                        if (icon.pressed)
                            this.updateDragFocus(icon);
                    });
                } else if (_updateFolderIcons && opt.APP_GRID_EXCLUDE_RUNNING) {
                    // if any app changed its running state, update folder icon
                    icon.icon.update();
                }

                // remove empty folder icons
                if (!icon.visible) {
                    icon.destroy();
                    return;
                }

                appIcons.push(icon);
                this._folderIcons.push(icon);

                icon.getAppIds().forEach(appId => appsInsideFolders.add(appId));
            });
        }

        // reset request to update active icon
        _updateFolderIcons = false;

        // Allow dragging of the icon only if the Dash would accept a drop to
        // change favorite-apps. There are no other possible drop targets from
        // the app picker, so there's no other need for a drag to start,
        // at least on single-monitor setups.
        // This also disables drag-to-launch on multi-monitor setups,
        // but we hope that is not used much.
        const isDraggable =
            global.settings.is_writable('favorite-apps') ||
            global.settings.is_writable('app-picker-layout');

        apps.forEach(appId => {
            if (!opt.APP_GRID_ORDER && appsInsideFolders.has(appId))
                return;

            let icon = this._items.get(appId);
            if (!icon) {
                let app = appSys.lookup_app(appId);
                icon = new AppDisplay.AppIcon(app, { isDraggable });
                icon.connect('notify::pressed', () => {
                    if (icon.pressed)
                        this.updateDragFocus(icon);
                });
            }

            appIcons.push(icon);
        });

        // At last, if there's a placeholder available, add it
        if (this._placeholder)
            appIcons.push(this._placeholder);

        return appIcons;
    },

    // support active preview icons
    _onDragBegin(overview, source) {
        if (source._sourceItem)
            source = source._sourceItem;

        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this),
        };
        DND.addDragMonitor(this._dragMonitor);
        if (shellVersion < 43)
            this._slideSidePages(AppDisplay.SidePages.PREVIOUS | AppDisplay.SidePages.NEXT | AppDisplay.SidePages.DND);
        else
            this._appGridLayout.showPageIndicators();
        this._dragFocus = null;
        this._swipeTracker.enabled = false;

        // When dragging from a folder dialog, the dragged app icon doesn't
        // exist in AppDisplay. We work around that by adding a placeholder
        // icon that is either destroyed on cancel, or becomes the effective
        // new icon when dropped.
        if (AppDisplay._getViewFromIcon(source) instanceof AppDisplay.FolderView ||
            (opt.APP_GRID_EXCLUDE_FAVORITES && this._appFavorites.isFavorite(source.id)))
            this._ensurePlaceholder(source);
    },

    _ensurePlaceholder(source) {
        if (this._placeholder)
            return;

        if (source._sourceItem)
            source = source._sourceItem;

        const appSys = Shell.AppSystem.get_default();
        const app = appSys.lookup_app(source.id);

        const isDraggable =
            global.settings.is_writable('favorite-apps') ||
            global.settings.is_writable('app-picker-layout');

        this._placeholder = new AppDisplay.AppIcon(app, { isDraggable });
        this._placeholder.connect('notify::pressed', () => {
            if (this._placeholder?.pressed)
                this.updateDragFocus(this._placeholder);
        });
        this._placeholder.scaleAndFade();
        this._redisplay();
    },

    // accept source from active preview
    acceptDrop(source) {
        if (opt.APP_GRID_ORDER)
            return false;
        if (source._sourceItem)
            source = source._sourceItem;

        let dropTarget = null;
        if (shellVersion >= 43) {
            dropTarget = this._dropTarget;
            delete this._dropTarget;
        }

        if (!this._canAccept(source))
            return false;

        if ((shellVersion < 43 && this._dropPage) ||
            (shellVersion >= 43 && (dropTarget === this._prevPageIndicator ||
            dropTarget === this._nextPageIndicator))) {
            let increment;

            if (shellVersion < 43)
                increment = this._dropPage === AppDisplay.SidePages.NEXT ? 1 : -1;
            else
                increment = dropTarget === this._prevPageIndicator ? -1 : 1;

            const { currentPage, nPages } = this._grid;
            const page = Math.min(currentPage + increment, nPages);
            const position = page < nPages ? -1 : 0;

            this._moveItem(source, page, position);
            this.goToPage(page);
        } else if (this._delayedMoveData) {
            // Dropped before the icon was moved
            const { page, position } = this._delayedMoveData;

            try {
                this._moveItem(source, page, position);
            } catch (e) {
                log(`Warning:${e}`);
            }
            this._removeDelayedMove();
        }

        this._savePages();

        let view = AppDisplay._getViewFromIcon(source);
        if (view instanceof AppDisplay.FolderView)
            view.removeApp(source.app);

        if (this._currentDialog)
            this._currentDialog.popdown();

        if (opt.APP_GRID_EXCLUDE_FAVORITES && this._appFavorites.isFavorite(source.id))
            this._appFavorites.removeFavorite(source.id);

        return true;
    },
};

const BaseAppViewVertical = {
    after__init() {
        this._grid.layoutManager._orientation = Clutter.Orientation.VERTICAL;
        this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.EXTERNAL);
        this._orientation = Clutter.Orientation.VERTICAL;
        this._swipeTracker.orientation = Clutter.Orientation.VERTICAL;
        this._swipeTracker._reset();
        this._pageIndicators.vertical = true;
        this._box.vertical = false;
        this._pageIndicators.x_expand = false;
        this._pageIndicators.y_align = Clutter.ActorAlign.CENTER;
        this._pageIndicators.x_align = Clutter.ActorAlign.START;
        this._pageIndicators.set_style('margin-right: 10px;');
        const scrollContainer = this._scrollView.get_parent();
        if (shellVersion < 43) {
            // remove touch friendly side navigation bars / arrows
            if (this._hintContainer && this._hintContainer.get_parent())
                scrollContainer.remove_child(this._hintContainer);
        } else {
            // moving these bars needs more patching of the this's code
            // for now we just change bars style to be more like vertically oriented arrows indicating direction to prev/next page
            this._nextPageIndicator.add_style_class_name('nextPageIndicator');
            this._prevPageIndicator.add_style_class_name('prevPageIndicator');
        }

        // setting their x_scale to 0 removes the arrows and avoid allocation issues compared to .hide() them
        this._nextPageArrow.scale_x = 0;
        this._prevPageArrow.scale_x = 0;

        this._adjustment = this._scrollView.vscroll.adjustment;

        this._adjustment.connect('notify::value', adj => {
            const value = adj.value / adj.page_size;
            this._pageIndicators.setCurrentPosition(value);
        });
    },
    // <= 42 only, this fixes dnd from appDisplay to the workspace thumbnail on the left if appDisplay is on page 1 because of appgrid left overshoot
    _pageForCoords() {
        return AppDisplay.SidePages.NONE;
    },
};

const BaseAppViewCommon = {
    _sortOrderedItemsAlphabetically(icons = null) {
        if (!icons)
            icons = this._orderedItems;
        icons.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    },

    _setLinearPositions(icons) {
        const { itemsPerPage } = this._grid;
        icons.forEach((icon, i) => {
            const page = Math.floor(i / itemsPerPage);
            const position = i % itemsPerPage;
            try {
                this._moveItem(icon, page, position);
            } catch (e) {
                log(`Warning:${e}`);
            }
        });
    },

    // adds sorting options and option to add favorites and running apps
    _redisplay() {
        let oldApps = this._orderedItems.slice();
        let oldAppIds = oldApps.map(icon => icon.id);

        let newApps = this._loadApps().sort(this._compareItems.bind(this));
        let newAppIds = newApps.map(icon => icon.id);

        let addedApps = newApps.filter(icon => !oldAppIds.includes(icon.id));
        let removedApps = oldApps.filter(icon => !newAppIds.includes(icon.id));

        // Remove old app icons
        removedApps.forEach(icon => {
            this._removeItem(icon);
            icon.destroy();
        });

        // Add new app icons, or move existing ones
        newApps.forEach(icon => {
            const [page, position] = this._getItemPosition(icon);
            if (addedApps.includes(icon)) {
                this._addItem(icon, page, position);
            } else if (page !== -1 && position !== -1) {
                this._moveItem(icon, page, position);
            } else {
                // App is part of a folder
            }
        });

        // sort all alphabetically
        if (opt.APP_GRID_ORDER > 0) {
            // const { itemsPerPage } = this._grid;
            let appIcons = this._orderedItems;
            this._sortOrderedItemsAlphabetically(appIcons);
            // appIcons.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
            // then sort used apps by usage
            if (opt.APP_GRID_ORDER === 2)
                appIcons.sort((a, b) => Shell.AppUsage.get_default().compare(a.app.id, b.app.id));

            // sort favorites first
            if (opt.APP_GRID_DASH_FIRST) {
                const fav = Object.keys(this._appFavorites._favorites);
                appIcons.sort((a, b) => {
                    let aFav = fav.indexOf(a.id);
                    if (aFav < 0)
                        aFav = 999;
                    let bFav = fav.indexOf(b.id);
                    if (bFav < 0)
                        bFav = 999;
                    return bFav < aFav;
                });
            }

            // sort running first
            if (opt.APP_GRID_DASH_FIRST)
                appIcons.sort((a, b) => a.app.get_state() !== Shell.AppState.RUNNING && b.app.get_state() === Shell.AppState.RUNNING);

            this._setLinearPositions(appIcons);

            this._orderedItems = appIcons;
        }

        this.emit('view-loaded');
        if (!opt.APP_GRID_ALLOW_INCOMPLETE_PAGES) {
            for (let i = 0; i < this._grid.nPages; i++)
                this._grid.layoutManager._fillItemVacancies(i);
        }
    },

    _canAccept(source) {
        return opt.APP_GRID_ORDER ? false : source instanceof AppDisplay.AppViewItem;
    },

    // support active preview icons
    acceptDrop(source) {
        if (!this._canAccept(source))
            return false;

        if (source._sourceItem)
            source = source._sourceItem;


        if (this._dropPage) {
            const increment = this._dropPage === AppDisplay.SidePages.NEXT ? 1 : -1;
            const { currentPage, nPages } = this._grid;
            const page = Math.min(currentPage + increment, nPages);
            const position = page < nPages ? -1 : 0;

            this._moveItem(source, page, position);
            this.goToPage(page);
        } else if (this._delayedMoveData) {
            // Dropped before the icon was moved
            const { page, position } = this._delayedMoveData;

            this._moveItem(source, page, position);
            this._removeDelayedMove();
        }

        return true;
    },

    // support active preview icons
    _onDragMotion(dragEvent) {
        if (!(dragEvent.source instanceof AppDisplay.AppViewItem))
            return DND.DragMotionResult.CONTINUE;

        if (dragEvent.source._sourceItem)
            dragEvent.source = dragEvent.source._sourceItem;

        const appIcon = dragEvent.source;

        if (shellVersion < 43) {
            this._dropPage = this._pageForCoords(dragEvent.x, dragEvent.y);
            if (this._dropPage &&
               this._dropPage === AppDisplay.SidePages.PREVIOUS &&
               this._grid.currentPage === 0) {
                delete this._dropPage;
                return DND.DragMotionResult.NO_DROP;
            }
        }

        if (appIcon instanceof AppDisplay.AppViewItem) {
            if (shellVersion < 44) {
                // Handle the drag overshoot. When dragging to above the
                // icon grid, move to the page above; when dragging below,
                // move to the page below.
                this._handleDragOvershoot(dragEvent);
            } else if (!this._dragMaybeSwitchPageImmediately(dragEvent)) {
                // Two ways of switching pages during DND:
                // 1) When "bumping" the cursor against the monitor edge, we switch
                //    page immediately.
                // 2) When hovering over the next-page indicator for a certain time,
                //    we also switch page.

                const { targetActor } = dragEvent;

                if (targetActor === this._prevPageIndicator ||
                            targetActor === this._nextPageIndicator)
                    this._maybeSetupDragPageSwitchInitialTimeout(dragEvent);
                else
                    this._resetDragPageSwitch();
            }
        }

        this._maybeMoveItem(dragEvent);

        return DND.DragMotionResult.CONTINUE;
    },

    // adjustable page width for GS <= 42
    adaptToSize(width, height, isFolder = false) {
        let box = new Clutter.ActorBox({
            x2: width,
            y2: height,
        });
        box = this.get_theme_node().get_content_box(box);
        box = this._scrollView.get_theme_node().get_content_box(box);
        box = this._grid.get_theme_node().get_content_box(box);

        const availWidth = box.get_width();
        const availHeight = box.get_height();

        let pageWidth, pageHeight;

        pageHeight = availHeight;
        pageWidth = Math.ceil(availWidth * (isFolder ? 1 : opt.APP_GRID_PAGE_WIDTH_SCALE));
        // subtract space for navigation arrows in horizontal mode
        pageWidth -= opt.ORIENTATION ? 0 : 128;

        this._grid.layout_manager.pagePadding.left =
                Math.floor(availWidth * 0.02);
        this._grid.layout_manager.pagePadding.right =
                Math.ceil(availWidth * 0.02);

        this._grid.adaptToSize(pageWidth, pageHeight);

        const leftPadding = Math.floor(
            (availWidth - this._grid.layout_manager.pageWidth) / 2);
        const rightPadding = Math.ceil(
            (availWidth - this._grid.layout_manager.pageWidth) / 2);
        const topPadding = Math.floor(
            (availHeight - this._grid.layout_manager.pageHeight) / 2);
        const bottomPadding = Math.ceil(
            (availHeight - this._grid.layout_manager.pageHeight) / 2);

        this._scrollView.content_padding = new Clutter.Margin({
            left: leftPadding,
            right: rightPadding,
            top: topPadding,
            bottom: bottomPadding,
        });

        this._availWidth = availWidth;
        this._availHeight = availHeight;

        this._pageIndicatorOffset = leftPadding;
        this._pageArrowOffset = Math.max(
            leftPadding - 80, 0); // 80 is AppDisplay.PAGE_PREVIEW_MAX_ARROW_OFFSET
    },
};

const BaseAppViewGridLayout = {
    _getIndicatorsWidth(box) {
        const [width, height] = box.get_size();
        const arrows = [
            this._nextPageArrow,
            this._previousPageArrow,
        ];

        const minArrowsWidth = arrows.reduce(
            (previousWidth, accessory) => {
                const [min] = accessory.get_preferred_width(height);
                return Math.max(previousWidth, min);
            }, 0);

        const idealIndicatorWidth = (width * 0.1/* PAGE_PREVIEW_RATIO*/) / 2;

        return Math.max(idealIndicatorWidth, minArrowsWidth);
    },
};

const FolderIcon = {
    after__init() {
        /* // If folder preview icons are clickable,
        // disable opening the folder with primary mouse button and enable the secondary one
         const buttonMask = opt.APP_GRID_ACTIVE_PREVIEW
            ? St.ButtonMask.TWO | St.ButtonMask.THREE
            : St.ButtonMask.ONE | St.ButtonMask.TWO;
        this.button_mask = buttonMask;*/
        this.button_mask = St.ButtonMask.ONE | St.ButtonMask.TWO;
    },

    open() {
        this._ensureFolderDialog();
        if (this._dialog._designCapacity !== this.view._orderedItems.length)
            this._dialog._updateFolderSize();

        this.view._scrollView.vscroll.adjustment.value = 0;
        this._dialog.popup();
    },
};

const FolderView = {
    _createGrid() {
        let grid;
        if (shellVersion < 43)
            grid = new FolderGrid();
        else
            grid = new FolderGrid43();

        return grid;
    },

    createFolderIcon(size) {
        const layout = new Clutter.GridLayout({
            row_homogeneous: true,
            column_homogeneous: true,
        });

        let icon = new St.Widget({
            layout_manager: layout,
            x_align: Clutter.ActorAlign.CENTER,
            style: `width: ${size}px; height: ${size}px;`,
        });

        const numItems = this._orderedItems.length;
        // decide what number of icons switch to 3x3 grid
        // APP_GRID_FOLDER_ICON_GRID: 3 -> more than 4
        //                          : 4 -> more than 8
        const threshold = opt.APP_GRID_FOLDER_ICON_GRID % 3 ? 8 : 4;
        const gridSize = opt.APP_GRID_FOLDER_ICON_GRID > 2 && numItems > threshold ? 3 : 2;
        const FOLDER_SUBICON_FRACTION = gridSize === 2 ? 0.4 : 0.27;

        let subSize = Math.floor(FOLDER_SUBICON_FRACTION * size);
        let rtl = icon.get_text_direction() === Clutter.TextDirection.RTL;
        for (let i = 0; i < gridSize * gridSize; i++) {
            const style = `width: ${subSize}px; height: ${subSize}px;`;
            let bin = new St.Bin({ style, reactive: true });
            bin.pivot_point = new Graphene.Point({ x: 0.5, y: 0.5 });
            if (i < numItems) {
                if (!opt.APP_GRID_ACTIVE_PREVIEW) {
                    bin.child = this._orderedItems[i].app.create_icon_texture(subSize);
                } else {
                    const app = this._orderedItems[i].app;
                    const child = new ActiveFolderIcon(app);
                    child._sourceItem = this._orderedItems[i];
                    child._sourceFolder = this;
                    child.icon.style_class = '';
                    child.icon.set_style('margin: 0; padding: 0;');
                    child.icon.setIconSize(subSize);

                    bin.child = child;

                    bin.connect('enter-event', () => {
                        bin.ease({
                            duration: 100,
                            scale_x: 1.14,
                            scale_y: 1.14,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    });
                    bin.connect('leave-event', () => {
                        bin.ease({
                            duration: 100,
                            scale_x: 1,
                            scale_y: 1,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    });
                }
            }

            layout.attach(bin, rtl ? (i + 1) % gridSize : i % gridSize, Math.floor(i / gridSize), 1, 1);
        }

        // if folder content changed, update folder size, but not if it's empty
        /* if (this._dialog && this._dialog._designCapacity !== this._orderedItems.length && this._orderedItems.length)
            this._dialog._updateFolderSize();*/

        return icon;
    },

    // this just overrides _redisplay() for GS < 44
    _redisplay() {
        // super._redisplay(); - super doesn't work in my overrides
        AppDisplay.BaseAppView.prototype._redisplay.bind(this)();
    },

    _loadApps() {
        this._apps = [];
        const excludedApps = this._folder.get_strv('excluded-apps');
        const appSys = Shell.AppSystem.get_default();
        const addAppId = appId => {
            if (excludedApps.includes(appId))
                return;

            if (opt.APP_GRID_EXCLUDE_FAVORITES && this._appFavorites.isFavorite(appId))
                return;

            const app = appSys.lookup_app(appId);
            if (!app)
                return;

            if (opt.APP_GRID_EXCLUDE_RUNNING) {
                const runningApps = Shell.AppSystem.get_default().get_running().map(a => a.id);
                if (runningApps.includes(appId))
                    return;
            }

            if (!this._parentalControlsManager.shouldShowApp(app.get_app_info()))
                return;

            if (this._apps.indexOf(app) !== -1)
                return;

            this._apps.push(app);
        };

        const folderApps = this._folder.get_strv('apps');
        folderApps.forEach(addAppId);

        const folderCategories = this._folder.get_strv('categories');
        const appInfos = this._parentView.getAppInfos();
        appInfos.forEach(appInfo => {
            let appCategories = AppDisplay._getCategories(appInfo);
            if (!AppDisplay._listsIntersect(folderCategories, appCategories))
                return;

            addAppId(appInfo.get_id());
        });

        let items = [];
        this._apps.forEach(app => {
            let icon = this._items.get(app.get_id());
            if (!icon)
                icon = new AppDisplay.AppIcon(app);

            items.push(icon);
        });
        this._appIds = this._apps.map(app => app.get_id());
        return items;
    },

    // 42 only - don't apply appGrid scale on folders
    adaptToSize(width, height) {
        if (!opt.ORIENTATION) {
            const [, indicatorHeight] = this._pageIndicators.get_preferred_height(-1);
            height -= indicatorHeight;
        }
        BaseAppViewCommon.adaptToSize.bind(this)(width, height, true);
    },
};

// folder columns and rows
const FolderGrid = GObject.registerClass(
class FolderGrid extends IconGrid.IconGrid {
    _init() {
        super._init({
            allow_incomplete_pages: false,
            // For adaptive size (0), set the numbers high enough to fit all the icons
            // to avoid splitting the icons to pages
            columns_per_page: opt.APP_GRID_FOLDER_COLUMNS ? opt.APP_GRID_FOLDER_COLUMNS : 20,
            rows_per_page: opt.APP_GRID_FOLDER_ROWS ? opt.APP_GRID_FOLDER_ROWS : 20,
            page_halign: Clutter.ActorAlign.CENTER,
            page_valign: Clutter.ActorAlign.CENTER,
        });
        this.layout_manager._isFolder = true;
        // if (!opt.APP_GRID_FOLDER_DEFAULT)
        const spacing = opt.APP_GRID_SPACING;
        this.set_style(`column-spacing: ${spacing}px; row-spacing: ${spacing}px;`);
        this.layoutManager.fixedIconSize = opt.APP_GRID_FOLDER_ICON_SIZE;
    }

    adaptToSize(width, height) {
        this.layout_manager.adaptToSize(width, height);
    }
});


let FolderGrid43;
// first reference to constant defined using const in other module returns undefined, the AppGrid const will remain empty and unused
const AppGrid = AppDisplay.AppGrid;
if (AppDisplay.AppGrid) {
    FolderGrid43 = GObject.registerClass(
    class FolderGrid43 extends AppDisplay.AppGrid {
        _init() {
            super._init({
                allow_incomplete_pages: false,
                columns_per_page: opt.APP_GRID_FOLDER_COLUMNS ? opt.APP_GRID_FOLDER_COLUMNS : 20,
                rows_per_page: opt.APP_GRID_FOLDER_ROWS ? opt.APP_GRID_FOLDER_ROWS : 20,
                page_halign: Clutter.ActorAlign.CENTER,
                page_valign: Clutter.ActorAlign.CENTER,
            });
            this.layout_manager._isFolder = true;
            const spacing = opt.APP_GRID_SPACING;
            this.set_style(`column-spacing: ${spacing}px; row-spacing: ${spacing}px;`);
            this.layoutManager.fixedIconSize = opt.APP_GRID_FOLDER_ICON_SIZE;

            this.setGridModes([
                {
                    columns: opt.APP_GRID_FOLDER_COLUMNS ? opt.APP_GRID_FOLDER_COLUMNS : 3,
                    rows: opt.APP_GRID_FOLDER_ROWS ? opt.APP_GRID_FOLDER_ROWS : 3,
                },
            ]);
        }

        adaptToSize(width, height) {
            this.layout_manager.adaptToSize(width, height);
        }
    });
}

const FOLDER_DIALOG_ANIMATION_TIME = 200; // AppDisplay.FOLDER_DIALOG_ANIMATION_TIME
const AppFolderDialog = {
    // injection to _init()
    after__init() {
        this._viewBox.add_style_class_name('app-folder-dialog-vshell');

        // delegate this dialog to the FolderIcon._view
        // so its _createFolderIcon function can update the dialog if folder content changed
        this._view._dialog = this;

        // right click into the folder popup should close it
        this.child.reactive = true;
        const clickAction = new Clutter.ClickAction();
        clickAction.connect('clicked', act => {
            if (act.get_button() === Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_STOP;
            const [x, y] = clickAction.get_coords();
            const actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
            // if it's not entry for editing folder title
            if (actor !== this._entry)
                this.popdown();
            return Clutter.EVENT_STOP;
        });

        this.child.add_action(clickAction);
    },

    after__addFolderNameEntry() {
        // Edit button
        this._removeButton = new St.Button({
            style_class: 'edit-folder-button',
            button_mask: St.ButtonMask.ONE,
            toggle_mode: false,
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'user-trash-symbolic',
                icon_size: 16,
            }),
        });

        this._removeButton.connect('clicked', () => {
            if (Date.now() - this._removeButton._lastClick < Clutter.Settings.get_default().double_click_time) {
                this._grabHelper.ungrab({ actor: this });
                // without hiding the dialog, Shell crashes (at least on X11)
                this.hide();
                this._view._deletingFolder = true;

                // Resetting all keys deletes the relocatable schema
                let keys = this._folder.settings_schema.list_keys();
                for (const key of keys)
                    this._folder.reset(key);

                let settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders' });
                let folders = settings.get_strv('folder-children');
                folders.splice(folders.indexOf(this._view._id), 1);

                // remove all abandoned folders (usually my own garbage and unwanted default folders...)
                /* const appFolders = this._appDisplay._folderIcons.map(icon => icon._id);
                folders.forEach(folder => {
                    if (!appFolders.includes(folder)) {
                        folders.splice(folders.indexOf(folder._id), 1);
                    }
                });*/
                settings.set_strv('folder-children', folders);

                this._view._deletingFolder = false;
                return;
            }
            this._removeButton._lastClick = Date.now();
        });

        this._entryBox.add_child(this._removeButton);
    },

    popup() {
        if (this._isOpen)
            return;

        this._isOpen = this._grabHelper.grab({
            actor: this,
            onUngrab: () => this.popdown(),
        });

        if (!this._isOpen)
            return;

        this.get_parent().set_child_above_sibling(this, null);

        this._needsZoomAndFade = true;

        // ensure correct folder size
        // if (this._needsUpdateSize) {
        this._updateFolderSize();
        this._view._redisplay();
        // this._needsUpdateSize = false;
        // }

        this.show();

        this.emit('open-state-changed', true);
    },

    _updateFolderSize() {
        const view = this._view;
        const [firstItem] = view._grid.layoutManager._container;
        if (!firstItem)
            return;
        // adapt folder size according to the settings and number of icons
        const appDisplay = this._source._parentView;
        if (!appDisplay.width || appDisplay.allocation.x2 === Infinity || appDisplay.allocation.x2 === -Infinity) {
            return;
        }

        view._grid.layoutManager.fixedIconSize = opt.APP_GRID_FOLDER_ICON_SIZE;
        view._grid.set_style(`column-spacing: ${opt.APP_GRID_SPACING}px; row-spacing: ${opt.APP_GRID_SPACING}px;`);

        const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
        const itemPadding = 55; // default icon item padding on Fedora 44
        // const dialogMargin = 30;
        const nItems = view._orderedItems.length;
        let columns = opt.APP_GRID_FOLDER_COLUMNS;
        let rows = opt.APP_GRID_FOLDER_ROWS;
        const fullAdaptive = !columns && !rows && opt.APP_GRID_FOLDER_ICON_SIZE < 0;
        let spacing = opt.APP_GRID_SPACING;
        const minItemSize = 48 + itemPadding;

        if (fullAdaptive) {
            columns = Math.ceil(Math.sqrt(nItems));
            rows = columns;
            if (columns * (columns - 1) >= nItems) {
                rows = columns - 1;
            } else if ((columns + 1) * (columns - 1) >= nItems) {
                rows = columns - 1;
                columns += 1;
            }
        } else if (!columns && rows) {
            columns = Math.ceil(nItems / rows);
        } else if (columns && !rows) {
            rows = Math.ceil(nItems / columns);
        }

        const iconSize = opt.APP_GRID_FOLDER_ICON_SIZE < 0 ? opt.APP_GRID_FOLDER_ICON_SIZE_DEFAULT : opt.APP_GRID_FOLDER_ICON_SIZE;
        let itemSize = iconSize + 55; // icon padding
        // first run sets the grid before we can read the real icon size
        // so we estimate the size from default properties
        // and correct it in the second run
        // const [firstItem] = view._grid.layoutManager._container;
        firstItem.icon.setIconSize(iconSize);
        const [firstItemWidth] = firstItem.get_preferred_size();
        const realSize = firstItemWidth / scaleFactor;
        // if the preferred item size is smaller than icon, ignore it
        if (realSize > iconSize)
            itemSize = realSize;
        else
            this._needsUpdateSize = true;

        let width = columns * (itemSize + spacing) + /* padding for nav arrows*/64;
        width = Math.round(width + (opt.ORIENTATION ? 100 : 160/* space for navigation arrows*/));
        let height = rows * (itemSize + spacing) + /* header*/75 + /* padding + ?page indicator*/(!opt.ORIENTATION || !opt.APP_GRID_FOLDER_COLUMNS ? 100 : 70);

        // allocation is more reliable than appDisplay width/height properties
        const appDisplayWidth = appDisplay.allocation.x2 - appDisplay.allocation.x1;
        const appDisplayHeight = appDisplay.allocation.y2 - appDisplay.allocation.y1 + (opt.SHOW_SEARCH_ENTRY ? Main.overview._overview.controls._searchEntryBin.height : 0);

        // folder must fit the appDisplay area
        // reduce columns/rows if needed and count with the scaled values
        if (!opt.APP_GRID_FOLDER_ROWS) {
            while ((height * scaleFactor) > appDisplayHeight) {
                height -= itemSize + spacing;
                rows -= 1;
            }
        }

        if (!opt.APP_GRID_FOLDER_COLUMNS) {
            while ((width * scaleFactor) > appDisplayWidth) {
                width -= itemSize + spacing;
                columns -= 1;
            }
        }
        // try to compensate for the previous reduction if there is a space
        if (!opt.APP_GRID_FOLDER_COLUMNS) {
            while ((nItems > columns * rows) && ((width * scaleFactor + itemSize + spacing) <= appDisplayWidth)) {
                width += itemSize + spacing;
                columns += 1;
            }
            // remove columns that cannot be displayed
            if ((columns * minItemSize  + (columns - 1) * spacing) > appDisplayWidth)
                columns = Math.floor(appDisplayWidth / (minItemSize + spacing));
        }
        if (!opt.APP_GRID_FOLDER_ROWS) {
            while ((nItems > columns * rows) && ((height * scaleFactor + itemSize + spacing) <= appDisplayHeight)) {
                height += itemSize + spacing;
                rows += 1;
            }
            // remove rows that cannot be displayed
            if ((rows * minItemSize  + (rows - 1) * spacing) > appDisplayHeight)
                rows = Math.floor(appDisplayWidth / (minItemSize + spacing));
        }

        width = Math.clamp(width, 540, appDisplayWidth);
        height = Math.min(height, appDisplayHeight);

        const layoutManager = view._grid.layoutManager;
        layoutManager.rows_per_page = rows;
        layoutManager.columns_per_page = columns;

        // this line is required by GS 43
        view._grid.setGridModes([{ columns, rows }]);

        this.child.set_style(`
            width: ${width}px;
            height: ${height}px;
            padding: 30px;
        `);

        view._redisplay();

        // store original item count
        this._designCapacity = nItems;
    },

    _zoomAndFadeIn() {
        let [sourceX, sourceY] =
            this._source.get_transformed_position();
        let [dialogX, dialogY] =
            this.child.get_transformed_position();

        const sourceCenterX = sourceX + this._source.width / 2;
        const sourceCenterY = sourceY + this._source.height / 2;

        // this. covers the whole screen
        let dialogTargetX = dialogX;
        let dialogTargetY = dialogY;

        const appDisplay = this._source._parentView;

        if (!opt.APP_GRID_FOLDER_CENTER) {
            const [appDisplayX, appDisplayY] = this._source._parentView.get_transformed_position();

            dialogTargetX = sourceCenterX - this.child.width / 2;
            dialogTargetY = sourceCenterY - this.child.height / 2;

            // keep the dialog in appDisplay area if possible
            dialogTargetX = Math.clamp(
                dialogTargetX,
                appDisplayX,
                appDisplayX + appDisplay.width - this.child.width
            );

            dialogTargetY = Math.clamp(
                dialogTargetY,
                appDisplayY,
                appDisplayY + appDisplay.height - this.child.height
            );
        } else {
            dialogTargetX = appDisplay.x + appDisplay.width / 2 - this.child.width / 2;
            dialogTargetY = appDisplay.y + appDisplay.height / 2 - this.child.height / 2;
        }

        const dialogOffsetX = Math.round(dialogTargetX - dialogX);
        const dialogOffsetY = Math.round(dialogTargetY - dialogY);

        this.child.set({
            translation_x: sourceX - dialogX,
            translation_y: sourceY - dialogY,
            scale_x: this._source.width / this.child.width,
            scale_y: this._source.height / this.child.height,
            opacity: 0,
        });

        this.child.ease({
            translation_x: dialogOffsetX,
            translation_y: dialogOffsetY,
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        appDisplay.ease({
            opacity: 0,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        if (opt.SHOW_SEARCH_ENTRY) {
            Main.overview.searchEntry.ease({
                opacity: 0,
                duration: FOLDER_DIALOG_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._needsZoomAndFade = false;

        if (this._sourceMappedId === 0) {
            this._sourceMappedId = this._source.connect(
                'notify::mapped', this._zoomAndFadeOut.bind(this));
        }
    },

    _zoomAndFadeOut() {
        if (!this._isOpen)
            return;

        if (!this._source.mapped) {
            this.hide();
            return;
        }

        // if the dialog was shown silently, skip animation
        if (this.scale_y < 1) {
            this._needsZoomAndFade = false;
            this.hide();
            this._popdownCallbacks.forEach(func => func());
            this._popdownCallbacks = [];
            return;
        }

        let [sourceX, sourceY] =
            this._source.get_transformed_position();
        let [dialogX, dialogY] =
            this.child.get_transformed_position();

        this.child.ease({
            translation_x: sourceX - dialogX + this.child.translation_x,
            translation_y: sourceY - dialogY + this.child.translation_y,
            scale_x: this._source.width / this.child.width,
            scale_y: this._source.height / this.child.height,
            opacity: 0,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.child.set({
                    translation_x: 0,
                    translation_y: 0,
                    scale_x: 1,
                    scale_y: 1,
                    opacity: 255,
                });
                this.hide();

                this._popdownCallbacks.forEach(func => func());
                this._popdownCallbacks = [];
            },
        });

        const appDisplay = this._source._parentView;
        appDisplay.ease({
            opacity: 255,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        if (opt.SHOW_SEARCH_ENTRY) {
            Main.overview.searchEntry.ease({
                opacity: 255,
                duration: FOLDER_DIALOG_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._needsZoomAndFade = false;
    },

    _setLighterBackground(lighter) {
        if (this._isOpen)
            Main.overview._overview._controls._appDisplay.opacity = lighter ? 20 : 0;
        /* const backgroundColor = lighter
            ? DIALOG_SHADE_HIGHLIGHT
            : DIALOG_SHADE_NORMAL;

        this.ease({
            backgroundColor,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        }); */
    },
};

const AppIcon = {
    after__init() {
        // update the app label behavior
        this._updateMultiline();
    },

    // avoid accepting by placeholder when dragging active preview
    // and also by icon if alphabet or usage sorting are used
    _canAccept(source) {
        if (source._sourceItem)
            source = source._sourceItem;
        let view = AppDisplay._getViewFromIcon(source);

        return source !== this &&
               (source instanceof this.constructor) &&
               (view instanceof AppDisplay.AppDisplay &&
                !opt.APP_GRID_ORDER);
    },
};

const AppViewItemCommon = {
    _updateMultiline() {
        const { label } = this.icon;
        if (label)
            label.opacity = 255;
        if (!this._expandTitleOnHover || !this.icon.label)
            return;

        const { clutterText } = label;

        const isHighlighted = this.has_key_focus() || this.hover || this._forcedHighlight;

        if (opt.APP_GRID_NAMES_MODE === 2 && this._expandTitleOnHover) { // !_expandTitleOnHover indicates search result icon
            label.opacity = isHighlighted || !this.app ? 255 : 0;
        }
        if (isHighlighted)
            this.get_parent()?.set_child_above_sibling(this, null);

        if (!opt.APP_GRID_NAMES_MODE) {
            const layout = clutterText.get_layout();
            if (!layout.is_wrapped() && !layout.is_ellipsized())
                return;
        }

        label.remove_transition('allocation');

        const id = label.connect('notify::allocation', () => {
            label.restore_easing_state();
            label.disconnect(id);
        });

        const expand = opt.APP_GRID_NAMES_MODE === 1 || this._forcedHighlight || this.hover || this.has_key_focus();

        label.save_easing_state();
        label.set_easing_duration(expand
            ? AppDisplay.APP_ICON_TITLE_EXPAND_TIME
            : AppDisplay.APP_ICON_TITLE_COLLAPSE_TIME);
        clutterText.set({
            line_wrap: expand,
            line_wrap_mode: expand ? Pango.WrapMode.WORD_CHAR : Pango.WrapMode.NONE,
            ellipsize: expand ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END,
        });
    },

    // support active preview icons
    acceptDrop(source, _actor, x) {
        if (opt.APP_GRID_ORDER)
            return DND.DragMotionResult.NO_DROP;

        this._setHoveringByDnd(false);

        if (!this._canAccept(source))
            return false;

        if (this._withinLeeways(x))
            return false;

        // added - remove app from the source folder after dnd to other folder
        if (source._sourceItem) {
            const app = source._sourceItem.app;
            source._sourceFolder.removeApp(app);
        }

        return true;
    },

};

const ActiveFolderIcon = GObject.registerClass(
class ActiveFolderIcon extends AppDisplay.AppIcon {
    _init(app) {
        super._init(app, {
            setSizeManually: true,
            showLabel: false,
        });
    }

    handleDragOver() {
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop() {
        return false;
    }

    _onDragEnd() {
        this._dragging = false;
        this.undoScaleAndFade();
        Main.overview.endItemDrag(this._sourceItem.icon);
    }
});
