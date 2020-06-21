'use strict';

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Contacts = imports.service.ui.contacts;
const Sms = imports.service.plugins.sms;
/**
 * A ListBoxRow for a preview of a conversation
 */
var ThreadRow = GObject.registerClass({
    GTypeName: 'GSConnectThreadRow'
}, class ThreadRow extends Gtk.ListBoxRow {
    _init(contacts, message) {
        super._init({visible: true});

        // Row layout
        let grid = new Gtk.Grid({
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 8,
            margin_end: 8,
            column_spacing: 8,
            visible: true
        });
        this.add(grid);

        // Contact Avatar
        this._avatar = new Contacts.Avatar(null);
        grid.attach(this._avatar, 0, 0, 1, 3);

        // Contact Name
        this._name = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
            visible: true
        });
        grid.attach(this._name, 1, 0, 1, 1);

        // Message Time
        this._time = new Gtk.Label({
            halign: Gtk.Align.END,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
            visible: true
        });
        this._time.get_style_context().add_class('dim-label');
        grid.attach(this._time, 2, 0, 1, 1);

        // Message Body
        this._body = new Gtk.Label({
            halign: Gtk.Align.START,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
            visible: true
        });
        grid.attach(this._body, 1, 1, 2, 1);

        this.contacts = contacts;
        this.message = message;
    }

    get date() {
        return this._message.date;
    }

    get thread_id() {
        return this._message.thread_id;
    }

    get message() {
        return this._message;
    }

    set message(message) {
        this._message = message;
        this._sender = message.addresses[0].address || 'unknown';

        // Contact Name
        let nameLabel = _('Unknown Contact');
        // Update avatar for single-recipient messages
        if (message.addresses.length === 1) {
            this._avatar.contact = this.contacts[this._sender];
            nameLabel = GLib.markup_escape_text(this._avatar.contact.name, -1);
        } else {
            this._avatar.contact = null;
            nameLabel = _('Group Message');
            let participants = [];
            message.addresses.forEach((address) => {
                participants.push(this.contacts[address.address].name);
            });
            this._name.tooltip_text = participants.join(', ');
        }

        // Contact Name & Message body
        let bodyLabel = message.body.split(/\r|\n/)[0];
        bodyLabel = GLib.markup_escape_text(bodyLabel, -1);


        // Ignore the 'read' flag if it's an outgoing message
        if (message.type === Sms.MessageBox.SENT) {
            // TRANSLATORS: An outgoing message body in a conversation summary
            bodyLabel = _('You: %s').format(bodyLabel);

            // Otherwise make it bold if it's unread
        } else if (message.read === Sms.MessageStatus.UNREAD) {
            nameLabel = '<b>' + nameLabel + '</b>';
            bodyLabel = '<b>' + bodyLabel + '</b>';
        }

        // Set the labels, body always smaller
        this._name.label = nameLabel;
        this._body.label = '<small>' + bodyLabel + '</small>';

        // Time
        let timeLabel = '<small>' + Sms.getShortTime(message.date) + '</small>';
        this._time.label = timeLabel;
    }

    update() {
        let timeLabel = '<small>' + Sms.getShortTime(this.message.date) + '</small>';
        this._time.label = timeLabel;
    }
});
