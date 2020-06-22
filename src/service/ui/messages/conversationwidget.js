'use strict';

const Tweener = imports.tweener.tweener;

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Gdk = imports.gi.Gdk;

const Sms = imports.service.plugins.sms;
const Contacts = imports.service.ui.contacts;
const {MessageLabel} = imports.service.ui.messages.messagelabel;

var ConversationWidget = GObject.registerClass({
    GTypeName: 'GSConnectConversationWidget',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this conversation',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin providing this conversation',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'has-pending': GObject.ParamSpec.boolean(
            'has-pending',
            'Has Pending',
            'Whether there are sent messages pending confirmation',
            GObject.ParamFlags.READABLE,
            false
        ),
        'thread-id': GObject.ParamSpec.string(
            'thread-id',
            'Thread ID',
            'The current thread',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            ''
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/conversation.ui',
    Children: [
        'entry', 'list', 'scrolled',
        'pending', 'pending-box'
    ]
}, class ConversationWidget extends Gtk.Grid {

    _init(params) {
        super._init({
            device: params.device,
            plugin: params.plugin
        });
        Object.assign(this, params);

        this.device.bind_property(
            'connected',
            this.entry,
            'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );

        // If we're disconnected pending messages might not succeed, but we'll
        // leave them until reconnect when we'll ask for an update
        this._connectedId = this.device.connect(
            'notify::connected',
            this._onConnected.bind(this)
        );

        // Pending messages
        this.pending.date = Number.MAX_SAFE_INTEGER;
        this.bind_property(
            'has-pending',
            this.pending,
            'visible',
            GObject.BindingFlags.DEFAULT | GObject.BindingFlags.SYNC_CREATE
        );

        // this._conversationModel = new Gtk.GListStore(this);
        this.list.bind_model(this.thread, this._createMessageRow.bind(this));

        // Auto-scrolling
        this._vadj = this.scrolled.get_vadjustment();
        this._scrolledId = this._vadj.connect(
            'value-changed',
            this._holdPosition.bind(this)
        );

        // this.plugin.threads.connect('messages-added', this._updateThreadMessages.bind(this));

        // Message List
        // this.list.set_header_func(this._headerMessages);
        // this.list.set_sort_func(this._sortMessages);
        this.__messages = [];

        // this._populateMessages();

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);
    }

    get addresses() {
        if (this._addresses === undefined) {
            this._addresses = [];
        }

        return this._addresses;
    }

    set addresses(addresses) {
        if (!addresses || addresses.length === 0) {
            this._addresses = [];
            this._contacts = {};
            return;
        }

        this._addresses = addresses;

        // Lookup a contact for each address object
        for (let i = 0, len = this.addresses.length; i < len; i++) {
            let address = this.addresses[i].address;

            this.contacts[address] = this.device.contacts.query({
                number: address
            });
        }

        // TODO: Mark the entry as insensitive for group messages
        if (this.addresses.length > 1) {
            this.entry.placeholder_text = _('Not available');
            this.entry.secondary_icon_name = null;
            this.entry.secondary_icon_tooltip_text = null;
            this.entry.sensitive = false;
            this.entry.tooltip_text = null;
        }
    }

    get contacts() {
        if (this._contacts === undefined) {
            this._contacts = {};
        }

        return this._contacts;
    }

    get has_pending() {
        return (this.pending_box.get_children().length);
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }
    get thread() {
        if (this._thread === undefined) {
            this._thread = null;
        }
        return this._thread;
    }

    set thread(thread) {
        this._thread = thread;
        this.thread_id = thread._id;

        let message = (thread) ? thread.firstMessage : null;

        if (message && this.addresses.length === 0) {
            this.addresses = message.addresses;
            this._thread_id = thread._id;
        }
    }

    get fetchMessageTimestamp() {
        if (this._fetchTimestamp === undefined)
            this._fetchTimestamp = null;

        return this._fetchTimestamp;
    }

    _onConnected(device) {
        if (device.connected) {
            this.pending_box.foreach(msg => msg.destroy());
        }
    }

    _onDestroy(conversation) {
        conversation.device.disconnect(conversation._connectedId);
        conversation._vadj.disconnect(conversation._scrolledId);

        conversation.list.foreach(message => {
            // HACK: temporary mitigator for mysterious GtkListBox leak
            message.run_dispose();
            imports.system.gc();
        });
    }

    _onEntryChanged(entry) {
        entry.secondary_icon_sensitive = (entry.text.length);
    }

    _onKeyPressEvent(entry, event) {
        let keyval = event.get_keyval()[1];
        let state = event.get_state()[1];
        let mask = state & Gtk.accelerator_get_default_mod_mask();

        if (keyval === Gdk.KEY_Return && (mask & Gdk.ModifierType.SHIFT_MASK)) {
            entry.emit('insert-at-cursor', '\n');
            return true;
        }

        return false;
    }

    _onSendMessage(entry, signal_id, event) {
        // Don't send empty texts
        if (!this.entry.text.trim()) return;

        // Send the message
        this.plugin.sendMessage(this.addresses, entry.text);

        // Log the message as pending
        let message = new MessageLabel({
            body: this.entry.text,
            date: Date.now(),
            type: Sms.MessageBox.SENT
        });
        this.pending_box.add(message);
        this.notify('has-pending');

        // Clear the entry
        this.entry.text = '';
    }

    _onSizeAllocate(listbox, allocation) {
        let upper = this._vadj.get_upper();
        let pageSize = this._vadj.get_page_size();

        // If the scrolled window hasn't been filled yet, load another message
        if (upper <= pageSize) {
            // this.logPrevious();

            this.scrolled.get_child().check_resize();

            // We've been asked to hold the position, so we'll reset the adjustment
            // value and update the hold position
        } else if (this.__pos) {
            this._vadj.set_value(upper - this.__pos);

            // Otherwise we probably appended a message and should scroll to it
        } else {
            this._scrollPosition(Gtk.PositionType.BOTTOM);
        }
    }

    /**
     * Messages
     */
    _createMessageRow(message) {
        if(message === null) {
            return null;
        }
        // debug(message);
        let incoming = (message.type === Sms.MessageBox.INBOX);

        let row = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            hexpand: true,
            visible: true
        });

        // Sort properties
        row.sender = message.addresses[0].address || 'unknown';
        row.message = message;
        row.grid = new Gtk.Grid({
            can_focus: false,
            hexpand: true,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: incoming ? 18 : 6,
            //margin: 6,
            column_spacing: 6,
            halign: incoming ? Gtk.Align.START : Gtk.Align.END
        });
        row.add(row.grid);

        // Add avatar for incoming messages
        if (incoming) {
            // Ensure we have a contact
            if (this.contacts[row.sender] === undefined) {
                this.contacts[row.sender] = this.device.contacts.query({
                    number: row.sender
                });
            }

            row.avatar = new Contacts.Avatar(this.contacts[row.sender]);
            row.avatar.valign = Gtk.Align.END;
            row.grid.attach(row.avatar, 0, 1, 1, 1);

            row.senderLabel = new Gtk.Label({
                label: '<span size="small" weight="bold">' + this.contacts[row.sender].name + '</span>',
                halign: Gtk.Align.START,
                valign: Gtk.Align.START,
                use_markup: true,
                margin_bottom: 0,
                margin_start: 6,
            });
            row.grid.attach(row.senderLabel, 1, 0, 1, 1);
        }

        let widget = new MessageLabel(message);
        row.grid.attach(widget, 1, 1, 1, 1);

        row.show_all();

        return row;
    }

    _updateThreadMessages(store, thread) {
        if (thread !== null) {
            this.__messages = this.__messages.concat(thread.messages(25, this.fetchMessageTimestamp));
            this.logPrevious();
        }
    }
    _populateMessages() {
        // // TODO Is this handled by onEdgeReached now?
        // this.__first = null;
        // this.__last = null;
        // this.__pos = 0;
        // this.__messages = [];
        // // this.list.clear();

        // // Try and find a thread_id for this number
        // if (this.thread_id === null && this.addresses.length) {
        //     this.thread_id = this.plugin.getThreadIdForAddresses(this.addresses);
        // }

        // // Make a copy of the thread and fill the window with messages
        // debug(`Fetching thread ${this.thread_id}`);
        // if (this.plugin.threads.hasThread(this.thread_id)) {
        //     this.__messages = this.__messages.concat(this.plugin.threads.getMessagesForThread(this.thread_id, 25));
        //     this.logPrevious();
        // }
    }

    _headerMessages(row, before) {
        // Skip pending
        if (row.get_name() === 'pending') return;

        if (before === null) {
            Sms.setAvatarVisible(row, true);
            return;
        }

        // Add date header if the last message was more than an hour ago
        let header = row.get_header();

        if ((row.message.date - before.message.date) > GLib.TIME_SPAN_HOUR / 1000) {
            if (!header) {
                header = new Gtk.Label({visible: true});
                header.get_style_context().add_class('dim-label');
                row.set_header(header);
            }

            header.label = Sms.getTime(row.message.date);

            // Also show the avatar
            Sms.setAvatarVisible(row, true);

            if (row.senderLabel) {
                row.senderLabel.visible = row.message.addresses.length > 1;
            }

            // Or if the previous sender was the same, hide its avatar
        } else if (row.message.type === before.message.type &&
            row.sender.equalsPhoneNumber(before.sender)) {
            Sms.setAvatarVisible(before, false);
            Sms.setAvatarVisible(row, true);

            if (row.senderLabel) {
                row.senderLabel.visible = false;
            }

            // otherwise show the avatar
        } else {
            Sms.setAvatarVisible(row, true);
        }
    }

    _holdPosition() {
        this.__pos = this._vadj.get_upper() - this._vadj.get_value();
    }

    _releasePosition() {
        this.__pos = 0;
    }

    _scrollPosition(pos = Gtk.PositionType.BOTTOM, animate = true) {
        let vpos = pos;
        this._vadj.freeze_notify();

        if (pos === Gtk.PositionType.BOTTOM) {
            vpos = this._vadj.get_upper() - this._vadj.get_page_size();
        }


        if (animate) {
            Tweener.addTween(this._vadj, {
                value: vpos,
                time: 0.5,
                transition: 'easeInOutCubic',
                onComplete: () => this._vadj.thaw_notify()
            });
        } else {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._vadj.set_value(vpos);
                this._vadj.thaw_notify();
            });
        }
    }

    // _sortMessages(row1, row2) {

    //     // If we only have one message
    //     if (!row1.message || !row2.message)
    //         return true;
    //     return (row1.message.date > row2.message.date) ? 1 : -1;
    // }

    /**
     * Log the next message in the conversation.
     *
     * @param {object} message - A message object
     */
    logNext(message) {
        // try {
        //     // TODO: Unsupported MessageBox
        //     if (message.type !== Sms.MessageBox.INBOX &&
        //         message.type !== Sms.MessageBox.SENT)
        //         return;

        //     // Append the message
        //     let row = this._createMessageRow(message);
        //     this.list.add(row);
        //     this.list.invalidate_headers();

        //     // Remove the first pending message
        //     if (this.has_pending && message.type === Sms.MessageBox.SENT) {
        //         this.pending_box.get_children()[0].destroy();
        //         this.notify('has-pending');
        //     }
        // } catch (e) {
        //     debug(e);
        // }
    }

    /**
     * Log the previous message in the thread
     */
    logPrevious() {
        // try {
        //     // debug(this.__messages);
        //     let message = this.__messages.pop();
        //     if (!message) return;

        //     // TODO: Unsupported MessageBox
        //     if (message.type !== Sms.MessageBox.INBOX &&
        //         message.type !== Sms.MessageBox.SENT &&
        //         message.type !== Sms.MessageBox.ALL) {
        //         throw TypeError(`invalid message box "${message.type}"`);
        //     }

        //     // Prepend the message
        //     let row = this._createMessageRow(message);
        //     this.list.prepend(row);
        //     this.list.invalidate_headers();

        //     // Recurse
        //     if (this.__messages.length > 0)
        //         this.logPrevious();
        // } catch (e) {
        //     debug(e);
        // }
    }

    /**
     * Set the contents of the message entry
     *
     * @param {string} text - The message to place in the entry
     */
    setMessage(text) {
        this.entry.text = text;
        this.entry.emit('move-cursor', 0, text.length, false);
    }
});
