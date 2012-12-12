/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const DEBUG = true;
function debug(s) { dump("-*- PushNotificationService: " + s + "\n"); }

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/PushNotificationDB.jsm");

const PUSHNOTIFICATIONSERVICE_CONTRACTID = "@mozilla.org/pushnotificationservice;1";
const PUSHNOTIFICATIONSERVICE_CID = Components.ID("{535a5dff-ad11-48b3-8577-933570c145e9}");

const kDefaultReceiverPort = 5000
const kNetworkInterfaceStateChangedTopic = "network-interface-state-changed";
const kXpcomShutdownObserverTopic        = "xpcom-shutdown";
const kMobileConnectionChangedTopic      = "mobile-connection-iccinfo-changed";

const kPUSHNOTIFICATION_PREF_BRANCH = "network.push-notification.";
const kNS_NETWORK_PROTOCOL_CONTRACTID_PREFIX =
  "@mozilla.org/network/protocol;1?name=";
const kWS_CONTRACTID = kNS_NETWORK_PROTOCOL_CONTRACTID_PREFIX + "ws";
const kWSS_CONTRACTID = kNS_NETWORK_PROTOCOL_CONTRACTID_PREFIX + "wss";

const kSYSTEMMESSAGEINTERNAL_CONTRACTID =
  "@mozilla.org/system-message-internal;1";

//const KEEP_ALIVE_TIMEOUT = 1000 * 60 * 5;
const KEEP_ALIVE_TIMEOUT = 1000 * 30;
const SEND_MSG_TIMEOUT = 1000 * 30;
const CON_RETRY_TIME = 1000 * 30;

XPCOMUtils.defineLazyServiceGetter(this, "rilContentHelper",
                                   "@mozilla.org/ril/content-helper;1",
                                   "nsIMobileConnectionProvider");

XPCOMUtils.defineLazyServiceGetter(this, "ppmm",
                                   "@mozilla.org/parentprocessmessagemanager;1",
                                   "nsIMessageListenerManager");

const GLOBAL_SCOPE = this;          // global object for IndexedDB manager

function PushNotificationService() {
  this.init();
}

