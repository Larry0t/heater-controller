// Node-RED Function Node: "Heater Controller"
/*
Version 2.0; 2025-10-06
	•	Dynamic configuration (via /Heater/Config)
	•	Global manual override (/Heater/Manual)
	•	PV power and SOC logic
	•	Boiler temperature + inverter load protections
	•	Progressive relay ON/OFF control (L1–L3)
	•	Hysteresis ±1000 W
	•	Sunrise/sunset schedule window
	•	Failsafe timers (min ON/OFF + global cooldown)
	•	Throttled status publishing
	•	Output suppression (only emit changes)
*/

// === CONFIGURATION DEFAULTS ===
const defaultConfig = {
  onThreshold: 1000,
  offThreshold: -1000,
  minSoc: 70,
  boilerTempMax: 40,
  inverterLoadMax: 5000,
  minOnSec: 60,
  minOffSec: 60,
  minAnyChangeSec: 10,
  statusMinIntervalSec: 5,
  manualTimeoutSec: 600,
  sunriseTime: "06:00",
  sunsetTime: "20:00",
};

// === INIT CONTEXT ===
const ctx = context.get("state") || {
  relays: [0, 0, 0],
  loads: [0, 0, 0],
  batteryPower: 0,
  soc: 0,
  boilerTemp: 0,
  inverterLoad: 0,
  manualOverride: false,
  config: { ...defaultConfig },
  lastChange: [0, 0, 0],
  lastAnyChange: 0,
  lastStatusSent: 0,
  manualActivatedAt: 0,
};

// === INPUT PARSING ===
if (msg.topic === "/Heater/Config" && typeof msg.payload === "object") {
  ctx.config = { ...ctx.config, ...msg.payload };
  node.status({ fill: "green", shape: "dot", text: "Config updated" });
  context.set("state", ctx);
  return null;
}

if (msg.topic === "/Heater/Manual") {
  ctx.manualOverride = !!msg.payload;
  ctx.manualActivatedAt = ctx.manualOverride ? Date.now() : 0;
  node.status({
    fill: ctx.manualOverride ? "yellow" : "green",
    shape: "dot",
    text: ctx.manualOverride ? "MANUAL: FORCE ON" : "AUTO",
  });
  context.set("state", ctx);
  return null;
}

// Data updates from Victron nodes
switch (msg.topic) {
  case "/Dc/Battery/Power":
    ctx.batteryPower = msg.payload;
    break;
  case "/Dc/Battery/Soc":
    ctx.soc = msg.payload;
    break;
  case "/Ac/L1/Power":
    ctx.loads[0] = msg.payload;
    break;
  case "/Ac/L2/Power":
    ctx.loads[1] = msg.payload;
    break;
  case "/Ac/L3/Power":
    ctx.loads[2] = msg.payload;
    break;
  case "/Boiler/Temp":
    ctx.boilerTemp = msg.payload;
    break;
  case "/Inverter/Load":
    ctx.inverterLoad = msg.payload;
    break;
}
context.set("state", ctx);

// === UTILITY FUNCTIONS ===
function withinTimeWindow() {
  const now = new Date();
  const [sh, sm] = ctx.config.sunriseTime.split(":").map(Number);
  const [eh, em] = ctx.config.sunsetTime.split(":").map(Number);
  const start = new Date(now);
  start.setHours(sh, sm, 0, 0);
  const end = new Date(now);
  end.setHours(eh, em, 0, 0);
  return now >= start && now <= end;
}

function canTurnOn(i) {
  const now = Date.now() / 1000;
  return now - ctx.lastChange[i] >= ctx.config.minOffSec;
}

function canTurnOff(i) {
  const now = Date.now() / 1000;
  return now - ctx.lastChange[i] >= ctx.config.minOnSec;
}

// === MANUAL OVERRIDE TIMEOUT ===
if (ctx.manualOverride && ctx.config.manualTimeoutSec > 0) {
  if (
    (Date.now() - ctx.manualActivatedAt) / 1000 >
    ctx.config.manualTimeoutSec
  ) {
    ctx.manualOverride = false;
    ctx.manualActivatedAt = 0;
    node.status({ fill: "green", shape: "dot", text: "AUTO (manual timeout)" });
  }
}

