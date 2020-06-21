'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;
const {ConversationChooser} = imports.service.ui.messages.conversationchooser;
const {MessagingWindow} = imports.service.ui.messages.window;

const TelephonyUI = imports.service.ui.telephony;
const URI = imports.utils.uri;

const SMS = imports.service.components.sms;
var Metadata = {
    label: _('SMS'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SMS',
    incomingCapabilities: [
        'kdeconnect.sms.messages'
    ],
    outgoingCapabilities: [
        'kdeconnect.sms.request',
        'kdeconnect.sms.request_conversation',
        'kdeconnect.sms.request_conversations'
    ],
    actions: {
        // SMS Actions
        sms: {
            label: _('Messaging'),
            icon_name: 'sms-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.sms.request']
        },
        uriSms: {
            label: _('New SMS (URI)'),
            icon_name: 'sms-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request']
        },
        replySms: {
            label: _('Reply SMS'),
            icon_name: 'sms-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request']
        },
        sendMessage: {
            label: _('Send Message'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('(aa{sv})'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request']
        },
        sendSms: {
            label: _('Send SMS'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('(ss)'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request']
        },
        shareSms: {
            label: _('Share SMS'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request']
        }
    }
};


/**
 * SMS Message event type. Currently all events are TEXT_MESSAGE.
 *
 * TEXT_MESSAGE: Has a "body" field which contains pure, human-readable text
 */
var MessageEvent = {
    TEXT_MESSAGE: 0x1
};


/**
 * SMS Message status. READ/UNREAD match the 'read' field from the Android App
 * message packet.
 *
 * UNREAD: A message not marked as read
 * READ: A message marked as read
 */
var MessageStatus = {
    UNREAD: 0,
    READ: 1
};


/**
 * SMS Message direction. IN/OUT match the 'type' field from the Android App
 * message packet.
 *
 * See: https://developer.android.com/reference/android/provider/Telephony.TextBasedSmsColumns.html
 *
 * IN: An incoming message
 * OUT: An outgoing message
 */
var MessageBox = {
    ALL: 0,
    INBOX: 1,
    SENT: 2,
    DRAFT: 3,
    OUTBOX: 4,
    FAILED: 5
};


/**
 * SMS Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sms
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SMSPlugin/
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectSMSPlugin',
    Properties: {
        'threads': GObject.param_spec_variant(
            'threads',
            'Conversation List',
            'A list of threads',
            new GLib.VariantType('aa{sv}'),
            null,
            GObject.ParamFlags.READABLE
        )
    }
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'sms');

        this.cacheProperties(['_threads']);
        this._version = 1;
    }

    get threads() {
        if (this._threads === undefined) {
            debug('Thread Cache undefined, trying to fix');
            this._threads = new SMS.MessageStore();
        }
        // debug(this._threads);
        return this._threads;
    }

    get window() {
        if (this.settings.get_boolean('legacy-sms')) {
            return new TelephonyUI.LegacyMessagingDialog({
                device: this.device,
                plugin: this
            });
        }

        if (this._window === undefined) {
            this._window = new MessagingWindow({
                application: this.service,
                device: this.device,
                plugin: this
            });
        }

        return this._window;
    }

    handlePacket(packet) {
        // Currently only one incoming packet type
        if (packet.type === 'kdeconnect.sms.messages') {
            this._handleMessages(packet.body.messages);
        }
    }

    clearCache() {
        this._threads = new SMS.MessageStore();
        this.__cache_write();
        this.notify('threads');
        this.requestConversations();
    }

    cacheLoaded() {
        // Recreate it as a full on object.
        // this._threads = SMS.MessageStore.fromJSON(this._threads);
        new SMS.Thread();
        debug(SMS.Thread.$gtype);
        this._threads = new SMS.MessageStore(this._threads);
        this.threads.connect('request-messages', this._onConversationRequested.bind(this));
        this.notify('threads');
    }

    connected() {
        super.connected();
        this.requestConversations();
    }

    /**
     * Handle a digest of threads.
     *
     * @param {Object[]} messages - A list of message objects
     * @param {string[]} thread_ids - A list of thread IDs as strings
     */
    async _handleDigest(messages, thread_ids) {
        // Prune threads
        for (let thread_id of this.threads) {
            if (!thread_ids.includes(thread_id)) {
                this.threads.removeThread(thread_id);
            }
        }


        // Request each new or newer thread
        // Run as two separate loops so that conversations populate before message fetching.
        for (let i = 0, len = messages.length; i < len; i++) {
            let message = messages[i];

            // Handle existing threads
            let thread = this.threads.getThread(message.thread_id);
            if (thread && message.read === MessageStatus.READ) {
                for (let msg of thread) {
                    debug(msg);
                    msg.read = MessageStatus.read;
                }
                // Can we implement foreach on the thread?
                // thread.forEach(msg => msg.read = MessageStatus.READ);
                this._handleThread(thread);
            } else {
                thread = this.threads.createThread(message);
            }
        }

        this.threads.lastUpdated = (GLib.DateTime.new_now_local().to_unix() * 1000);

        this.__cache_write();
        this.notify('threads');
    }

    /**
     * Handle a new single message
     *
     * @param {Object} message - A message object
     */
    _handleMessage(message) {
        let conversation = null;

        // If the window is open, try and find an active conversation
        if (this._window) {
            conversation = this._window.getConversationForMessage(message);
        }

        // If there's an active conversation, we should log the message now
        if (conversation) {
            conversation.logNext(message);
        }
    }

    /**
     * Parse a conversation (thread of messages) and sort them
     *
     * @param {Thread} thread - A list of sms message objects from a thread
     */
    _handleThread(thread) {
        try {
            if (thread.length < 1)
                return; // Something wrong with this thread.
            let firstMessage = thread[0];
            // If there are no addresses this will cause major problems...
            if (!firstMessage.addresses || !firstMessage.addresses[0]) return;

            let thread_id = firstMessage.thread_id;
            this.threads.addMessagesToThread(thread_id, thread);

            this.__cache_write();
            this.notify('threads');
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Handle a response to telephony.request_conversation(s)
     *
     * @param {object[]} messages - A list of sms message objects
     */
    async _handleMessages(messages) {
        try {
            // If messages is empty there's nothing to do...
            if (messages.length === 0) return;

            let thread_ids = [];

            // Perform some modification of the messages
            for (let i = 0, len = messages.length; i < len; i++) {
                let message = messages[i];

                // COERCION: thread_id's to strings
                message.thread_id = `${message.thread_id}`;
                thread_ids.push (message.thread_id);

                // TODO: Remove bogus `insert-address-token` entries
                let a = message.addresses.length;

                while (a--) {
                    if (message.addresses[a].address === undefined ||
                        message.addresses[a].address === 'insert-address-token')
                        message.addresses.splice(a, 1);
                }
            }

            // If there's multiple thread_id's it's a summary of threads
            if (thread_ids.some(id => id !== thread_ids[0])) {
                await this._handleDigest(messages, thread_ids);

            // Otherwise this is single thread or new message
            } else {
                // let t = this.threads.fetchOrCreateThread(messages);
                this._handleThread(messages);
            }
        } catch (e) {
            logError(e);
        }
    }
    _onConversationRequested(store, thread_id, numberToRequest, rangeStartTimestamp) {
        this.requestConversation( thread_id, numberToRequest, rangeStartTimestamp);
    }

    /**
     * Request a list of messages from a single thread.
     *
     * @param {Number} thread_id - The id of the thread to request
     * @param {Number} numberToGet - Amount of messages to fetch from database
     * @param {Number} beforeTimestamp - Starting point for fetching messages
     */
    requestConversation(thread_id, numberToRequest = 25, rangeStartTimestamp = null) {
        debug('Requested to fetch');
        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversation',
            body: {
                threadID: thread_id,
                numberToRequest,
                rangeStartTimestamp: (parseInt(rangeStartTimestamp))
            }
        });
    }

    /**
     * Request a list of the last message in each unarchived thread.
     */
    requestConversations() {
        debug('Fetching threads newer than: ' + this.threads.lastUpdated);
        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversations',
            body: {
                rangeStartTimestamp: this.threads.lastUpdated
            }
        });
    }

    /**
     * A notification action for replying to SMS messages (or missed calls).
     *
     * @param {string} hint - Could be either a contact name or phone number
     */
    replySms(hint) {
        this.window.present();
        // FIXME: causes problems now that non-numeric addresses are allowed
        //this.window.address = hint.toPhoneNumber();
    }

    /**
     * Send an SMS message
     *
     * @param {string} phoneNumber - The phone number to send the message to
     * @param {string} messageBody - The message to send
     */
    sendSms(phoneNumber, messageBody) {
        this.sendMessage([{address: phoneNumber}], messageBody, 1, true);
    }

    /**
     * Send a message
     *
     * @param {Array of Address} addresses - A list of address objects
     * @param {string} messageBody - The message text
     * @param {number} [event] - An event bitmask
     * @param {boolean} [forceSms] - Whether to force SMS
     * @param {number} [subId] - The SIM card to use
     */
    sendMessage(addresses, messageBody, event = 1, forceSms = false, subId = undefined) {
        // TODO: waiting on support in kdeconnect-android
        // if (this._version === 1) {
        this.device.sendPacket({
            type: 'kdeconnect.sms.request',
            body: {
                sendSms: true,
                phoneNumber: addresses[0].address,
                messageBody: messageBody
            }
        });
        // } else if (this._version == 2) {
        //     this.device.sendPacket({
        //         type: 'kdeconnect.sms.request',
        //         body: {
        //             version: 2,
        //             addresses: addresses,
        //             messageBody: messageBody,
        //             forceSms: forceSms,
        //             sub_id: subId
        //         }
        //     });
        // }
    }

    /**
     * Share a text content by SMS message. This is used by the WebExtension to
     * share URLs from the browser, but could be used to initiate sharing of any
     * text content.
     *
     * @param {string} url - The link to be shared
     */
    shareSms(url) {
        // Legacy Mode
        if (this.settings.get_boolean('legacy-sms')) {
            let window = this.window;
            window.present();
            window.setMessage(url);

        // If there are active threads, show the chooser dialog
        } else if (Object.values(this.threads).length > 0) {
            let window = new ConversationChooser({
                application: this.service,
                device: this.device,
                message: url,
                plugin: this
            });

            window.present();

        // Otherwise show the window and wait for a contact to be chosen
        } else {
            this.window.present();
            this.window.setMessage(url, true);
        }
    }

    /**
     * Open and present the messaging window
     */
    sms() {
        this.window.present();
    }

    /**
     * This is the sms: URI scheme handler
     *
     * @param {string} uri - The URI the handle (sms:|sms://|sms:///)
     */
    uriSms(uri) {
        try {
            uri = new URI.SmsURI(uri);

            // Lookup contacts
            let addresses = uri.recipients.map(number => {
                return {address: number.toPhoneNumber()};
            });
            let contacts = this.device.contacts.lookupAddresses(addresses);

            // Present the window and show the conversation
            let window = this.window;
            window.present();
            window.setContacts(contacts);

            // Set the outgoing message if the uri has a body variable
            if (uri.body) {
                window.setMessage(uri.body);
            }
        } catch (e) {
            logError(e, `${this.device.name}: "${uri}"`);
        }
    }

    addressesIncludesAddress(addresses, addressObj) {
        let number = addressObj.address.toPhoneNumber();

        for (let taddressObj of addresses) {
            let tnumber = taddressObj.address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number)) {
                return true;
            }
        }

        return false;
    }

    _threadHasAddress(thread, addressObj) {
        let number = addressObj.address.toPhoneNumber();

        for (let taddressObj of thread[0].addresses) {
            let tnumber = taddressObj.address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Try to find a thread_id in @smsPlugin for @addresses.
     *
     * @param {Array of Object} - a list of address objects
     */
    getThreadIdForAddresses(addresses) {
        let threads = Object.values(this.threads);

        for (let thread of threads) {
            if (addresses.length !== thread[0].addresses.length) continue;

            if (addresses.every(addressObj => this._threadHasAddress(thread, addressObj))) {
                return thread[0].thread_id;
            }
        }

        return null;
    }

    destroy() {
        if (this._window) {
            this._window.destroy();
        }

        super.destroy();
    }

});