PushNotificationService.prototype = {

  nsURL: "ws://example.com:8080/", // URI of the notification server
  uatokenURL: "http://example:8080/", // URI for retrieving the UA token
  port: 0,
  uatoken: null,
  mcc: 0,
  mnc: 0,
  connection: false,
  udpModeEnabled: false,
  requestQueue: null,
  ws: null,
  currentSlave: null,           // slave object for running a task
  savedSlave: null,
  ip: null,

  init: function() {
    if (DEBUG) {
      debug("init");
    }
    Services.obs.addObserver(this, kMobileConnectionChangedTopic, false);
    Services.obs.addObserver(this, kNetworkInterfaceStateChangedTopic, false);

    this.messages = ["PushNotification:GetURL",
                     "PushNotification:CurrentURL",
                     "PushNotification:RevokeURL"];

    this.messages.forEach(function(msgName) {
      ppmm.addMessageListener(msgName, this);
    }, this);

    this.keep_alive_timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this.send_msg_timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this.con_retry_timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);

    this.requestQueue = [];

    this.readPrefs();

    this.mcc = rilContentHelper.iccInfo.mcc;
    this.mnc = rilContentHelper.iccInfo.mnc;

    this._db = new PushNotificationDB(GLOBAL_SCOPE, function dbReady(success, error) {
      if (error) {
        if (DEBUG) {
          debug("Error opening DB");
        }
        return;
      }

      this.getUATokenFromDB();

    }.bind(this));

    this.worker = new ChromeWorker("resource://gre/modules/udp_server_worker.js");
    this.worker.onerror = this.onerror.bind(this);
    this.worker.onmessage = this.onmessage.bind(this);
  },

  readPrefs: function readPrefs() {
    let branch = Services.prefs.getBranch(kPUSHNOTIFICATION_PREF_BRANCH);
    try {
      let nsURL = branch.getCharPref("notification-server");
      this.nsURL = nsURL;
    } catch (e) {
    }
    try {
      let uatokenURL = branch.getCharPref("user-agent-token-server");
      this.uatokenURL = uatokenURL;
    } catch (e) {
    }

    // receiver port: optional
    let port = kDefaultReceiverPort;
    try {
      port = branch.getIntPref("receiver-port");
    } catch (e) {
    }
    this.port = port;

  },

  // Worker communication
  onerror: function onerror(event) {
    debug("Got an error: " + event.filename + ":" +
           event.lineno + ": " + event.message + "\n");
           event.preventDefault();
  },

  onmessage: function onmessage(event) {
    let message = event.data;
    debug("Received message from worker: " + JSON.stringify(message));
    switch (message.udpServerMsgType) {
      case "getUDPServerConf":
        this.worker.postMessage({udpServerMsgType: "serverConf",
                                 port: this.port});
        break;
      case "dataAvailable":
        this.connect();
        break;
      default:
        throw new Error("Don't know about this message type: " +
                        message.udpServerMsgType);
    }
  },

  observe: function observe(subject, topic, data) {
    switch (topic) {
      case kMobileConnectionChangedTopic:
        this.mcc = rilContentHelper.iccInfo.mcc;
        this.mnc = rilContentHelper.iccInfo.mnc;
        if (DEBUG) {
          debug("Mobile connection change");
          debug("mcc: " + this.mcc + " - mnc: " + this.mnc);
        }
        break;

      case kNetworkInterfaceStateChangedTopic:
        let iface = subject.QueryInterface(Ci.nsINetworkInterface);
        if ((iface.type == Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE)
            || (iface.type == Ci.nsINetworkInterface.NETWORK_TYPE_WIFI)) {

          this.connection = (iface.state == Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED);
          if (DEBUG) {
            debug("Network status change - connection available: " + this.connection);
          }

          if (this.connection) {
            // Set udp mode to false until negotiated with push server
            this.udpModeEnabled = false;

            if (iface.type == Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE) {
              if (DEBUG) {
                debug("Mobile connection");
              }
              this.mcc = rilContentHelper.iccInfo.mcc;
              this.mnc = rilContentHelper.iccInfo.mnc;
              this.ip = iface.ip;
            } else {
              if (DEBUG) {
                debug("Wifi connection");
              }
              
              /*this.mcc = 0;
              this.mnc = 0;
              this.ip = null;*/
              

              this.mcc = rilContentHelper.iccInfo.mcc;
              this.mnc = rilContentHelper.iccInfo.mnc;
              this.ip = iface.ip;
            }

            this.connect();
          }
        }
        break;

      case kXpcomShutdownObserverTopic:
        if (DEBUG) {
          debug("Service shutdown");
        }

        this.messages.forEach(function(msgName) {
          ppmm.removeMessageListener(msgName, this);
        }, this);

        Services.obs.removeObserver(this, kXpcomShutdownObserverTopic);
        Services.obs.removeObserver(this, kNetworkInterfaceStateChangedTopic);
        Services.obs.removeObserver(this, kMobileConnectionChangedTopic);
        break;
    }
  },

  connect: function() {
    if (this.connection) {
      if (!this.uatoken) {
        this.addSlave(new slaveGetRemoteUAToken(this));
      }

      if (!this.ws && this.uatoken) {
        this.addSlave(new slaveRegisterUA(this));
      }
    }
  },

  getUATokenFromDB: function() {
    this._db.getUAData(function getToken(uaToken) {
      if (uaToken != null) {
        this.uatoken = uaToken;
        if (DEBUG) {
          debug("UA Token from DB: " + this.uatoken);
        }
        return;
      }

      let slave = new slaveGetRemoteUAToken(this);
      this.addSlave(slave);

    }.bind(this));
  },

  receiveMessage: function(aMessage) {
    if (DEBUG) {
      debug("Received internal message: " + aMessage.name);
    }
    let mm = aMessage.target;
    let msg = aMessage.json;

    switch (aMessage.name) {
      case "PushNotification:GetURL":
        this.getURL(mm, msg);
        break;
      case "PushNotification:CurrentURL":
        this.getCurrentURL(mm, msg);
        break;
      case "PushNotification:RevokeURL":
        break;
    }
  },

  getURL: function(mm, msg) {
    this._db.getWA(msg.manifestURL, msg.watoken, function (error, success){

      if (success) {
        if (DEBUG) {
          debug("URL from DB: " + success);
        }
        mm.sendAsyncMessage("PushNotification:GetURL:Return",
                            { id: msg.id, error: null, result: success });
        return;
      }

      this.connect();

      let slave = new slaveRegisterWA(this,
                                      msg.pageURL,
                                      msg.manifestURL,
                                      msg.watoken,
                                      msg.pubkey,
                                      msg.id,
                                      mm);
      this.addSlave(slave);

    }.bind(this));
  },

  getCurrentURL: function (mm, msg) {
    this._db.getWA(msg.manifestURL, msg.watoken, function (error, success){
      if (success) {
        mm.sendAsyncMessage("PushNotification:CurrentURL:Return",
                            { id: msg.id, error: null, result: success })
        return;
      }

      mm.sendAsyncMessage("PushNotification:CurrentURL:Return",
                            { id: msg.id, error: true, result: null })
    });
  },


  sendMsg: function sendMsg(message, noResponseRequired) {
    if (!noResponseRequired) {
      this.keep_alive_timer.cancel();
      this.send_msg_timer.initWithCallback(this, SEND_MSG_TIMEOUT, Ci.nsITimer.TYPE_ONE_SHOT);
    }

    if (DEBUG) {
      debug("Send message: " + message);
    }
    this.ws.sendMsg(message);
  },

  /*
   * nsITimerCallback
   */
  notify: function notify(timer) {
    if (timer == this.keep_alive_timer) {
      this.addSlave(new slaveSendPing(this));
      return;
    }

    if (timer == this.send_msg_timer) {
      if (DEBUG) {
        debug("Server response timeout");
      }
      this.ws.close(Ci.nsIWebSocketChannel.CLOSE_GOING_AWAY, "Send Message Timeout");
      this.ws = null;
      this.send_msg_timer.cancel();
      return;
    }

    if (timer == this.con_retry_timer) {
      if (DEBUG) {
        debug("Try to reconnect");
      }

      this.connect()
    }
  },

  callFirstSlave: function() {
    this.currentSlave = this.requestQueue[0];
    this.currentSlave.start();
  },

  addSlave: function(slave) {
    this.requestQueue.push(slave);
    if (this.requestQueue.length == 1) {
      this.savedSlave = this.currentSlave;
      this.currentSlave = this.requestQueue[0];
      this.currentSlave.start();
    }
  },

  finishSlave: function() {
    this.requestQueue.splice(0, 1);
    if (this.requestQueue.length) {
      this.currentSlave = this.requestQueue[0];
      this.currentSlave.start();
    } else {
      this.currentSlave = this.savedSlave;
    }
  },

  installSavedSlave: function(slave) {
    this.savedSlave = slave;
  },

  // nsIWebSocketListener

  /* All following functions only a bridge to relay message to the
   * current slave.
   */

  onStart: function onStart(context) {
    this.keep_alive_timer.initWithCallback(this, KEEP_ALIVE_TIMEOUT,
                                           Ci.nsITimer.TYPE_ONE_SHOT);

    let slave = this.currentSlave;
    if (slave && slave.onStart) {
      slave.onStart(context);
    }
  },

  onMessageAvailable: function onMessageAvailable(context, msg) {
    this.send_msg_timer.cancel();
    this.keep_alive_timer.initWithCallback(this, KEEP_ALIVE_TIMEOUT,
                                           Ci.nsITimer.TYPE_ONE_SHOT);

    if (DEBUG) {
      debug("Message from server: " + msg);
    }

    let slave = this.currentSlave;
    if (slave && slave.onMessageAvailable) {
      slave.onMessageAvailable(context, msg);
    }
  },

  onStop: function onStop(context, statusCode) {
    if (DEBUG) {
      debug("Websocket closed");
    }

    this.closeConnection(context, statusCode);
  },

  onServerClose: function onServerClose(context, statusCode, reason) {
    if (DEBUG) {
      debug("Websocket closed by remote server");
    }
  },

  closeConnection: function closeConnection(context, statusCode) {
    this.keep_alive_timer.cancel();
    this.send_msg_timer.cancel();

    this.ws = null;

    let slave = this.currentSlave;
    if (slave && slave.onStop) {
      slave.onStop(statusCode);
    }

    if (!this.udpModeEnabled) {
      this.con_retry_timer.initWithCallback(this, CON_RETRY_TIME,
                                            Ci.nsITimer.TYPE_ONE_SHOT);
    }

    this.currentSlave = null;
  },

  onBinaryMessageAvailable: function onBinaryMessageAvailable(context,
                                                              msg) {
  },

  onAcknowledge: function onAcknowledge(context, size) {
  },

  // nsIPushNotificationService

  hasSupport: function hasSupport() {
    return true;
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIPushNotificationService,
                                         Ci.nsIWebSocketListener,
                                         Ci.nsIObserver]),
  classID:   PUSHNOTIFICATIONSERVICE_CID,

  classInfo : XPCOMUtils.generateCI({classID: PUSHNOTIFICATIONSERVICE_CID,
                                     classDescription: "PushNotificationService",
                                     interfaces: [Ci.nsIPushNotificationService,
                                                  Ci.nsIWebSocketListener]})
};
this.NSGetFactory = XPCOMUtils.generateNSGetFactory([PushNotificationService]);


