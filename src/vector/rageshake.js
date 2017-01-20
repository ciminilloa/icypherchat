/*
Copyright 2017 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import PlatformPeg from 'matrix-react-sdk/lib/PlatformPeg';
import request from "browser-request";

// This module contains all the code needed to log the console, persist it to
// disk and submit bug reports. Rationale is as follows:
//  - Monkey-patching the console is preferable to having a log library because
//    we can catch logs by other libraries more easily, without having to all
//    depend on the same log framework / pass the logger around.
//  - We use IndexedDB to persists logs because it has generous disk space
//    limits compared to local storage. IndexedDB does not work in incognito
//    mode, in which case this module will not be able to write logs to disk.
//    However, the logs will still be stored in-memory, so can still be
//    submitted in a bug report should the user wish to: we can also store more
//    logs in-memory than in local storage, which does work in incognito mode.
//    We also need to handle the case where there are 2+ tabs. Each JS runtime
//    generates a random string which serves as the "ID" for that tab/session.
//    These IDs are stored along with the log lines.
//  - Bug reports are sent as a POST over HTTPS: it purposefully does not use
//    Matrix as bug reports may be made when Matrix is not responsive (which may
//    be the cause of the bug). We send the most recent N MB of UTF-8 log data,
//    starting with the most recent, which we know because the "ID"s are
//    actually timestamps. We then purge the remaining logs. We also do this
//    purge on startup to prevent logs from accumulating.

const FLUSH_RATE_MS = 30 * 1000;

// A class which monkey-patches the global console and stores log lines.
class ConsoleLogger {
    constructor() {
        this.logs = "";
    }

    monkeyPatch(consoleObj) {
        // Monkey-patch console logging
        const consoleFunctionsToLevels = {
            log: "I",
            info: "I",
            warn: "W",
            error: "E",
        };
        Object.keys(consoleFunctionsToLevels).forEach((fnName) => {
            const level = consoleFunctionsToLevels[fnName];
            let originalFn = consoleObj[fnName].bind(consoleObj);
            consoleObj[fnName] = (...args) => {
                this.log(level, ...args);
                originalFn(...args);
            }
        });
    }

    log(level, ...args) {
        // We don't know what locale the user may be running so use ISO strings
        const ts = new Date().toISOString();
        // Some browsers support string formatting which we're not doing here
        // so the lines are a little more ugly but easy to implement / quick to
        // run.
        // Example line:
        // 2017-01-18T11:23:53.214Z W Failed to set badge count
        const line = `${ts} ${level} ${args.join(' ')}\n`;
        // Using + really is the quickest way in JS
        // http://jsperf.com/concat-vs-plus-vs-join
        this.logs += line;
    }

    /**
     * Retrieve log lines to flush to disk.
     * @return {string} \n delimited log lines to flush.
     */
    flush() {
        // The ConsoleLogger doesn't care how these end up on disk, it just
        // flushes them to the caller.
        const logsToFlush = this.logs;
        this.logs = "";
        return logsToFlush;
    }
}

// A class which stores log lines in an IndexedDB instance.
class IndexedDBLogStore {
    constructor(indexedDB, logger) {
        this.indexedDB = indexedDB;
        this.logger = logger;
        this.id = "instance-" + Date.now();
        this.index = 0;
        this.db = null;
    }

    /**
     * @return {Promise} Resolves when the store is ready.
     */
    connect() {
        let req = this.indexedDB.open("logs");
        return new Promise((resolve, reject) => {
            req.onsuccess = (event) => {
                this.db = event.target.result;
                // Periodically flush logs to local storage / indexeddb
                setInterval(this.flush.bind(this), FLUSH_RATE_MS);
                resolve();
            };

            req.onerror = (event) => {
                const err = (
                    "Failed to open log database: " + event.target.errorCode
                );
                console.error(err);
                reject(new Error(err));
            };

            // First time: Setup the object store
            req.onupgradeneeded = (event) => {
                const db = event.target.result;
                const objectStore = db.createObjectStore("logs", {
                    keyPath: ["id", "index"]
                });
                // Keys in the database look like: [ "instance-148938490", 0 ]
                // Later on we need to query for everything with index=0, and
                // query everything for an instance id.
                // In order to do this, we need to set up indexes on both "id"
                // and "index".
                objectStore.createIndex("index", "index", { unique: false });
                objectStore.createIndex("id", "id", { unique: false });

                objectStore.add(
                    this._generateLogEntry(
                        new Date() + " ::: Log database was created."
                    )
                );
            }
        });
    }

