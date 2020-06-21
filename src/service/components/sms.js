'use strict';

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Sms = imports.service.plugins.sms;

var MessageStore = GObject.registerClass({
    GTypeName: 'GSConnectMessageStore',
    Implements: [Gio.ListModel],
    Signals: {
        // Signals for consumers
        'thread-added': {
            param_types: [GObject.TYPE_OBJECT]
        },
        'thread-removed': {
            param_types: [GObject.TYPE_INT]
        },
        'messages-added': {
            param_types: [GObject.TYPE_OBJECT]
        },
        'messages-removed': {
            param_types: [GObject.TYPE_OBJECT]
        },
        // Signals for creators
        'send-message': {
            param_types: [GObject.TYPE_OBJECT]
        },
        'request-messages': {
            // thread_id, numbertorequest, timestamp.  The timestamp is too big to be an int :(
            param_types: [GObject.TYPE_INT, GObject.TYPE_INT, GObject.TYPE_STRING]
        },
    }
}, class MessageStore extends GObject.Object {
    _init(params) {
        super._init();
        this._threads = {};
        this._lastUpdated = -1;
        if ( params !== undefined && Object.keys(params).length) {

            this.initializeThreads(params.threads);
            this._lastUpdated = params.lastUpdated;
        }
    }

    toJSON() {
        return {
            lastUpdated: this._lastUpdated,
            threads: this._threads
        };
    }

    initializeThreads(threads) {
        debug("here");
        this._threads = {};
        let cnt = 0;
        for (let thread_id of Object.keys(threads) ) {
            this._threads[thread_id] = new Thread(threads[thread_id]);
            cnt++;
        }
        this.model_items_changed(0, 0, cnt);
    }

    addExistingThread(thread) {
        this._threads[thread._id] = thread;
        this.emit('thread-added', thread);
        this.model_items_changed(this.findIndex(thread._id), 0, 1);

    }

    createThread(messages) {
        // debug('creating a new thread from messages');
        // debug(messages);
        if (!Array.isArray(messages))
            messages = [messages];
        // This is called when a digest is parsed
        // At this point we're looking for the messages thread_id as the key.
        var t = new Thread({
            thread_id: messages[0].thread_id,
            messages
        });
        this.addExistingThread(t);
        return t;
    }

    getThread(thread_id) {
        if (this._threads.hasOwnProperty(thread_id))
            return this._threads[thread_id];
        return null;
    }

    getMessagesForThread(thread_id, numberToRequest = 25, beforeTimeStamp = null) {
        let thread = this.getThread(thread_id);
        if (thread === null) {
            return null;
        }
        let messages = thread.messages(numberToRequest, beforeTimeStamp);
        if (messages.length < numberToRequest) {
            debug(`There were only ${messages.length} messages returned`);

            if (thread.hasMoreMessages) {
                debug('There are more messages, fetching');
                // Update Filter time to earliest we have.
                if (messages.length > 0) {
                    beforeTimeStamp = messages[0].date;
                }

                // Request more from device.
                this.emit('request-messages',
                    thread_id,
                    numberToRequest,
                    `${beforeTimeStamp}`
                );
            }
        }
        // Regardless, return what we have
        return messages;
    }

    addMessageToThread(thread_id, message) {
        this.addMessagesToThread(thread_id, [message]);
    }

    addMessagesToThread(thread_id, messages) {
        debug(`Adding messages to thread ${thread_id}`);
        // debug(messages);
        let thread = this.getThread(thread_id);
        if (thread == null) {
            debug('Trying to add messages to an non existing thread');
            throw new Error(`Thread ${thread_id} does not exist`);
        }

        if (thread.update(messages)) {
            this.emit('messages-added', thread);
        }
    }

    hasThread(thread_id) {
        return this._threads.hasOwnProperty(thread_id);
    }

    get threads() {
        if (this._threads === undefined) {
            this._threads = {};
        }
        return this._threads;
    }

    removeThread(thread_id) {
        delete this._threads[thread_id];
        this.emit('thread-removed', thread_id);
        this.model_items_changed(this.findIndex(thread_id), 1, 0);
    }

    set lastUpdated(timeStamp = -1) {
        this._lastUpdated = timeStamp;
    }
    get lastUpdated() {
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
        this.model_items_changed(this.findIndex(thread._id), 0, 1);

    }
    *[Symbol.iterator] () {
        for (let thread_id of Object.keys(this._threads)) {
            yield this.getThread(thread_id);
        }
    }

    positionFromThreadId(thread_id) {
        let array = Object.keys(this._threads);
        return array.findIndex((item) => item == thread_id);
    }

    // get_item(position) {
    //     if (position > this.get_n_items() - 1) {
    //         return null;
    //     }
    //     return this._threads[Object.keys(this._threads)[position]];
    // }

    // get get_item_type() {
    //     return GObject.type_from_name('GSConnectSMSThread');
    // }

    model_items_changed(position, removed, added) {
        debug("called");
        this.emit('items-changed', position, removed, added);
        debug("sent");
    }
});