/**
 * Request UA token.
 */
function slaveGetRemoteUAToken(master) {
  this.master = master;
}

slaveGetRemoteUAToken.prototype = {

  start: function start() {
    if (DEBUG) {
      debug("Retrieve UA Token worker from server");
    }

    if (this.master.uatoken != null) {
      this.master.finishSlave();
      return;
    }

    if (!this.master.connection) {
      if (DEBUG) {
        debug("Can't retrieve UA token from server because network connection is not available");
      }
      this.master.finishSlave();
      return;
    }

    this.getRemoteUAToken();
  },

  getRemoteUAToken: function getRemoteUAToken() {
    if (DEBUG) {
      debug("UA token server host: " + this.master.uatokenURL);
    }
    try {
      let xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);

      xhr.open("GET", this.master.uatokenURL, true);
      xhr.onreadystatechange = function statechange(e) {
        if (DEBUG) {
          debug("getUAToken readystate=" + xhr.readyState +
            ", status=" + xhr.status);
        }
        if (xhr.readyState == 4) {
          if (xhr.status == 200) {
            this.master.uatoken = xhr.responseText.trim();
            this.master._db.saveUAData(this.master.uatoken);
            debug("UA token from server: " + this.master.uatoken);
            this.master.addSlave(new slaveRegisterUA(this.master));
          } else {
            this.master.con_retry_timer.initWithCallback(this.master, CON_RETRY_TIME,
                                            Ci.nsITimer.TYPE_ONE_SHOT);
            debug("Error retrieving UA token");
          }
          this.master.finishSlave();
        }
      }.bind(this);
      xhr.send();
    } catch (e) {
      debug("xhr error, can't send: " + e.message);
      this.master.con_retry_timer.initWithCallback(this.master, CON_RETRY_TIME,
                                            Ci.nsITimer.TYPE_ONE_SHOT);
      this.master.finishSlave()
    }
  }
};


