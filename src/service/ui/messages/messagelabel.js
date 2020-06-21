'use strict';

const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Sms = imports.service.plugins.sms;
const URI = imports.utils.uri;
/**
 * A simple GtkLabel subclass with a chat bubble appearance
 */
var MessageLabel = GObject.registerClass({
    GTypeName: 'GSConnectMessageLabel'
}, class MessageLabel extends Gtk.Label {

    _init(message) {
        this.message = message;
        let incoming = (message.type === Sms.MessageBox.INBOX);

        super._init({
            label: URI.linkify(message.body, message.date),
            halign: incoming ? Gtk.Align.START : Gtk.Align.END,
            selectable: true,
            tooltip_text: Sms.getDetailedTime(message.date),
            use_markup: true,
            visible: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: 0
        });

        if (incoming) {
            this.get_style_context().add_class('message-in');
        } else {
            this.get_style_context().add_class('message-out');
        }
    }

    vfunc_activate_link(uri) {
        Gtk.show_uri_on_window(
            this.get_toplevel(),
            uri.includes('://') ? uri : `http://${uri}`,
            Gtk.get_current_event_time()
        );

        return true;
    }

    vfunc_query_tooltip(x, y, keyboard_tooltip, tooltip) {
        if (super.vfunc_query_tooltip(x, y, keyboard_tooltip, tooltip)) {
            tooltip.set_text(Sms.getDetailedTime(this.message.date));
            return true;
        }

        return false;
    }
});
