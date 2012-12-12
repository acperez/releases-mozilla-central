/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const DEBUG = true;
function debug(s) { dump("-*- udp_server_worker: " + s + "\n"); }

if (!this.ctypes) {
  this.EXPORTED_SYMBOLS = [ "libcutils", "libnetutils", "netHelpers" ];
  Components.utils.import("resource://gre/modules/ctypes.jsm");
}

/*
debug("hola");
var fnptr_t = ctypes.FunctionType(ctypes.default_abi, ctypes.void_t, []).ptr;
fnptr_t(function() {})();  // don't crash
debug("adeu");
*/

const OK = 0;
const SOCKET_ERR = -1;
const BIND_ERR = -2;

let UDP_SERVER = {

  init: function init() {
    if (DEBUG) {
      debug("Init");
    }

    this.lib = ctypes.open("libudpserver.so");
    this.udp_init = this.lib.declare("server_init",      /* function name */
                                     ctypes.default_abi, /* call ABI */
                                     ctypes.int,         /* return result */
                                     ctypes.int);        /* port number */

    this.udp_listen = this.lib.declare("server_listen",    /* function name */
                                       ctypes.default_abi, /* call ABI */
                                       ctypes.int);        /* return event */

    this.udp_shutdown = this.lib.declare("server_shutdown",  /* function name */
                                         ctypes.default_abi, /* call ABI */
                                         ctypes.int);        /* return result */

    let message = {udpServerMsgType: "getUDPServerConf"};
    postMessage(message);
  },

  /**
   * Handle incoming messages from the main UI thread.
   */
  handleMessage: function handleMessage(message) {
    if (DEBUG) debug("Received message: " + JSON.stringify(message));
    switch (message.udpServerMsgType) {
      case "serverConf":
        this.initServer(message.port);
        break;
      case "shutdown":
        this.serverShutdown();
        break;
      default:
        throw new Error("Don't know about this message type: " +
                        message.udpServerMsgType);
    }
  },

  initServer: function initServer(port) {
    let result = this.udp_init(port);
    switch (result) {
      case OK:
        debug("Socket ready");
        this.listen();
        break;
      case SOCKET_ERR:
        debug("Socket creation error");
        break;
      case BIND_ERR:
        debug("Error binding socket");
        break;
      default:
        debug("Unknown error " + result);
    }
  },

  listen: function listen() {
    debug("listen");
    let data = this.udp_listen();

    if (data == OK ) {
      postMessage({udpServerMsgType: "dataAvailable"});
    }

    this.listen();
  },

  serverShutdown: function serverShutdown() {
    this.lib.close();
  }
}

UDP_SERVER.init();

onmessage = function onmessage(event) {
  UDP_SERVER.handleMessage(event.data);
};

onerror = function onerror(event) {
  debug("UDP Server Worker error" + event.message + "\n");
};