function Notifier(pageURL, manifestURL, msg) {
  this.pageURL = pageURL;
  this.manifestURL = manifestURL;
  this.msg = msg;
}

Notifier.prototype = {
  // interface nsIAlertsService
  observe: function observe(subject, topic, cookie) {
    if (topic == "alertclickcallback") {
      this.notifyApp();
    }
  },

  notifyApp: function notifyApp() {
    if (DEBUG) {
      debug("Send notification to " + this.pageURL);
    }

    let smi = Cc[kSYSTEMMESSAGEINTERNAL_CONTRACTID].
      getService(Ci.nsISystemMessagesInternal);
    let pageURI = Services.io.newURI(this.pageURL, null, null);
    let manifestURI = Services.io.newURI(this.manifestURL, null, null);
    smi.sendMessage("notification", this.msg, pageURI, manifestURI);
  }
};

/**
 * Register user agent.
 */
function slaveRegisterUA(master) {
  this.master = master;
  this.ip = master.ip;
  this.port = master.port;
  this.mcc = master.mcc;
  this.mnc = master.mnc;
}

slaveRegisterUA.prototype = {
  ip: null,                     // IP address of UDP wakeup port
  port: null,                   // Port number of weakup port
  mcc: null,
  mnc: null,
  request: null,                // User's request object

  start: function start() {
    if (DEBUG) {
      debug("Register UA worker");
    }
    let self = this;
    if (this.master.ws) {
      if (DEBUG) {
        debug("There is already one connection");
      }

      this.master.finishSlave();
      return;
    }

    this.master.ws = this.createWS(this.master);
  },

  createWS: function createWS(listener) {
    if (DEBUG) {
      debug("Create websocket to " + this.master.nsURL);
    }
    let uri = Cc["@mozilla.org/network/standard-url;1"].
      createInstance(Ci.nsIURI);
    let manifestURL = "http://test.example.com/test";
    uri.spec = this.master.nsURL;
    let pref = this.master.nsURL.substring(0, 3);
    let ws;
    if (pref == "ws:") {
      ws = Cc[kWS_CONTRACTID].createInstance(Ci.nsIWebSocketChannel);
    } else if (pref == "wss") {
      ws =  Cc[kWSS_CONTRACTID].createInstance(Ci.nsIWebSocketChannel);
    } else {
      throw "Invalid URL";
    }
    ws.protocol = "push-notification";
    ws.asyncOpen(uri, this.master.nsURL, listener, null);
    return ws;
  },

  // nsIWebSocketListener; relayed by the master.

  // Relayed from nsPushNotification::onStart()
  onStart: function onStart(context) {
    let msg = {
      messageType: "registerUA",
      data: {
        uatoken: this.master.uatoken,
        "interface": {
          ip: this.ip,
          port: this.port
        },
        "mobilenetwork": {
          mcc: this.mcc,
          mnc: this.mnc
        }
      }
    };
    this.master.sendMsg(JSON.stringify(msg));
  },

  onStop: function onStop(status) {
    this.master.finishSlave();
  },

  // Relayed from nsPushNotification::onMessageAvailable()
  onMessageAvailable: function onMessageAvailable(context, msg) {
    let msgobj = JSON.parse(msg);

    if (msgobj.status == "REGISTERED") {
      // Let slaveNotificationReceiver to handle notifications.
      let receiver = new slaveNotificationReceiver(this.master);
      this.master.installSavedSlave(receiver);

      this.master.requestQueue.splice(1, 0, new slaveSyncUA(this.master, msgobj));
    } else {
      if (this.master.ws) {
        this.master.ws.close(0, "invalid status");
      }
      this.master.ws = null;
    }

    this.master.finishSlave();
  }
};

