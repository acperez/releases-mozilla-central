/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = ['PushNotificationDB'];

const DEBUG = true;
function debug(s) { dump("-*- PushNotificationDB: " + s + "\n"); }

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/Services.jsm");

const DB_NAME = "push-notification-info";
const DB_VERSION = 1;
const UA_STORE_NAME = "ua-registration"; // name of data store for UA
const WA_STORE_NAME = "wa-registrations"; // name of data store for WA

this.PushNotificationDB = function PushNotificationDB(aGlobal, callback) {
  if (DEBUG) {
    debug("Init");
  }

  this.init(aGlobal, callback);
}

PushNotificationDB.prototype = {

  /**
   * Indexed DB saving information of UA and WA.
   *
   * There are two stores in the DB.  One is for saving information of
   * registered APPs (kDB_WA_STORE_NAME), another is for information
   * of user-agent itself (kDB_UA_STORE_NAME).
   */
  db: null,

  init: function(aGlobal, callback) {
    if (!aGlobal.indexedDB) {
      let idbMgr = Cc["@mozilla.org/dom/indexeddb/manager;1"].
                      getService(Ci.nsIIndexedDatabaseManager);
      idbMgr.initWindowless(aGlobal);
    }

    let request = aGlobal.indexedDB.open(DB_NAME);
    let self = this;
    request.onerror = function(event) {
      if (DEBUG) {
        debug("Can not open DB.");
      }
      if (callback) {
        callback(null, true);
      }
    };

    request.onupgradeneeded = function(event) {
      if (DEBUG) {
        debug("upgrade DB");
      }
      self.db = request.result;
      self.initStoreSchema();
    };
    request.onsuccess = function(event) {
      if (DEBUG) {
        debug("open DB onsuccess");
      }
      self.db = request.result;
      if (callback) {
        callback(true, null);
      }
    };
  },

  initStoreSchema: function() {
    let store = this.db.createObjectStore(WA_STORE_NAME,
                                          { keyPath: "manifestURL" });
    store.createIndex("tokens", "token", { unique: true });
    store.createIndex("URLs", "URL", { unique: true });

    store = this.db.createObjectStore(UA_STORE_NAME,
                              { keyPath: "key" });


  },

  /*
   * Every registered WA own an object in the store for WA.
   * The object are in the following format.
   *   {
   *     manifestURL: "http://....",
   *     pageURL: "http://....",
   *     token: "<Web Application token>",
   *     URL: "http://URL for web server to push messages"
   *   }
   */
  get store() {                 // data store for info. of WA
    let transaction =
      this.db.transaction([WA_STORE_NAME], "readwrite");
    let store = transaction.objectStore(WA_STORE_NAME);
    return store;
  },

  get tokens() {                // indexed by WA token
    let transaction =
      this.db.transaction([WA_STORE_NAME], "readonly");
    let store = transaction.objectStore(WA_STORE_NAME);
    let tokens = store.index("tokens");
    return tokens;
  },

  get URLs() {                  // indexed by push URL
    let transaction =
      this.db.transaction([WA_STORE_NAME], "readonly");
    let store = transaction.objectStore(WA_STORE_NAME);
    let URLs = store.index("URLs");
    return URLs;
  },

  get ua_store() {              // data store for info. of UA
    let transaction =
      this.db.transaction([UA_STORE_NAME], "readonly");
    let store = transaction.objectStore(UA_STORE_NAME);
    return store;
  },

  get ua_store_wr() {           // read-write version of store for UA
    let transaction =
      this.db.transaction([UA_STORE_NAME], "readwrite");
    let store = transaction.objectStore(UA_STORE_NAME);
    return store;
  },

  /* Get UA data from data store.
   *
   * The store for UA contain only one object in
   *     {key: "UAToken", value: "token value"}
   * format.
   */
  getUAData: function(callback) {
    if (DEBUG) {
      debug("getUAData");
    }

    let store = this.ua_store;

    let req = store.get("UAToken");
    req.onsuccess = function (event) {
      if (DEBUG) {
        debug("restoreUAData onsuccess");
      }
      let uatoken = null;
      if (this.result) {
        uatoken = this.result.value;
      }

      if (callback) {
        callback(uatoken);
      }
    };
    req.onerror = function (event) {
      if (DEBUG) {
        debug("restoreUAData onerror");
      }

      if (callback) {
        callback(null);
      }
    };
  },

  saveUAData: function(uatoken) {
    let store = this.ua_store_wr;
    store.put({key: "UAToken", value: uatoken});
  },

  saveWA: function(pageURL, manifestURL, watoken, url) {
    let store = this.store;

    let req = store.put({manifestURL: manifestURL,
                         pageURL: pageURL,
                         token: watoken,
                         URL: url});
    req.onerror = function(event) {
      if (DEBUG) {
        debug("Error saving WA");
      }
    };
  },

  forgetWA: function(manifestURL) {
    let req = this.store.delete(manifestURL);
  },

  forgetAllWA: function() {
    this.store.clear();
  },

  getWA: function(manifestURL, watoken, callback) {
    let req = manifestURL ?
      this.store.get(manifestURL) : this.tokens.get(watoken);
    req.onsuccess = function cb(event) {
      if (this.result && ((!watoken) || this.result.token == watoken)) {
        if (callback) {
          callback(null, this.result.URL);
        }
      } else {
        if (callback) {
          callback(true, null);
        }
      }
    };
  },

  /**
   * Retreieve the pushing URL from the datastore.
   *
   * @param manifestURL
   *        query WA info with manifestURL if it is not null.
   *        Or query WA info with watoek.
   * @param watoken
   *        is the token of the WA.
   */
  recallWA: function(manifestURL, watoken, request) {
    let req = manifestURL ?
      this.store.get(manifestURL) : this.tokens.get(watoken);
    req.onsuccess = function callback(event) {
      if (this.result && ((!watoken) ||
                          this.result.token == watoken)) {
        if (request.onSuccess) {
          request.onSuccess.handleSuccess(this.result.URL);
        }
      } else {
        if (request.onError) {
          request.onError.handleError();
        }
      }
    };
  },

  getWAURL: function(pushURL, callback) {
    let req = this.URLs.get(pushURL);
    req.onsuccess = callback;
  },

  getAllWA: function(callback) {
    let req = this.tokens.mozGetAll();

    req.onsuccess = function cb(event) {
      if (this.result) {
        if (callback) {
          callback(null, this.result);
        }
      } else {
        if (callback) {
          callback(true, null);
        }
      }
    };
  }
};
