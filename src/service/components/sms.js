'use strict';

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

var MessageStore = GObject.registerClass({
    GTypeName: 'GSConnectMessageStore',
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
}, class ThreadCache extends GObject.Object {
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
        this._threads = {};
        for (let thread_id in threads ) {
            this._threads[thread_id] = new Thread(threads[thread_id]);
        }
    }

    addExistingThread(thread) {
        this._threads[thread._id] = thread;
        this.emit("thread-added", thread);
    }

    createThread(messages) {
        debug("creating a new thread from messages")
        debug(messages);
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

            if(thread.hasMoreMessages) {
                // Update Filter time to earliest we have.
                if(messages.length > 0) {
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
        let thread = this.getThread(thread_id);
        if (thread == null) {
            debug("Trying to add messages to an non existing thread");
            throw new Exception(`Thread ${thread_id} does not exist`);
            return;
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
        this.emit("thread-removed", thread_id);

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
    }
    *[Symbol.iterator] () {
        for (let thread_id in this._threads) {
            // debug("Iterating");
            yield this.getThread(thread_id);
        }
    }
});


var Thread = GObject.registerClass({
    GTypeName: 'GSConnectSMSThread'
}, class Thread extends GObject.Object {
    // This encapsulates an array of messages
    // Messages are stored in the array in timestamp order
    // With newer messages at the end of the array.

    _init(params) {
        super._init();
        this._id = params.messages[0].thread_id;
        this._hasMoreMessages = true;
        this._oldestCacheTimestamp = -1;
        this._newestCacheTimestamp = -1;
        this._messages = [];
        this.addMessages(params.messages);

    }

    toJSON() {
        return {
            id: this._id,
            hasMoreMessages: this._hasMoreMessages,
            oldestCacheTimestamp: this._oldestCacheTimestamp,
            newestCacheTimestamp: this._newestCacheTimestamp,
            messages: this._messages
        };
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

    get firstMessage() {
        return this._messages[0];
    }
    messages(count = null, beforeTimeStamp = null) {

        debug(`fetching ${count} messages starting at timestamp ${beforeTimeStamp}`);
        const filterTime = beforeTimeStamp ? beforeTimeStamp : (GLib.DateTime.new_now_local().to_unix() * 1000);
        // Filter our cache to the timestamp requested
        let filteredMessages = this._messages;
        if (beforeTimeStamp)
            filteredMessages = this._messages.filter(m => m.date < filterTime);

        if (count) {
            return filteredMessages.slice(filteredMessages.length - count, count+1);
        }
        // debug(filteredMessages.length);
        return filteredMessages;
    }

    update(newThreadData) {
        // If the earliest date fetched matches the earliest date in our cache
        // there is no more to fetch.
        if (newThreadData[0].date === this.firstMessage.date) {
            debug("No more messages in thread.");
            this._hasMoreMessages = false;
            return false;
        }
        let messagesToAdd = [];
        for (let i = 0, len = newThreadData.length; i < len; i++) {

            let currentMessage = newThreadData[i];

            // TODO: invalid MessageBox
            if (currentMessage.type < 0 || currentMessage.type > 5) continue;


            // If the message exists, just update it
            let existingMessage = this.messages().find(m => m.date === currentMessage.date);

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
        if (!Array.isArray(messages))
            messages = [messages];
        this._messages = this._messages.concat(messages);
        // Todo: If an update is called this is run for each message, we should delay it.
        if (this._messages.length > 0)
            this.setCacheTimestampExtremes();
    }

    setCacheTimestampExtremes() {
        this._oldestCacheTimestamp = this._messages.reduce((min, m) => m.date < min ? m.date : min, this._messages[0].date);
        this._newestCacheTimestamp = this._messages.reduce((max, m) => m.date > max ? m.date : max, this._messages[0].date);
    }

    updateSorting() {
        this._messages.sort((a, b) => {
            return (a.date < b.date) ? -1 : 1;
        });
    }

    get length() {
        return this._messages.length;
    }

    add(message) {
        this._messages.push(message);
    }
    *[Symbol.iterator] () {
        for( message in this.messages) {
            yield message;
        }
    }

});