/**
 * Handle notification from the notification server.
 */
function slaveNotificationReceiver(master) {
  this.master = master;
}

slaveNotificationReceiver.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver]),

  onMessageAvailable: function onMessageAvailable(context, msg) {
    if (DEBUG) {
      debug("NotificationReceiver worker");
      debug(msg);
    }
    let msgo = JSON.parse(msg);

    if (!Array.isArray(msgo)) {
      msgo = [msgo];
    }

    try {
      let self = this;
      msgo.forEach(function (msg_item) {
        let handler =
          self['handle_msg_' + msg_item.messageType].bind(self);
        handler(msg_item);
      });
    } catch(e) {
      if (DEBUG) {
        debug("Exception: " + e );
      }
    }
  },

  handle_msg_notification: function handle_msg_notification(msg) {
    let self = this;

    this.master._db.getWAURL(msg.url, function (event){
      if (this.result) {
        let {pageURL: pageURL, manifestURL: manifestURL} = this.result;
        self.notify(pageURL, manifestURL, msg);
      } else {
        if (DEBUG) {
          debug("Drop notification because token not found in DB");
        }
      }
    });
  },

  notify: function notify(pageURL, manifestURL, msg) {
    if (DEBUG) {
      debug("Notify: " + pageURL + ", " +
        manifestURL + ", " + JSON.stringify(msg));
    }

    let appsService = Cc["@mozilla.org/AppsService;1"]
                        .getService(Ci.nsIAppsService);
    let app = appsService.getAppByManifestURL(manifestURL);

    // Check if app is running
    let content = Services.wm.getMostRecentWindow("navigator:browser").
                              getContentWindow();
    if (content.document.querySelector('iframe[data-frame-origin="' + app.origin  + '"]')) {
      // Send notification to app
      let notifier = new Notifier(pageURL, manifestURL, msg);
      notifier.notifyApp();
    } else {
      if (DEBUG) {
        debug("App not running, send alert to status bar");
      }

      let AlertsService = Cc["@mozilla.org/alerts-service;1"].
                             getService(Ci.nsIAlertsService);


      let self = this;
      Cu.import("resource://gre/modules/AppsUtils.jsm");
      Cu.import("resource://gre/modules/Webapps.jsm"); // if import at the start of the file, cause error first time boot

      DOMApplicationRegistry.getManifestFor(app.origin, function getManifest(aManifest) {
        let helper = new ManifestHelper(aManifest, app.origin);

        AlertsService.showAlertNotification(helper.iconURLForSize(0),
                                            helper.name,
                                            "New notification",
                                            true,
                                            null,
                                            new Notifier(pageURL, manifestURL, msg),
                                            "");
      });
    }
  },
};

