'use strict';

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Contacts = imports.service.ui.contacts;
const {ConversationWidget} = imports.service.ui.messages.conversationwidget;
const {ThreadRow} = imports.service.ui.messages.threadrow;
/**
 * A Gtk.ApplicationWindow for SMS conversations
 */
var MessagingWindow = GObject.registerClass({
    GTypeName: 'GSConnectMessagingWindow',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin providing messages',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'thread-id': GObject.ParamSpec.string(
            'thread-id',
            'Thread ID',
            'The current thread',
            GObject.ParamFlags.READWRITE,
            ''
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-window.ui',
    Children: [
        'headerbar', 'infobar',
        'thread-list', 'stack'
    ]
}, class Window extends Gtk.ApplicationWindow {

    _init(params) {
        super._init(params);
        this.headerbar.subtitle = this.device.name;

        this.insert_action_group('device', this.device);

        // Device Status
        this.device.bind_property(
            'connected',
            this.infobar,
            'reveal-child',
            GObject.BindingFlags.INVERT_BOOLEAN
        );

        // Contacts
        this.contact_chooser = new Contacts.ContactChooser({
            device: this.device
        });
        this.stack.add_named(this.contact_chooser, 'contact-chooser');

        this._numberSelectedId = this.contact_chooser.connect(
            'number-selected',
            this._onNumberSelected.bind(this)
        );

        // Threads
        this.thread_list.set_sort_func(this._sortThreads);

        this._threadsChangedId = this.plugin.connect(
            'notify::threads',
            this._onThreadsChanged.bind(this)
        );

        this._timestampThreadsId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE,
            60,
            this._timestampThreads.bind(this)
        );

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);

        this._sync();
        this._onThreadsChanged();
        this.restoreGeometry('messaging');
    }

    vfunc_delete_event(event) {
        this.saveGeometry();
        return this.hide_on_delete();
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    get thread_id() {
        return this.stack.visible_child_name;
    }

    set thread_id(thread_id) {
        thread_id = `${thread_id}`; // FIXME

        // Reset to the empty placeholder
        if (!thread_id) {
            this.thread_list.select_row(null);
            this.stack.set_visible_child_name('placeholder');
            return;
        }

        // Create a conversation widget if there isn't one
        let conversation = this.stack.get_child_by_name(thread_id);
        let messages = this.plugin.threads.getMessagesForThread(thread_id);
        if (conversation === null) {
            if (!messages) {
                debug(`Thread ID ${thread_id} not found`);
                return;
            }

            conversation = new ConversationWidget({
                device: this.device,
                plugin: this.plugin,
                thread: this.plugin.threads.getThread(thread_id)
            });

            this.stack.add_named(conversation, thread_id);
        }

        // Figure out whether this is a multi-recipient thread
        this._setHeaderBar(messages[0].addresses);

        // Select the conversation and entry active
        this.stack.visible_child = conversation;
        this.stack.visible_child.entry.has_focus = true;

        // There was a pending message waiting for a conversation to be chosen
        if (this._pendingShare) {
            conversation.setMessage(this._pendingShare);
            this._pendingShare = null;
        }

        this._thread_id = thread_id;
        this.notify('thread_id');
    }

    _setHeaderBar(addresses = []) {
        let address = addresses[0].address;
        let contact = this.device.contacts.query({number: address});

        if (addresses.length === 1) {
            this.headerbar.title = contact.name;
            this.headerbar.subtitle = Contacts.getDisplayNumber(contact, address);
        } else {
            let otherLength = addresses.length - 1;

            this.headerbar.title = contact.name;
            this.headerbar.subtitle = ngettext(
                'And %d other contact',
                'And %d others',
                otherLength
            ).format(otherLength);
        }
    }

    _sync() {
        this.device.contacts.fetch();
        this.plugin.connected();
    }

    _onDestroy(window) {
        GLib.source_remove(window._timestampThreadsId);
        window.contact_chooser.disconnect(window._numberSelectedId);
        window.plugin.disconnect(window._threadsChangedId);
    }

    _onNewConversation() {
        this._sync();
        this.stack.set_visible_child_name('contact-chooser');
        this.thread_list.select_row(null);
        this.contact_chooser.entry.has_focus = true;
    }

    _onNumberSelected(chooser, number) {
        let contacts = chooser.getSelected();
        let row = this._getRowForContacts(contacts);

        if (row) {
            this.thread_list.select_row(row);
        } else {
            this.setContacts(contacts);
        }
    }

    /**
     * Threads
     */
    _onThreadsChanged() {
        // Get the last message in each thread
        let messages = {};
        let threads = this.plugin.threads;
        for (let thread of threads) {
            let message = thread.latestMessage;
            // Skip messages without a body (eg. MMS messages without text)
            if (message.body) {
                messages[thread.id] = message;
            }
        }

        // Update existing summaries and destroy old ones
        for (let row of this.thread_list.get_children()) {
            let message = messages[row.thread_id];

            // If it's an existing conversation, update it
            if (message) {
                // Ensure there's a contact mapping
                let sender = message.addresses[0].address || 'unknown';

                if (row.contacts[sender] === undefined) {
                    row.contacts[sender] = this.device.contacts.query({
                        number: sender
                    });
                }

                row.message = message;
                delete messages[row.thread_id];

                // Otherwise destroy it
            } else {
                // Destroy the conversation widget
                let conversation = this.stack.get_child_by_name(`${row.thread_id}`);

                if (conversation) {
                    conversation.destroy();
                    imports.system.gc();
                }

                // Then the summary widget
                row.destroy();
                // HACK: temporary mitigator for mysterious GtkListBox leak
                imports.system.gc();
            }
        }

        // What's left in the dictionary is new summaries
        for (let message of Object.values(messages)) {
            let contacts = this.device.contacts.lookupAddresses(message.addresses);
            let conversation = new ThreadRow(contacts, message);
            this.thread_list.add(conversation);
        }

        // Re-sort the summaries
        this.thread_list.invalidate_sort();
    }

    // GtkListBox::row-selected
    _onThreadSelected(box, row) {
        // Show the conversation for this number (if applicable)
        if (row) {
            this.thread_id = row.thread_id;

            // Show the placeholder
        } else {
            this.headerbar.title = _('Messaging');
            this.headerbar.subtitle = this.device.name;
        }
    }

    _sortThreads(row1, row2) {
        return (row1.date > row2.date) ? -1 : 1;
    }

    _timestampThreads() {
        if (this.visible) {
            this.thread_list.foreach(row => row.update());
        }

        return GLib.SOURCE_CONTINUE;
    }

    /**
     * Find the thread row for @contacts
     *
     * @param {Array of Object} contacts - A contact group
     * @return {ThreadRow|null} - The thread row or %null
     */
    _getRowForContacts(contacts) {
        let addresses = Object.keys(contacts).map(address => {
            return {address: address};
        });

        // Try to find a thread_id
        let thread_id = this.plugin.getThreadIdForAddresses(addresses);

        for (let row of this.thread_list.get_children()) {
            if (row.message.thread_id === thread_id)
                return row;
        }

        return null;
    }

    setContacts(contacts) {
        // Group the addresses
        let addresses = [];

        for (let address of Object.keys(contacts)) {
            addresses.push({address: address});
        }

        // Try to find a thread ID for this address group
        let thread_id = this.plugin.getThreadIdForAddresses(addresses);

        if (thread_id === null) {
            thread_id = GLib.uuid_string_random();
        } else {
            thread_id = thread_id.toString();
        }

        // Try to find a thread row for the ID
        let row = this._getRowForContacts(contacts);

        if (row !== null) {
            this.thread_list.select_row(row);
            return;
        }

        // We're creating a new conversation
        let conversation = new ConversationWidget({
            device: this.device,
            plugin: this.plugin,
            addresses: addresses
        });

        // Set the headerbar
        this._setHeaderBar(addresses);

        // Select the conversation and entry active
        this.stack.add_named(conversation, thread_id);
        this.stack.visible_child = conversation;
        this.stack.visible_child.entry.has_focus = true;

        // There was a pending message waiting for a conversation to be chosen
        if (this._pendingShare) {
            conversation.setMessage(this._pendingShare);
            this._pendingShare = null;
        }

        this._thread_id = thread_id;
        this.notify('thread-id');
    }

    _includesAddress(addresses, addressObj) {
        let number = addressObj.address.toPhoneNumber();

        for (let haystackObj of addresses) {
            let tnumber = haystackObj.address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Try and find an existing conversation widget for @message.
     *
     * @param {object} message - A message object
     * @return {ConversationWidget|null} - A conversation widget or %null
     */
    getConversationForMessage(message) {
        // This shouldn't happen
        if (message === null) return null;

        // First try to find a conversation by thread_id
        let thread_id = `${message.thread_id}`;
        let conversation = this.stack.get_child_by_name(thread_id);

        if (conversation !== null) {
            return conversation;
        }

        // Try and find one by matching addresses, which is necessary if we've
        // started a thread locally and haven't set the thread_id
        let addresses = message.addresses;

        for (let conversation of this.stack.get_children()) {
            if (conversation.addresses === undefined ||
                conversation.addresses.length !== addresses.length) {
                continue;
            }

            let caddrs = conversation.addresses;

            // If we find a match, set `thread-id` on the conversation and the
            // child property `name`.
            if (addresses.every(addr => this._includesAddress(caddrs, addr))) {
                conversation._thread_id = thread_id;
                this.stack.child_set_property(conversation, 'name', thread_id);

                return conversation;
            }
        }

        return null;
    }

    /**
     * Set the contents of the message entry. If @pending is %false set the
     * message of the currently selected conversation, otherwise mark the
     * message to be set for the next selected conversation.
     *
     * @param {string} text - The message to place in the entry
     * @param {boolean} pending - Wait for a conversation to be selected
     */
    setMessage(message, pending = false) {
        try {
            if (pending) {
                this._pendingShare = message;
            } else {
                this.stack.visible_child.setMessage(message);
            }
        } catch (e) {
            debug(e);
        }
    }
});
