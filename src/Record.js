import * as log from "./log";
import onChange from "on-change";
import { createEmitter } from "./emitter";

/*
 * Record
 *
 * - creates an object `#shared`
 * - wraps and observes `#shared` with `#watchShared` (using onChange)
 * // https://github.com/sindresorhus/on-change
 * - syncs changes via deepstream record `#record`
 * - deep merges incoming changes into `#shared`
 *
 * record.set() is async, you need to wait for whenReady before record.get() * * will reflect your change.
 * in contrast values set on properties of the shared object
 * should be available immediately
 *
 */
export class Record {
  #client; // party.Client: currently connected client
  #name; // string: full name of record (e.g. "appName-roomName/_recordName")
  #shared; // {}: internal read/write object to be synced with other clients
  #watchedShared; // Proxy: observable object wrapping #shared
  #record; // ds.Record: the record this party.Record is managing
  #ownerId; // id of the client that "owns" this record, or null if no "owner"
  // ownerId is used to warn if a client tries to change "someone elses" data
  #isReady;
  #emitter;

  constructor(client, name, ownerId = null) {
    this.#client = client;
    this.#name = name;
    this.#shared = {};
    this.#ownerId = ownerId;
    this.#watchedShared = onChange(
      this.#shared,
      this.#onClientChangedData.bind(this)
    );
    // create a reference back to this party.Record from the shared object
    // property key is a Symbol so its unique and mostly hidden
    this.#shared[Symbol.for("Record")] = this;
    this.#emitter = createEmitter();
    this.#isReady = false;
    this.#connect();
  }

  whenReady(cb) {
    if (this.#isReady) {
      if (typeof cb === "function") cb();
      return Promise.resolve();
    }
    if (typeof cb === "function") this.#emitter.once("ready", cb);
    return new Promise((resolve) => {
      this.#emitter.once("ready", resolve);
    });
  }

  getShared() {
    return this.#watchedShared;
  }

  // resets shared object to data
  // warns non-owners on write
  setShared(data) {
    if (this.#ownerId && this.#ownerId !== this.#client.name()) {
      log.warn(
        `setShared() 
        changing data on shared object owned by another client
        client: ${this.#client.name()}
        owner: ${this.#ownerId}
        data: ${JSON.stringify(data)}
        `
      );
    }

    this.#setShared(data);
  }

  // resets shared object to data
  // does not warn non-owners on write
  #setShared(data) {
    this.#record.set("shared", data);
  }

  async delete() {
    // todo: is below line needed? is there a need to setShared to {} before deleting a record?
    this.#setShared({});
    await this.#record.whenReady();
    this.#record.delete();
  }

  async watchShared(path_or_cb, cb) {
    await this.whenReady();
    if (typeof path_or_cb === "string") {
      this.#record.subscribe("shared." + path_or_cb, cb);
    } else if (typeof path_or_cb === "function") {
      this.#record.subscribe("shared", path_or_cb);
    }
  }

  static recordForShared(shared) {
    return onChange.target(shared)[Symbol.for("Record")];
  }

  async #connect() {
    await this.#client.whenReady();

    // get and subscribe to record
    this.#record = this.#client.getRecord(this.#name);
    this.#record.subscribe("shared", this.#onServerChangedData.bind(this));

    await this.#record.whenReady();

    // initialize shared object
    // #todo should we use setWithAck or await #record.whenReady()?
    if (!this.#record.get("shared")) this.#record.set("shared", {});

    // report
    log.debug("RecordManager: Record ready.", this.#name);

    // ready
    this.#isReady = true;
    this.#emitter.emit("ready");
  }

  #onClientChangedData(path, newValue, oldValue) {
    // on-change alerts us only when the value actually changes
    // so we don't need to test if newValue and oldValue are different

    if (this.#ownerId && this.#ownerId !== this.#client.name()) {
      log.warn(
        `changing data on shared object owned by another client
client: ${this.#client.name()}
owner: ${this.#ownerId}
path: ${path}
newValue: ${JSON.stringify(newValue)}`
      );
    }
    this.#record.set("shared." + path, newValue);
  }

  // _onServerChangedData
  // called from deepstreem. this is called when the deepstreem data store is
  // updated, even if the update was local. If the update is local
  // this.#shared === data -> true
  // because this.#shared was updated first, triggering this callback
  // if the change originated non-locally, than this.#shared does need to be
  // updated

  #onServerChangedData(data) {
    // don't replace #shared itself as #watchedShared has a reference to it
    // instead patch it to match the incoming data
    patchInPlace(this.#shared, data, "shared");
  }
}

function getMergeType(value) {
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  if (typeof value === "boolean") return "primitive";
  if (typeof value === "number") return "primitive";
  if (typeof value === "string") return "primitive";
  return "unsupported";
}

function patchInPlace(_old, _new, _keyPath = "") {
  if (typeof _old !== "object") {
    log.error("_old is not an object");
    return;
  }
  if (typeof _new !== "object") {
    log.error("_new is not an object");
    return;
  }

  const oldKeys = Object.keys(_old);
  const newKeys = Object.keys(_new);

  // remove old keys not in new
  for (const key of oldKeys) {
    if (!Object.prototype.hasOwnProperty.call(_new, key)) {
      // log.debug(`remove ${_keyPath}.${key}`);
      if (Array.isArray(_old)) {
        _old.splice(key, 1);
      } else {
        delete _old[key];
      }
    }
  }

  // patch shared object and array keys
  for (const key of newKeys) {
    if (Object.prototype.hasOwnProperty.call(_old, key)) {
      const oldType = getMergeType(_old[key]);
      const newType = getMergeType(_new[key]);
      if (oldType === "unsupported") {
        log.error(
          `${_keyPath}.${key} is unsupported type: ${typeof _new[key]}`
        );
        continue;
      }
      if (newType === "unsupported") {
        log.error(
          `${_keyPath}.${key} is unsupported type: ${typeof _new[key]}`
        );
        continue;
      }
      if (oldType !== "object" || newType !== "object") {
        if (_old[key] !== _new[key]) {
          _old[key] = _new[key];
        }
        continue;
      }
      patchInPlace(_old[key], _new[key], `${_keyPath}.${key}`);
    }
  }

  // add new keys not in old
  for (const key of newKeys) {
    if (!Object.prototype.hasOwnProperty.call(_old, key)) {
      // log.debug(`add ${_keyPath}.${key}`);
      _old[key] = _new[key];
    }
  }
}