// Helper functions

/**
 * Return a human-readable timestamp.
 *
 * @param {Number} time - Milliseconds since the epoch (local time)
 * @return {String} - A timestamp similar to what Android Messages uses
 */
var getTime = function (time) {
    let date = GLib.DateTime.new_from_unix_local(time / 1000);
    let now = GLib.DateTime.new_now_local();
    let diff = now.difference(date);

    switch (true) {
        // Super recent
        case (diff < GLib.TIME_SPAN_MINUTE):
            // TRANSLATORS: Less than a minute ago
            return _('Just now');

        // Under an hour
        case (diff < GLib.TIME_SPAN_HOUR):
            // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
            return ngettext(
                '%d minute',
                '%d minutes',
                (diff / GLib.TIME_SPAN_MINUTE)
            ).format(diff / GLib.TIME_SPAN_MINUTE);

        // Yesterday, but less than 24 hours ago
        case (diff < GLib.TIME_SPAN_DAY && (now.get_day_of_month() !== date.get_day_of_month())):
            // TRANSLATORS: Yesterday, but less than 24 hours (eg. Yesterday · 11:29 PM)
            return _('Yesterday・%s').format(date.format('%l:%M %p'));

        // Less than a day ago
        case (diff < GLib.TIME_SPAN_DAY):
            return date.format('%l:%M %p');

        // Less than a week ago
        case (diff < (GLib.TIME_SPAN_DAY * 7)):
            return date.format('%A・%l:%M %p');

        // Sometime this year
        case (date.get_year() === now.get_year()):
            return date.format('%b %e');

        // Earlier than that
        default:
            return date.format('%b %e %Y');
    }
};