function slaveNotificationBase(master) {
  this.master = master;
  this.msgqueue = [];
}

slaveNotificationBase.prototype = new slaveNotificationReceiver();
extend(slaveNotificationBase.prototype, {
  // queue all messages until registration is finished.
  msgqueue: null,

  handle_msg_notification: function handle_msg_notification(msg) {
    this.msgqueue.push(msg);
  },

  // private
  // dispatch queued messages
  dispatchQueue: function dispatchQueue() {
    let self = this;
    this.msgqueue.forEach(function(msg) {
      self.master.currentSlave.handle_msg_notification(msg);
    });
    this.msgqueue.splice(0, this.msgqueue.length);
  },

  finish: function finish() {
    if (this.master.udpModeEnabled && this.master.requestQueue.length <= 1) {
      if (DEBUG) {
        debug("Close websocket and wait notifications through UDP");
      }

      this.master.ws.close(Ci.nsIWebSocketChannel.CLOSE_NORMAL, "Client close");
    }

    this.master.finishSlave();
    this.dispatchQueue();
  }
});

/**
 * Sync UA
 */
function slaveSyncUA(master, msg) {
  this.master = master;
  this.msg = msg;
}

slaveSyncUA.prototype = new slaveNotificationBase();
extend(slaveSyncUA.prototype, {

  start: function start() {
    if (DEBUG) {
      debug("Sync UA worker");
    }

    this.remoteSync();
  },

  remoteSync: function remoteSync() {
    let tokens = this.msg.WATokens;
    let notifications = this.msg.messages;
    let pushMode = this.msg.pushMode;

    this.master._db.getAllWA(function getAll(error, success) {
      if (success) {

        // Remove local tokens (db) not registered in push server
        success.forEach(function (token) {
          if (tokens.indexOf(token.URL) == -1) {

            if (DEBUG) {
              debug("WA token \"" + token.token + "\" has expired.");
            }
            this.master._db.forgetWA(token.manifestURL);
          }
        }.bind(this));

        // Send notifications to apps
        notifications.forEach(function (notification) {
          this.onMessageAvailable(this, JSON.stringify(notification.payload));

          let msg = {
            messageType: "ack",
            messageId: notification.payload.messageId 
          };
          this.master.sendMsg(JSON.stringify(msg), true);
        }.bind(this));

        if (pushMode == 'udp') {
          this.master.udpModeEnabled = true;
        }
      }

      this.finish();
    }.bind(this));
  },

});


