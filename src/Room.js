import { createEmitter } from "./emitter";
import { Record } from "./Record";
import * as log from "./log";

// eslint-disable-next-line
import css from "./party_debug.css";

/*
 * Room
 *
 * Keeps track of particpants and records related to a specific app/room.
 */

export class Room {
  #client; // party.Client: currently connected client
  #appName; // string: user provide name for the app
  #roomName; // string: user provide name for the room

  #roomDataRecord; // ds.Record: {participants: [uid], host: uid}
  #participants; // [uid]: cache of #roomDataRecord.participants
  #recordList; // ds.List: user records created in this room
  #participantRecords; // {uid: party.Record}: map of particpant records for room
  #participantShareds; // [(watched)shared] cache of #participantRecords.getShared()s
  #clientParticpantRecord; // party.Record, participant record this client

  #isReady;
  #emitter;

  constructor(client, appName, roomName) {
    this.#client = client;
    this.#appName = appName;
    this.#roomName = roomName;
    this.#emitter = createEmitter();

    this.#participantRecords = {};
    this.#participantShareds = [];

    this.#clientParticpantRecord = new Record(
      this.#client,
      `${this.#appName}-${this.#roomName}/_${this.#client.name()}`,
      this.#client.name()
    );
    this.#isReady = false;
    this.#connect();
  }

  async #connect() {
    await this.#client.whenReady();
    const connectRoomData = async () => {
      // load the _room_data record
      this.#roomDataRecord = this.#client.getRecord(
        `${this.#appName}-${this.#roomName}/_room_data`
      );
      await this.#roomDataRecord.whenReady();

      // initialize the participants array
      this.#participants = this.#roomDataRecord.get("participants");
      if (!this.#participants) {
        this.#participants = [];
        // @todo change next two lines to setWithAck?
        this.#roomDataRecord.set("participants", []);
        await this.#roomDataRecord.whenReady();
      }

      // subscribe to changes on the participans array
      this.#roomDataRecord.subscribe("participants", (data) => {
        this.#participants = data;
        this.#chooseHost();
        this.#updateParticpantRecords();
      });
    };

    const connectRecordList = async () => {
      // load the record list
      this.#recordList = this.#client.getList(
        `${this.#appName}-${this.#roomName}/_records`
      );
      await this.#recordList.whenReady();
    };

    // let part A and part B happen in parallel
    const partA = connectRoomData();
    const partB = connectRecordList();
    await partA;
    await partB;
    await this.#clientParticpantRecord.whenReady();
    this.#client.presenceSubscribe(this.#onPresenceHandler.bind(this));

    // ready
    this.#isReady = true;
    this.#emitter.emit("ready");

    setInterval(this.#displayDebug.bind(this), 100);
  }

  // whenReady returns a promise AND calls a callback
  whenReady(cb = () => {}) {
    if (this.#isReady) {
      cb();
      return Promise.resolve();
    } else {
      this.#emitter.once("ready", cb);
      return new Promise((resolve) => {
        this.#emitter.once("ready", resolve);
      });
    }
  }

  getRecord(id) {
    const name = `${this.#appName}-${this.#roomName}/${id}`;
    const record = new Record(this.#client, name);

    record.whenReady(async () => {
      await this.#recordList.whenReady();
      const entries = this.#recordList.getEntries();
      if (!entries.includes(name)) {
        this.#recordList.addEntry(name);
      }
    });

    return record;
  }

  // add this client to the room
  join() {
    const name = this.#client.name();
    if (!this.#participants.includes(name)) {
      this.#roomDataRecord.set(
        `participants.${this.#participants.length}`,
        name
      );
    }
  }

  // remove this client from the room
  leave() {
    const participants = this.#participants.filter(
      (p) => p !== this.#client.name()
    );
    this.#roomDataRecord.set(`participants`, participants);
  }

  // check if this client is in the room
  contains(username) {
    return this.#participants.includes(username);
  }

  getHostName() {
    return this.#roomDataRecord.get(`host`);
  }

  getMyRecord() {
    return this.#clientParticpantRecord;
  }

  // getMyShared() {
  //   return this.#clientParticpantRecord.getShared();
  // }

  getParticipantShareds(cb) {
    cb && this.#updateParticpantRecords().then(cb);
    return this.#participantShareds;
  }

  async removeDisconnectedClients() {
    const online = await this.#client.getAllClients();
    const newParticipants = this.#participants.filter((p) =>
      online.includes(p)
    );
    this.#roomDataRecord.set(`participants`, newParticipants);
  }

  // async reset() {
  //   for (const entry of this.#recordList.getEntries()) {
  //     const record = this.#client.getRecord(entry);
  //     await record.whenReady();
  //     record.delete();
  //   }
  //   this.#recordList.delete();
  //   return new Room(this.#client, this.#appName, this.#roomName);
  // }

  #onPresenceHandler(username, isLoggedIn) {
    // console.log(username, isLoggedIn ? "arrived" : "left");
    if (!this.contains(username)) return;

    if (isLoggedIn) {
      log.warn(`Participant ${username} reconnected.`);
      this.#chooseHost();
    }
    if (!isLoggedIn) {
      log.warn(`Participant ${username} disconnected.`);
      this.#chooseHost();
    }
  }

  async #chooseHost() {
    const host = this.#roomDataRecord.get("host");
    const onlineClients = await this.#client.getAllClients();

    // if host is onlin and in the room, we don't need a new one
    if (onlineClients.includes(host) && this.#participants.includes(host))
      return;

    // pick the first participant that is online as the new host
    const newHost = this.#participants.find((p) => onlineClients.includes(p));

    // if we didn't find one, return
    if (!newHost) {
      log.debug("Couldn't find a host in participants:", this.#participants);
      return;
    }

    // have only the new host set host so that multiple clients
    // don't try to set the host at once, causing a conflict
    if (newHost === this.#client.name()) {
      // todo: can this be setWithAck?
      this.#roomDataRecord.set("host", newHost);
      await this.#roomDataRecord.whenReady();
    }
  }

  async #updateParticpantRecords() {
    await this.whenReady();
    await this.#roomDataRecord.whenReady();

    // collect data
    const participantRecordIds = Object.keys(this.#participantRecords);
    const participantIds = this.#participants;
    const allIds = [...new Set([...participantRecordIds, ...participantIds])];

    //log.debug("participantRecordIds", participantRecordIds);
    //log.debug("participantIds", participantIds);
    //log.debug("allIds", allIds);

    // add and remove records
    const recordWhenReadies = [];

    allIds.forEach((id) => {
      // remove stale participant records
      if (participantRecordIds.includes(id) && !participantIds.includes(id)) {
        // only the host should delete the record
        if (this.#client.name() === this.#roomDataRecord.get("host")) {
          this.#participantRecords[id].delete();
        }
        delete this.#participantRecords[id];
      }

      // add new participant records
      if (participantIds.includes(id) && !participantRecordIds.includes(id)) {
        if (id === this.#client.name()) {
          this.#participantRecords[id] = this.#clientParticpantRecord;
          recordWhenReadies.push(this.#clientParticpantRecord.whenReady());
        } else {
          const r = new Record(
            this.#client,
            `${this.#appName}-${this.#roomName}/_${id}`,
            id
          );
          // todo: should we wait for this record to be ready before adding to #participantRecords?
          this.#participantRecords[id] = r;
          recordWhenReadies.push(r.whenReady());
        }
      }
    });

    // wait for records to get ready
    await Promise.all(recordWhenReadies);

    // empty and refill array
    this.#participantShareds.length = 0;
    Object.values(this.#participantRecords).forEach((r) => {
      this.#participantShareds.push(r.getShared());
    });

    // @todo currently not removing or hiding disconnected clients (ghosts)
  }

  // @todo: factor this out of Room?
  #displayDebug() {
    // create element if needed
    let el = document.getElementById("party-debug");
    if (!el) {
      el = document.createElement("div");
      el.id = "party-debug";
      document.body.appendChild(el);
    }

    // collect info
    const onlineClients = this.#client.getAllClients();

    // generate output
    let output = "";
    output += '<div class="label">p5.party debug</div>';
    output += `<div class="app">${this.#appName}</div>`;
    output += `<div class="room">${this.#roomName}</div>`;
    output += `<div class="label">Participants</div>`;

    for (const name of this.#participants) {
      const shortName = name.substr(-4);
      const host = this.#roomDataRecord.get(`host`) === name ? "host" : "";
      const missing = onlineClients.includes(name) ? "" : "missing";
      const me = this.#client.name() === name ? "me" : "";

      output += `<div class="participant ${host} ${me} ${missing}">${shortName}</div>`;
    }

    output += `<div class="label">Shared Objects</div>`;
    for (const entry of this.#recordList.getEntries()) {
      output += `<div class="record">${entry.split("/")[1]}</div>`;
    }

    // output += `<div class="label">#participantRecords</div>`;
    // // get keys from #participantRecords
    // const keys = Object.keys(this.#participantRecords);
    // for (const key of keys) {
    //   output += `<div class="record">${key}</div>`;
    // }

    el.innerHTML = output;
  }
}
