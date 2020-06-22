'use strict';

const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const {MessagingWindow} = imports.service.ui.messages.window;
/**
 * A Gtk.ApplicationWindow for selecting from open conversations
 */
var ConversationChooser = GObject.registerClass({
    GTypeName: 'GSConnectConversationChooser',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'message': GObject.ParamSpec.string(
            'message',
            'Message',
            'The message to share',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin providing messages',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        )
    }
}, class ConversationChooser extends Gtk.ApplicationWindow {

    _init(params) {
        super._init(Object.assign({
            title: _('Share Link'),
            default_width: 300,
            default_height: 200
        }, params));
        this.set_keep_above(true);

        // HeaderBar
        this.headerbar = new Gtk.HeaderBar({
            title: _('Share Link'),
            subtitle: this.message,
            show_close_button: true,
            tooltip_text: this.message
        });
        this.set_titlebar(this.headerbar);

        let newButton = new Gtk.Button({
            image: new Gtk.Image({icon_name: 'list-add-symbolic'}),
            tooltip_text: _('New Conversation'),
            always_show_image: true
        });
        newButton.connect('clicked', this._new.bind(this));
        this.headerbar.pack_start(newButton);

        // Threads
        let scrolledWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this.add(scrolledWindow);

        this.thread_list = new Gtk.ListBox({
            activate_on_single_click: false
        });
        // this.thread_list.bind_model(this)
        this.thread_list.set_sort_func(MessagingWindow.prototype._sortThreads);
        this.thread_list.connect('row-activated', this._select.bind(this));
        scrolledWindow.add(this.thread_list);

        // Filter Setup
        MessagingWindow.prototype._onThreadsChanged.call(this);
        this.show_all();
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    _new(button) {
        let message = this.message;
        this.destroy();

        this.plugin.sms();
        this.plugin.window._onNewConversation();
        this.plugin.window._pendingShare = message;
    }

    _select(box, row) {
        this.plugin.sms();
        this.plugin.window.thread_id = row.message.thread_id.toString();
        this.plugin.window.setMessage(this.message);

        this.destroy();
    }
});