var getShortTime = function (time) {
    let date = GLib.DateTime.new_from_unix_local(time / 1000);
    let diff = GLib.DateTime.new_now_local().difference(date);

    switch (true) {
        case (diff < GLib.TIME_SPAN_MINUTE):
            // TRANSLATORS: Less than a minute ago
            return _('Just now');

        case (diff < GLib.TIME_SPAN_HOUR):
            // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
            return ngettext(
                '%d minute',
                '%d minutes',
                (diff / GLib.TIME_SPAN_MINUTE)
            ).format(diff / GLib.TIME_SPAN_MINUTE);

        // Less than a day ago
        case (diff < GLib.TIME_SPAN_DAY):
            return date.format('%l:%M %p');

        // Less than a week ago
        case (diff < (GLib.TIME_SPAN_DAY * 7)):
            return date.format('%a');

        // Sometime this year
        case (date.get_year() === GLib.DateTime.new_now_local().get_year()):
            return date.format('%b %e');

        // Earlier than that
        default:
            return date.format('%b %e %Y');
    }
};

// Used for tooltips to display time and date of message.
var getDetailedTime = function (time) {
    let date = GLib.DateTime.new_from_unix_local(time / 1000);

    return date.format('%c');
};

var getContactsForAddresses = function(device, addresses) {
    let contacts = {};

    for (let i = 0, len = addresses.length; i < len; i++) {
        let address = addresses[i].address;

        contacts[address] = device.contacts.query({
            number: address
        });
    }
};

var setAvatarVisible = function (row, visible) {
    let incoming = (row.message.type === MessageBox.INBOX);

    // Adjust the margins
    if (visible) {
        row.grid.margin_start = incoming ? 6 : 56;
        row.grid.margin_bottom = 6;
    } else {
        row.grid.margin_start = incoming ? 44 : 56;
        row.grid.margin_bottom = 0;
    }

    // Show hide the avatar
    if (incoming) {
        row.avatar.visible = visible;
    }
};
