'use strict';

const GLib = imports.gi.GLib;

var Thread = class {
    // This encapsulates an array of messages
    // Messages are stored in the array in timestamp order
    // With newer messages at the end of the array.

    constructor(thread_id, messages = []) {
        this._id = thread_id;
        this._hasMoreMessages = true;
        this._oldestCacheTimestamp = -1;
        this._newestCacheTimestamp = -1;
        this._messages = [];
        this.addMessages(messages);
    }

    static fromJSON(threadObject) {
        let t = new Thread(threadObject.id, threadObject.messages);
        t._hasMoreMessages = threadObject.hasMoreMessages;
        t._oldestCacheTimestamp = threadObject.oldestCacheTimestamp;
        t._newestCacheTimestamp = threadObject.newestCacheTimestamp;
        return t;
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

    get oldestCachedTime() {
        return this._oldestCacheTimestamp;
    }

    get newestCachedTime() {
        return this._newestCacheTimestamp;
    }

    get id() {
        return this._id;
    }

    get firstMessage() {
        return this._messages[0];
    }
    messages(beforeTimeStamp = null, count = null) {

        const filterTime = beforeTimeStamp ? beforeTimeStamp : (GLib.DateTime.new_now_local().to_unix() * 1000);
        // Filter our cache to the timestamp requested
        let filteredMessages = this._messages;
        if (beforeTimeStamp)
            filteredMessages = this._messages.filter(m => m.date < filterTime);
        if (count) {
            return filteredMessages.slice(filteredMessages.length - count, count);
        }
        return filteredMessages;
    }

    update(newThreadData) {
        for (let i = 0, len = newThreadData.length; i < len; i++) {
            let currentMessage = newThreadData[i];

            // TODO: invalid MessageBox
            if (currentMessage.type < 0 || currentMessage.type > 5) continue;


            // If the message exists, just update it
            let existingMessage = this.messages().find(m => m.date === currentMessage.date);

            if (existingMessage) {
                Object.assign(existingMessage, currentMessage);
            } else {
                this.addMessage(currentMessage);
            }
        }
        this.updateSorting();
    }

    addMessages(messages) {
        if (!Array.isArray(messages))
            messages = [messages];
        this._messages = this._messages.concat(messages);
        // Todo: If an update is called this is run for each message, we should delay it.
        if(this._messages.length > 0)
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

    add(message) { this._messages.push(message) }
    [Symbol.iterator]() {
        var index = -1;
        var messages = this._messages;

        return {
            next: () => ({ value: messages[++index], done: !(index in messages)})
        }
    }

};