    /**
     * @return {Promise} Resolved when the logs have been flushed.
     */
    flush() {
        if (!this.db) {
            // not connected yet or user rejected access for us to r/w to the db
            return Promise.reject(new Error("No connected database"));
        }
        const lines = this.logger.flush();
        if (lines.length === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            let txn = this.db.transaction("logs", "readwrite");
            let objStore = txn.objectStore("logs");
            objStore.add(this._generateLogEntry(lines));
            txn.oncomplete = (event) => {
                resolve();
            };
            txn.onerror = (event) => {
                console.error(
                    "Failed to flush logs : " + event.target.errorCode
                );
                reject(
                    new Error("Failed to write logs: " + event.target.errorCode)
                );
            }
        });
    }

    /**
     * Consume the most recent logs and return them. Older logs which are not
     * returned are deleted at the same time, so this can be called at startup
     * to do house-keeping to keep the logs from growing too large.
     *
     * @param {boolean} clearAll True to clear the most recent logs returned in
     * addition to the older logs. This is desirable when sending bug reports as
     * we do not want to submit the same logs twice. This is not desirable when
     * doing house-keeping at startup in case they want to submit a bug report
     * later.
     * @return {Promise<Object[]>} Resolves to an array of objects. The array is
     * sorted in time (oldest first) based on when the log file was created (the
     * log ID). The objects have said log ID in an "id" field and "lines" which
     * is a big string with all the new-line delimited logs.
     */
    async consume(clearAll) {
        const MAX_LOG_SIZE = 1024 * 1024 * 50; // 50 MB
        const db = this.db;

        // Returns: a string representing the concatenated logs for this ID.
        function fetchLogs(id) {
            const o = db.transaction("logs", "readonly").objectStore("logs");
            return selectQuery(o.index("id"), IDBKeyRange.only(id),
            (cursor) => {
                return {
                    lines: cursor.value.lines,
                    index: cursor.value.index,
                }
            }).then((linesArray) => {
                // We have been storing logs periodically, so string them all
                // together *in order of index* now
                linesArray.sort((a, b) => {
                    return a.index - b.index;
                })
                return linesArray.map((l) => l.lines).join("");
            });
        }

        // Returns: A sorted array of log IDs. (newest first)
        function fetchLogIds() {
            // To gather all the log IDs, query for every log entry with index
            // "0", this will let us know all the IDs from different
            // tabs/sessions.
            const o = db.transaction("logs", "readonly").objectStore("logs");
            return selectQuery(o.index("index"), IDBKeyRange.only(0),
            (cursor) => cursor.value.id).then((res) => {
                // we know each entry has a unique ID, and we know IDs are
                // timestamps, so accumulate all the IDs, ignoring the logs for
                // now, and sort them to work out the correct log ID ordering,
                // newest first.
                // E.g. [ "instance-1484827160051", "instance-1374827160051",
                //        "instance-1000007160051"]
                return res.sort().reverse();
            });
        }

        function deleteLogs(id) {
            return new Promise((resolve, reject) => {
                const txn = db.transaction("logs", "readwrite");
                const o = txn.objectStore("logs");
                // only load the key path, not the data which may be huge
                const query = o.index("id").openKeyCursor(IDBKeyRange.only(id));
                query.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (!cursor) {
                        return;
                    }
                    o.delete(cursor.primaryKey);
                    cursor.continue();
                }
                txn.oncomplete = () => {
                    resolve();
                };
                txn.onerror = (event) => {
                    reject(
                        new Error(
                            "Failed to delete logs for " +
                            `'${id}' : ${event.target.errorCode}`
                        )
                    );
                }
            });
        }

        let allLogIds = await fetchLogIds();
        let removeLogIds = [];
        let logs = [];
        let size = 0;
        for (let i = 0; i < allLogIds.length; i++) {
            let lines = await fetchLogs(allLogIds[i]);
            logs.push({
                lines: lines,
                id: allLogIds[i],
            });
            size += lines.length;
            if (size > MAX_LOG_SIZE) {
                // the remaining log IDs should be removed. If we go out of
                // bounds this is just []
                removeLogIds = allLogIds.slice(i + 1);
                break;
            }
        }
        if (clearAll) {
            removeLogIds = allLogIds;
        }
        if (removeLogIds.length > 0) {
            console.log("Removing logs: ", removeLogIds);
            // Don't await this because it's non-fatal if we can't clean up
            // logs.
            Promise.all(removeLogIds.map((id) => deleteLogs(id))).then(() => {
                console.log(`Removed ${removeLogIds.length} old logs.`);
            }, (err) => {
                console.error(err);
            })
        }
        return logs;
    }

    _generateLogEntry(lines) {
        return {
            id: this.id,
            lines: lines,
            index: this.index++
        };
    }
}

