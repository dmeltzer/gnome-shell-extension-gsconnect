'use strict';

const {Thread} = imports.utils.thread;

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

var ThreadCache = class ThreadCache {
    constructor(threads = {}) {
        debug('Initializing ThreadCache');
        this.initializeThreads(threads);
        this._lastUpdated = -1;
    }

    static fromJSON(threadObject) {
        debug(threadObject);
        if (!threadObject.hasOwnProperty('threads')) {
            return new ThreadCache();
        }
        let t = new ThreadCache(threadObject.threads);
        t._lastUpdated = threadObject.lastUpdated;
        return t;
    }

    toJSON() {
        return {
            lastUpdated: this._lastUpdated,
            threads: this._threads
        };
    }

    initializeThreads(threads) {
        this._threads = {};
        for (let thread_id in threads ) {
            this._threads[thread_id] = Thread.fromJSON(threads[thread_id]);
        }
    }

    addExistingThread(thread) {
        this._threads[thread._id] = thread;
    }

    createThread(message) {
        // This is called when a digest is parsed
        // At this point we're looking for the messages thread_id as the key.
        var t = new Thread(message.thread_id, [message]);
        this.addExistingThread(t);
        return t;
    }

    getThread(thread_id) {
        if (this._threads.hasOwnProperty(thread_id))
            return this._threads[thread_id];
        return null;
    }

    get threads() {
        return this._threads;
    }

    removeThread(thread_id) {
        delete this._threads[thread_id];
    }

    set newestCachedTime(timeStamp = -1) {
        this._lastUpdated = timeStamp;
    }
    get newestCachedTime() {
        return this._lastUpdated;
    }

    get length() {
        let cnt = 0;
        for (cnt in this._threads) {
            cnt++;
        }
        return cnt;
    }

    add(thread) {
        this._threads.add(thread._id, thread);
    }
    *[Symbol.iterator] () {
        for (let thread_id in this._threads) {
            yield new Thread(thread_id, this._threads[thread_id].messages());
        }
    }
};