/**
 * Send Ping worker.
 */
function slaveSendPing(master) {
  this.master = master;
}

slaveSendPing.prototype = new slaveNotificationBase();
extend(slaveSendPing.prototype, {

  start: function start() {
    if (DEBUG) {
      debug("Keep-alive worker");
    }
    let self = this;
    if (this.master.ws == null) {
      if (DEBUG) {
        debug("No connection available");
      }

      this.finish();
      return;
    }

    this.master.sendMsg("PING");
  },

  onStop: function onStop(status) {
    this.finish();
  },

  // Relayed from nsPushNotification::onMessageAvailable()
  onMessageAvailable: function onMessageAvailable(context, msg) {
    this.finish();
  }
});

/**
 * Register WEB application
 *
 * Only check database for the pushing URL if watoken is absent.
 */
function slaveRegisterWA(master, pageURL, manifestURL, watoken, pubkey, msgId, mm) {
  this.master = master;
  this.pageURL = pageURL;
  this.manifestURL = manifestURL;
  this.watoken = watoken;
  this.pubkey = pubkey;
  this.msgId = msgId;
  this.mm = mm;
}

slaveRegisterWA.prototype = new slaveNotificationBase();
extend(slaveRegisterWA.prototype, {
  master: null,
  pageURL: null,
  manifestURL: null,
  watoken: null,
  pubkey: null,
  request: null,

  start: function start() {
    if (DEBUG) {
      debug("Register WA worker");
    }

    if (!this.master.ws) {
      if (DEBUG) {
        debug("no websocket connection!");
      }

      this.doError("No network connection available");
      return;
    }

    this.sendRegisterWA();
  },

  sendRegisterWA: function sendRegisterWA() {
    let msg = {
      messageType: "registerWA",
      data: {
        watoken: this.watoken,
        pbkbase64: this.pubkey
      }
    };

    this.master.sendMsg(JSON.stringify(msg));
  },

  handle_msg_registerWA: function handle_msg_registerWA(msg) {
    if (msg.status == "REGISTERED") {
      this.doSuccess(msg.url);
    } else {
      this.doError("Registration denied by push server");
    }
  },

  doSuccess: function doSuccess(url) {
    this.master._db.saveWA(this.pageURL, this.manifestURL, this.watoken, url);

    this.mm.sendAsyncMessage("PushNotification:GetURL:Return",
                             { id: this.msgId, error: null, result: url })

    this.finish();
  },

  doError: function doError(msg) {
    this.master.currentSlave = null;

    this.mm.sendAsyncMessage("PushNotification:GetURL:Return",
                             { id: this.msgId, error: msg, result: null })

    this.finish();
  }
});

function extend(obj, ext) {
  for (let key in ext) {
    obj[key] = ext[key];
  }
}