/**
 * Helper method to collect results from a Cursor and promiseify it.
 * @param {ObjectStore|Index} store The store to perform openCursor on.
 * @param {IDBKeyRange=} keyRange Optional key range to apply on the cursor.
 * @param {Function} resultMapper A function which is repeatedly called with a
 * Cursor.
 * Return the data you want to keep.
 * @return {Promise<T[]>} Resolves to an array of whatever you returned from
 * resultMapper.
 */
function selectQuery(store, keyRange, resultMapper) {
    const query = store.openCursor(keyRange);
    return new Promise((resolve, reject) => {
        let results = [];
        query.onerror = (event) => {
            reject(new Error("Query failed: " + event.target.errorCode));
        };
        // collect results
        query.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) {
                resolve(results);
                return; // end of results
            }
            results.push(resultMapper(cursor));
            cursor.continue();
        }
    });
}


let store = null;
let logger = null;
let initPromise = null;
let bugReportEndpoint = null;
module.exports = {

    /**
     * Configure rage shaking support for sending bug reports.
     * Modifies globals.
     * @return {Promise} Resolves when set up.
     */
    init: function() {
        if (initPromise) {
            return initPromise;
        }
        logger = new ConsoleLogger();
        logger.monkeyPatch(window.console);
        if (window.indexedDB) {
            store = new IndexedDBLogStore(window.indexedDB, logger);
            initPromise = store.connect();
            return initPromise;
        }
        initPromise = Promise.resolve();
        return initPromise;
    },

    /**
     * Force-flush the logs to storage.
     * @return {Promise} Resolved when the logs have been flushed.
     */
    flush: async function() {
        if (!store) {
            return;
        }
        await store.flush();
    },

    /**
     * Clean up old logs.
     * @return Promise Resolves if cleaned logs.
     */
    cleanup: async function() {
        if (!store) {
            return;
        }
        await store.consume(false);
    },

    setBugReportEndpoint: function(url) {
        bugReportEndpoint = url;
    },

    /**
     * Send a bug report.
     * @param {string} userText Any additional user input.
     * @return {Promise} Resolved when the bug report is sent.
     */
    sendBugReport: async function(userText) {
        if (!logger) {
            throw new Error(
                "No console logger, did you forget to call init()?"
            );
        }
        if (!bugReportEndpoint) {
            throw new Error("No bug report endpoint has been set.");
        }

        let version = "UNKNOWN";
        try {
            version = await PlatformPeg.get().getAppVersion();
        }
        catch (err) {} // PlatformPeg already logs this.

        let userAgent = "UNKNOWN";
        if (window.navigator && window.navigator.userAgent) {
            userAgent = window.navigator.userAgent;
        }

        // If in incognito mode, store is null, but we still want bug report
        // sending to work going off the in-memory console logs.
        let logs = [];
        if (store) {
            logs = await store.consume(true);
        }
        // and add the most recent console logs which won't be in the store yet.
        const consoleLogs = logger.flush(); // remove logs from console
        const currentId = store ? store.id : "-";
        logs.unshift({
            lines: consoleLogs,
            id: currentId,
        });
        await new Promise((resolve, reject) => {
            request({
                method: "POST",
                url: bugReportEndpoint,
                body: {
                    logs: logs,
                    text: (
                        userText || "User did not supply any additional text."
                    ),
                    version: version,
                    user_agent: userAgent,
                },
                json: true,
            }, (err, res) => {
                if (err) {
                    reject(err);
                    return;
                }
                if (res.status < 200 || res.status >= 400) {
                    reject(new Error(`HTTP ${res.status}`));
                    return;
                }
                resolve();
            })
        });
    }
};
