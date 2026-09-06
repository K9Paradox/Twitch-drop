/**
 * Comprehensive Mock of Chrome Extension MV3 APIs for Node.js test environment
 */

class EventHook {
    constructor() {
        this.listeners = new Set();
    }

    addListener(fn) {
        if (typeof fn === "function") {
            this.listeners.add(fn);
        }
    }

    removeListener(fn) {
        this.listeners.delete(fn);
    }

    hasListener(fn) {
        return this.listeners.has(fn);
    }

    clearListeners() {
        this.listeners.clear();
    }

    async emit(...args) {
        const results = [];
        for (const fn of Array.from(this.listeners)) {
            try {
                results.push(await fn(...args));
            } catch (err) {
                console.error("Error in event listener:", err);
            }
        }
        return results;
    }
}

export class ChromeMock {
    constructor() {
        this.reset();
    }

    reset() {
        this._storageData = {};
        this._storageChangesListeners = new EventHook();

        this.storage = {
            local: {
                get: async (keys) => {
                    if (!keys) return { ...this._storageData };
                    if (typeof keys === "string") {
                        return { [keys]: this._storageData[keys] };
                    }
                    if (Array.isArray(keys)) {
                        const res = {};
                        for (const k of keys) {
                            if (this._storageData[k] !== undefined) {
                                res[k] = this._storageData[k];
                            }
                        }
                        return res;
                    }
                    if (typeof keys === "object") {
                        const res = {};
                        for (const k of Object.keys(keys)) {
                            res[k] = this._storageData[k] !== undefined ? this._storageData[k] : keys[k];
                        }
                        return res;
                    }
                    return {};
                },
                set: async (items) => {
                    const changes = {};
                    for (const [k, v] of Object.entries(items)) {
                        const oldValue = this._storageData[k];
                        this._storageData[k] = JSON.parse(JSON.stringify(v));
                        changes[k] = { oldValue, newValue: this._storageData[k] };
                    }
                    await this.storage.onChanged.emit(changes, "local");
                },
                remove: async (keys) => {
                    const keyList = Array.isArray(keys) ? keys : [keys];
                    const changes = {};
                    for (const k of keyList) {
                        const oldValue = this._storageData[k];
                        delete this._storageData[k];
                        changes[k] = { oldValue, newValue: undefined };
                    }
                    await this.storage.onChanged.emit(changes, "local");
                },
                clear: async () => {
                    this._storageData = {};
                }
            },
            onChanged: this._storageChangesListeners
        };

        this._tabs = new Map();
        this._tabIdCounter = 100;
        this.tabs = {
            onUpdated: new EventHook(),
            onRemoved: new EventHook(),
            create: async (props = {}) => {
                const id = ++this._tabIdCounter;
                const tab = {
                    id,
                    url: props.url || "about:blank",
                    active: props.active !== undefined ? props.active : true,
                    mutedInfo: { muted: props.muted || false },
                    status: "complete",
                    title: props.title || "Twitch",
                    windowId: props.windowId || 1
                };
                this._tabs.set(id, tab);
                return tab;
            },
            get: async (tabId) => {
                const tab = this._tabs.get(tabId);
                if (!tab) throw new Error(`Tab ${tabId} not found`);
                return { ...tab };
            },
            query: async (queryInfo = {}) => {
                const result = [];
                for (const tab of this._tabs.values()) {
                    let match = true;
                    if (queryInfo.url && !tab.url.includes(queryInfo.url.replace(/\*/g, ""))) match = false;
                    if (queryInfo.active !== undefined && tab.active !== queryInfo.active) match = false;
                    if (match) result.push({ ...tab });
                }
                return result;
            },
            update: async (tabId, updateProps = {}) => {
                const tab = this._tabs.get(tabId);
                if (!tab) throw new Error(`Tab ${tabId} not found`);
                if (updateProps.url !== undefined) tab.url = updateProps.url;
                if (updateProps.muted !== undefined) tab.mutedInfo = { muted: updateProps.muted };
                if (updateProps.active !== undefined) tab.active = updateProps.active;
                await this.tabs.onUpdated.emit(tabId, updateProps, tab);
                return { ...tab };
            },
            remove: async (tabId) => {
                const tabIds = Array.isArray(tabId) ? tabId : [tabId];
                for (const id of tabIds) {
                    this._tabs.delete(id);
                    await this.tabs.onRemoved.emit(id, { isWindowClosing: false });
                }
            }
        };

        this._alarms = new Map();
        this.alarms = {
            onAlarm: new EventHook(),
            create: (name, alarmInfo = {}) => {
                this._alarms.set(name, {
                    name,
                    periodInMinutes: alarmInfo.periodInMinutes || 1,
                    scheduledTime: Date.now() + (alarmInfo.delayInMinutes || 0) * 60000
                });
            },
            get: async (name) => {
                return this._alarms.get(name) || null;
            },
            getAll: async () => {
                return Array.from(this._alarms.values());
            },
            clear: async (name) => {
                return this._alarms.delete(name);
            },
            clearAll: async () => {
                const count = this._alarms.size;
                this._alarms.clear();
                return count > 0;
            },
            trigger: async (name) => {
                const alarm = this._alarms.get(name) || { name, scheduledTime: Date.now() };
                await this.alarms.onAlarm.emit(alarm);
            }
        };

        this._messagesSent = [];
        this.runtime = {
            id: "mock-extension-id-auto-twitch-drops",
            lastError: null,
            onMessage: new EventHook(),
            sendMessage: async (msg) => {
                this._messagesSent.push(msg);
                return await this.runtime.onMessage.emit(msg, { id: this.runtime.id });
            },
            getURL: (path) => `chrome-extension://${this.runtime.id}/${path.replace(/^\//, "")}`
        };

        this._cookies = [];
        this.cookies = {
            get: async ({ url, name }) => {
                return this._cookies.find(c => c.name === name) || null;
            },
            getAll: async ({ name, domain } = {}) => {
                let list = [...this._cookies];
                if (name) list = list.filter(c => c.name === name);
                if (domain) list = list.filter(c => c.domain.includes(domain));
                return list;
            },
            set: async (details) => {
                const existingIdx = this._cookies.findIndex(c => c.name === details.name && c.domain === details.domain);
                const cookie = {
                    name: details.name,
                    value: details.value,
                    domain: details.domain || "twitch.tv",
                    path: details.path || "/"
                };
                if (existingIdx >= 0) {
                    this._cookies[existingIdx] = cookie;
                } else {
                    this._cookies.push(cookie);
                }
                return cookie;
            },
            remove: async ({ url, name }) => {
                const idx = this._cookies.findIndex(c => c.name === name);
                if (idx >= 0) {
                    this._cookies.splice(idx, 1);
                    return { url, name };
                }
                return null;
            }
        };

        this._contentSettings = {
            autoplay: {
                _settings: {},
                set: (details) => {
                    this._contentSettings.autoplay._settings[details.primaryPattern] = details.setting;
                },
                get: (details, cb) => {
                    const res = { setting: this._contentSettings.autoplay._settings[details.primaryUrl] || "allow" };
                    if (cb) cb(res);
                    return res;
                }
            }
        };
        this.contentSettings = this._contentSettings;

        this._notifications = [];
        this.notifications = {
            create: (idOrOptions, optionsOrCb, cb) => {
                let id = typeof idOrOptions === "string" ? idOrOptions : `notif-${Date.now()}`;
                let options = typeof idOrOptions === "object" ? idOrOptions : optionsOrCb;
                let callback = typeof optionsOrCb === "function" ? optionsOrCb : cb;
                this._notifications.push({ id, ...options });
                if (callback) callback(id);
                return id;
            },
            clear: (id, cb) => {
                const idx = this._notifications.findIndex(n => n.id === id);
                if (idx >= 0) this._notifications.splice(idx, 1);
                if (cb) cb(idx >= 0);
            },
            getAll: (cb) => {
                const map = {};
                this._notifications.forEach(n => { map[n.id] = n; });
                if (cb) cb(map);
                return map;
            }
        };

        this.action = {
            setBadgeText: (details) => {
                this._badgeText = details.text;
            },
            setBadgeBackgroundColor: (details) => {
                this._badgeColor = details.color;
            }
        };
        this.browserAction = this.action;

        this._windows = new Map();
        this._windowIdCounter = 10;
        this.windows = {
            onRemoved: new EventHook(),
            create: async (createData = {}) => {
                const id = ++this._windowIdCounter;
                const tab = await this.tabs.create({
                    url: createData.url || "about:blank",
                    active: true,
                    windowId: id
                });
                const win = {
                    id,
                    type: createData.type || "normal",
                    focused: createData.focused !== undefined ? createData.focused : true,
                    tabs: [tab],
                    width: createData.width || 854,
                    height: createData.height || 480
                };
                this._windows.set(id, win);
                return win;
            },
            get: async (windowId, getInfo = {}) => {
                const win = this._windows.get(windowId);
                if (!win) throw new Error(`Window ${windowId} not found`);
                if (getInfo.populate) {
                    const tabs = Array.from(this._tabs.values()).filter(t => t.windowId === windowId);
                    return { ...win, tabs };
                }
                return { ...win };
            },
            remove: async (windowId) => {
                const win = this._windows.get(windowId);
                if (win) {
                    this._windows.delete(windowId);
                    const tabs = Array.from(this._tabs.values()).filter(t => t.windowId === windowId);
                    for (const t of tabs) {
                        this._tabs.delete(t.id);
                        await this.tabs.onRemoved.emit(t.id, { isWindowClosing: true });
                    }
                    await this.windows.onRemoved.emit(windowId);
                }
            }
        };
    }
}

export const chromeMock = new ChromeMock();