// === MAIN LOGIC ===
let changed = false;
const nowSec = Date.now() / 1000;
const relays = [...ctx.relays];
const mode = ctx.manualOverride ? "MANUAL: FORCE ON" : "AUTO";

// Global cooldown check
if (nowSec - ctx.lastAnyChange < ctx.config.minAnyChangeSec) {
  return null;
}

// --- MANUAL OVERRIDE ---
if (ctx.manualOverride) {
  const newRelays = [1, 1, 1];
  if (JSON.stringify(ctx.relays) !== JSON.stringify(newRelays)) {
    ctx.relays = newRelays;
    ctx.lastAnyChange = nowSec;
    ctx.lastChange = [nowSec, nowSec, nowSec];
    changed = true;
  }
} else {
  // --- AUTO MODE ---
  if (
    !withinTimeWindow() ||
    ctx.soc < ctx.config.minSoc ||
    ctx.boilerTemp >= ctx.config.boilerTempMax ||
    ctx.inverterLoad >= ctx.config.inverterLoadMax
  ) {
    // Conditions not met → progressively turn OFF
    let onIndexes = ctx.relays
      .map((v, i) => (v ? i : -1))
      .filter((i) => i >= 0);
    if (onIndexes.length > 0) {
      const offIndex = onIndexes.sort((a, b) => ctx.loads[b] - ctx.loads[a])[0];
      if (canTurnOff(offIndex)) {
        ctx.relays[offIndex] = 0;
        ctx.lastChange[offIndex] = nowSec;
        ctx.lastAnyChange = nowSec;
        changed = true;
      }
    }
  } else {
    // Heating conditions OK
    if (ctx.batteryPower > ctx.config.onThreshold) {
      // HEAT_ON
      let offIndexes = ctx.relays
        .map((v, i) => (v ? -1 : i))
        .filter((i) => i >= 0);
      if (offIndexes.length > 0) {
        const onIndex = offIndexes.sort(
          (a, b) => ctx.loads[a] - ctx.loads[b],
        )[0];
        if (canTurnOn(onIndex)) {
          ctx.relays[onIndex] = 1;
          ctx.lastChange[onIndex] = nowSec;
          ctx.lastAnyChange = nowSec;
          changed = true;
        }
      }
    } else if (ctx.batteryPower < ctx.config.offThreshold) {
      // HEAT_OFF
      let onIndexes = ctx.relays
        .map((v, i) => (v ? i : -1))
        .filter((i) => i >= 0);
      if (onIndexes.length > 0) {
        const offIndex = onIndexes.sort(
          (a, b) => ctx.loads[b] - ctx.loads[a],
        )[0];
        if (canTurnOff(offIndex)) {
          ctx.relays[offIndex] = 0;
          ctx.lastChange[offIndex] = nowSec;
          ctx.lastAnyChange = nowSec;
          changed = true;
        }
      }
    }
  }
}

// === OUTPUT GENERATION ===
const outputs = [null, null, null, null];
if (changed) {
  for (let i = 0; i < 3; i++) {
    if (ctx.relays[i] !== relays[i]) {
      outputs[i] = { topic: `/Relay/${i}/State`, payload: ctx.relays[i] };
    }
  }
  ctx.lastAnyChange = nowSec;
}

// === THROTTLED STATUS ===
if (changed || nowSec - ctx.lastStatusSent >= ctx.config.statusMinIntervalSec) {
  const statusMsg = {
    topic: "/Heater/Status",
    payload: {
      relays: ctx.relays,
      soc: ctx.soc,
      batteryPower: ctx.batteryPower,
      boilerTemp: ctx.boilerTemp,
      inverterLoad: ctx.inverterLoad,
      manualOverride: ctx.manualOverride,
      mode,
      lastChange: new Date().toISOString(),
    },
  };
  ctx.lastStatusSent = nowSec;
  outputs[3] = statusMsg;
}

context.set("state", ctx);
return outputs;