var Thread = GObject.registerClass({
    GTypeName: 'GSConnectSMSThread',
    Implements: [Gio.ListModel],
}, class Thread extends GObject.Object {
    // This encapsulates an array of messages
    // Messages are stored in the array in timestamp order
    // With newer messages at the end of the array.

    _init(params) {
        super._init();
        if (!params)
            return;
        this._id = params.messages[0].thread_id;
        this._hasMoreMessages = true;
        this._oldestCacheTimestamp = -1;
        this._newestCacheTimestamp = -1;
        // { timestamp: { message}};
        this._messages = {};
        this.addMessages(params.messages);

    }

    toJSON() {
        let ret = {
            id: this._id,
            hasMoreMessages: this._hasMoreMessages,
            oldestCacheTimestamp: this._oldestCacheTimestamp,
            newestCacheTimestamp: this._newestCacheTimestamp,
            messages: this._jsonify(this._messages)
        };
        return ret;
    }

    get hasMoreMessages() {
        return this._hasMoreMessages;
    }
    get oldestCachedTime() {
        return this._oldestCacheTimestamp;
    }

    get lastUpdated() {
        return this._newestCacheTimestamp;
    }

    get id() {
        return this._id;
    }

    get sortedTimeStamps() {
        if (this._messages === undefined)
            return null;

        return Object.keys(this._messages).sort((a, b)=> a - b);
    }

    get firstMessage() {

        return this._messages[this.sortedTimeStamps[0]];
    }

    _jsonify(messages) {
        let ret = [];

        for (let key of this.sortedTimeStamps) {
            ret.push(this._messages[key]);
        }
        return ret;
    }
    messages(count = null, beforeTimeStamp = null) {

        // Short-circuit
        if (count === null && beforeTimeStamp === null)
            return this._messages;

        debug(`fetching ${count} messages starting at timestamp ${beforeTimeStamp}`);
        const filterTime = beforeTimeStamp ? beforeTimeStamp : (GLib.DateTime.new_now_local().to_unix() * 1000);
        // Filter our cache to the timestamp requested
        let keysToGet = this.sortedTimeStamps.filter(k => k < filterTime);

        if (count) {
            keysToGet = keysToGet.slice(keysToGet.length - count, count + 1);
        }
        // debug(keysToGet)
        let filteredMessages = [];
        for ( let key of keysToGet ) {
            filteredMessages.push(this._messages[key]);
        }

        return filteredMessages;
    }

    update(newThreadData) {
        // If the earliest date fetched matches the earliest date in our cache
        // there is no more to fetch.
        if (newThreadData[0].date === this.sortedTimeStamps[0]) {
            debug('No more messages in thread.');
            this._hasMoreMessages = false;
            return false;
        }
        let messagesToAdd = [];
        for (let i = 0, len = newThreadData.length; i < len; i++) {

            let currentMessage = newThreadData[i];

            // TODO: invalid MessageBox
            if (currentMessage.type < 0 || currentMessage.type > 5) continue;


            // If the message exists, just update it
            let existingMessage = this.messages()[currentMessage.date];

            if (existingMessage) {
                Object.assign(existingMessage, currentMessage);
            } else {
                messagesToAdd.push(currentMessage);
            }
        }
        this.addMessages(messagesToAdd);
        this.updateSorting();
        return true;
    }

    addMessages(messages) {
        let initialLength = this._messages.length;
        if (!Array.isArray(messages))
            messages = [messages];

        for (let message of messages) {
            let key = message.date;
            this._messages[key] = message;
        }
        // Todo: If an update is called this is run for each message, we should delay it.
        if (this._messages.length > 0)
            this.setCacheTimestampExtremes();

        this.model_items_changed(initialLength, 0, messages.length);
    }

    setCacheTimestampExtremes() {
        this._oldestCacheTimestamp = this.sortedTimeStamps[0];
        this._newestCacheTimestamp = this.sortedTimeStamps[this.sortedTimeStamps.length];
        // this._oldestCacheTimestamp = this._messages.reduce((min, m) => m.date < min ? m.date : min, this._messages[0].date);
        // this._newestCacheTimestamp = this._messages.reduce((max, m) => m.date > max ? m.date : max, this._messages[0].date);
    }

    updateSorting() {
        // TOdo is this still necessary?
        // this._messages.sort((a, b) => {
        //     return (a.date < b.date) ? -1 : 1;
        // });
    }

    get length() {
        return this.sortedTimeStamps.length;
    }

    // add(message) {
    //     this._messages.push(message);
    // }
    *[Symbol.iterator] () {
        for ( let message_id in this.sortedTimeStamps) {
            yield this._messages[message_id];
        }
    }

    positionFromThreadId(thread_id) {
        let array = Object.keys(this._messages);
        return array.findIndex((item) => item == thread_id);
    }

    vfunc_get_n_items() {

        let ret = Object.keys(this._messages).length;
        debug(ret);
        return ret;
    }
    vfunc_get_item(position) {
        debug("Getting item at" + position);
        if (position > this.get_n_items() - 1) {
            return null;
        }
        let ret = this._messages[Object.keys(this._messages)[position]];
        ret = Object.assign(new GObject.Object(), ret);
        debug(ret);
        return ret;
    }

    vfunc_get_item_type() {
        return GObject.type_from_name(GObject.TYPE_VARIANT);
    }

    model_items_changed(position, removed, added) {
        this.emit('items-changed', position, removed, added);
    }
});

// var Message = GObject.registerClass({
//     GTypeName: 'GSConnectSMSMessage',
//     Implements: [Gio.ListModel],
// }, class Message extends GObject.Object {
//     _init(params) {
//         super.__init(params);
//     }
// });
