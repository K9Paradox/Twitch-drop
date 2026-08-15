/**
 * DOM and In-Page Environment Mock for onPage.js and inject.js testing
 */

export class MockElement {
    constructor(tagName, attributes = {}, textContent = "") {
        this.tagName = tagName.toUpperCase();
        this.attributes = { ...attributes };
        this.textContent = textContent;
        this.offsetParent = {}; // non-null means visible by default
        this._listeners = new Map();
        this.paused = true;
        this.volume = 1.0;
        this.muted = false;
    }

    getAttribute(name) {
        return this.attributes[name] || null;
    }

    setAttribute(name, val) {
        this.attributes[name] = String(val);
    }

    addEventListener(event, fn) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(fn);
    }

    removeEventListener(event, fn) {
        if (this._listeners.has(event)) {
            this._listeners.get(event).delete(fn);
        }
    }

    dispatchEvent(event) {
        if (this._listeners.has(event.type)) {
            for (const fn of this._listeners.get(event.type)) {
                fn(event);
            }
        }
        return true;
    }

    click() {
        this.dispatchEvent({ type: "click", target: this, bubbles: true });
    }

    async play() {
        this.paused = false;
        return Promise.resolve();
    }

    pause() {
        this.paused = true;
    }
}

export class DOMMock {
    constructor() {
        this.reset();
    }

    reset() {
        this._storage = new Map();
        this.localStorage = {
            getItem: (key) => this._storage.get(key) ?? null,
            setItem: (key, val) => this._storage.set(key, String(val)),
            removeItem: (key) => this._storage.delete(key),
            clear: () => this._storage.clear()
        };

        this._elements = [];
        this._windowListeners = new Map();
        this._documentListeners = new Map();
        this._postMessages = [];

        this.document = {
            hidden: true,
            visibilityState: "hidden",
            _listeners: this._documentListeners,
            addEventListener: (evt, fn, useCapture) => {
                if (!this._documentListeners.has(evt)) {
                    this._documentListeners.set(evt, new Set());
                }
                this._documentListeners.get(evt).add(fn);
            },
            removeEventListener: (evt, fn) => {
                if (this._documentListeners.has(evt)) {
                    this._documentListeners.get(evt).delete(fn);
                }
            },
            querySelector: (selector) => {
                return this.querySelectorAll(selector)[0] || null;
            },
            querySelectorAll: (selector) => {
                return this._elements.filter(el => {
                    if (selector.includes("video") && el.tagName === "VIDEO") return true;
                    if (selector.includes('[aria-label="Claim Bonus"]') && el.getAttribute("aria-label")?.toLowerCase() === "claim bonus") return true;
                    if (selector.includes('[aria-label="Claim bonus"]') && el.getAttribute("aria-label")?.toLowerCase() === "claim bonus") return true;
                    if (selector.includes('[data-a-target="claim-channel-points-button"]') && el.getAttribute("data-a-target") === "claim-channel-points-button") return true;
                    if (selector.includes('[data-a-target="player-overlay-click-to-unmute"]') && el.getAttribute("data-a-target") === "player-overlay-click-to-unmute") return true;
                    if (selector.includes('[data-test-selector="unmute-button"]') && el.getAttribute("data-test-selector") === "unmute-button") return true;
                    if (selector.includes('.community-points-summary button') && el.getAttribute("class")?.includes("community-points-summary")) return true;
                    return false;
                });
            },
            createElement: (tagName) => {
                const el = new MockElement(tagName);
                this._elements.push(el);
                return el;
            }
        };

        this.window = {
            localStorage: this.localStorage,
            document: this.document,
            _listeners: this._windowListeners,
            postMessage: (msg, targetOrigin) => {
                this._postMessages.push({ msg, targetOrigin });
                if (this._windowListeners.has("message")) {
                    for (const fn of this._windowListeners.get("message")) {
                        fn({ data: msg, origin: targetOrigin });
                    }
                }
            },
            addEventListener: (evt, fn) => {
                if (!this._windowListeners.has(evt)) {
                    this._windowListeners.set(evt, new Set());
                }
                this._windowListeners.get(evt).add(fn);
            },
            removeEventListener: (evt, fn) => {
                if (this._windowListeners.has(evt)) {
                    this._windowListeners.get(evt).delete(fn);
                }
            }
        };
    }

    addElement(tagName, attributes = {}, textContent = "") {
        const el = new MockElement(tagName, attributes, textContent);
        this._elements.push(el);
        return el;
    }
}

export const domMock = new DOMMock();
