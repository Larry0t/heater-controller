// Three-phase heater controller with runtime config updates via /Heater/Config (v1.6)
// Three-phase heater controller with global manual override + failsafe timer (v1.5)
// Boiler temp cutoff, inverter load limit
// Relay outputs only on change
// Status output only on change, throttled
// added by Lubomir:
//// normalize Inverter Power (Load "-"; Charge "+")

// ===== Default configuration =====
const DEFAULT_CONFIG = {
  onThreshold: 1000,
  offThreshold: -1000,
  minSoc: 50,
  minOnSec: 20,
  minOffSec: 20,
  minAnyChangeSec: 30,
  progressionCooldown: [0, 6, 12, 18],
  invertBatterySign: false,
  boilerTempMax: 40,
  inverterLoadMax: 5000,
  manualTimeoutSec: 1800,
  statusMinIntervalSec: 5
};

// ===== Load config from context =====
let cfg = context.get('cfg') || { ...DEFAULT_CONFIG };
let st = context.get('st') || {
  batteryPower: 0,
  soc: 0,
  loads: [0,0,0],
  relays: [0,0,0],
  lastChange: [0,0,0],
  lastGlobalChange: 0,
  stepCount: 0,
  lastDirection: null,
  sun: { sunrise: null, sunset: null },
  boilerTemp: 0,
  inverterLoad: 0,
  manual: null,
  manualSince: null,
  lastStatus: null,
  lastRelayStates: [null,null,null],
  lastStatusTime: 0
};

// ===== Handle configuration updates =====
if (msg && msg.topic === "/Heater/Config") {
  if (typeof msg.payload === "object") {
    cfg = { ...cfg, ...msg.payload };
    context.set('cfg', cfg);
    node.warn("Config updated: " + JSON.stringify(cfg));
  }
  return null; // do not continue control cycle
}

// ===== Parse normal inputs =====
const m = msg;
if (m && m.topic) {
  const t = String(m.topic);
  if (t.includes('Battery') && t.includes('Power')) st.batteryPower = Number(m.payload);
  else if (t.includes('Battery') && t.includes('Soc')) st.soc = Number(m.payload);
  else if (t.includes('L1') && t.includes('Power')) st.loads[0] = Number(m.payload);
  else if (t.includes('L2') && t.includes('Power')) st.loads[1] = Number(m.payload);
  else if (t.includes('L3') && t.includes('Power')) st.loads[2] = Number(m.payload);
  else if (t.includes('Boiler') && t.includes('Temp')) st.boilerTemp = Number(m.payload);
  else if (t.includes('Inverter') && t.includes('Load')) st.inverterLoad = Number(m.payload);
  else if (t === "/Manual/All") {
    if (String(m.payload).toLowerCase() === "auto") {
      st.manual = null;
      st.manualSince = null;
    } else {
      st.manual = (m.payload === 0 || m.payload === "0") ? 0 : 1;
      st.manualSince = Date.now();
    }
  }
}

// sunrise/sunset
if (m && m.payload && m.payload.sunrise && m.payload.sunset) {
  st.sun.sunrise = new Date(m.payload.sunrise);
  st.sun.sunset  = new Date(m.payload.sunset);
}
if (m && m.sunrise) st.sun.sunrise = new Date(m.sunrise);
if (m && m.sunset)  st.sun.sunset  = new Date(m.sunset);

// normalize
let battPower = Number(st.batteryPower) || 0;
if (cfg.invertBatterySign) battPower = -battPower;

const now = new Date();
const isDay = (st.sun.sunrise && st.sun.sunset)
  ? (now >= st.sun.sunrise && now <= st.sun.sunset)
  : true;

// ===== manual override failsafe =====
if (st.manual !== null && st.manualSince) {
  const elapsed = (Date.now() - st.manualSince) / 1000;
  if (elapsed > cfg.manualTimeoutSec) {
    node.warn("Manual override expired → auto");
    st.manual = null;
    st.manualSince = null;
  }
}

// ===== control logic =====
if (st.manual === 0) {
  st.relays = [0,0,0];
} else if (st.manual === 1) {
  st.relays = [1,1,1];
} else {
  if (st.boilerTemp > cfg.boilerTempMax) {
    st.relays = [0,0,0];
  } else {
    let desired = 'HOLD';
    if (battPower >= cfg.onThreshold &&
        (Number(st.soc) || 0) >= cfg.minSoc &&
        isDay &&
        st.inverterLoad <= cfg.inverterLoadMax) {
      desired = 'HEAT_ON';
    } else if (battPower <= cfg.offThreshold) {
      desired = 'HEAT_OFF';
    }

    st.lastChange = st.lastChange.map(x => (typeof x === 'number' ? x : 0));
    function canTurnOn(i) {
      if (st.relays[i]) return true;
      const elapsed = (Date.now() - (st.lastChange[i] || 0)) / 1000;
      return elapsed >= cfg.minOffSec;
    }
    function canTurnOff(i) {
      if (!st.relays[i]) return true;
      const elapsed = (Date.now() - (st.lastChange[i] || 0)) / 1000;
      return elapsed >= cfg.minOnSec;
    }

    const onIdx  = st.relays.map((v,i)=> v? i : -1).filter(i=>i>=0);
    const offIdx = st.relays.map((v,i)=> v? -1 : i).filter(i=>i>=0);

    let changed = false;
    let direction = null;

    const sinceGlobal = (Date.now() - (st.lastGlobalChange || 0)) / 1000;
    if (sinceGlobal < cfg.minAnyChangeSec) desired = 'HOLD';

    if (desired === 'HEAT_ON' || desired === 'HEAT_OFF') {
      if (st.lastDirection === desired) {
        const idx = Math.min(st.stepCount, cfg.progressionCooldown.length-1);
        const cooldown = cfg.progressionCooldown[idx];
        const elapsed = (Date.now() - (st.lastGlobalChange || 0)) / 1000;
        if (elapsed < cooldown) desired = 'HOLD';
      }
    }

    if (desired === 'HEAT_ON' && offIdx.length > 0) {
      if (battPower >= cfg.onThreshold && st.inverterLoad <= cfg.inverterLoadMax) {
        let cand = null, minLoad = Number.POSITIVE_INFINITY;
        for (const i of offIdx) {
          if (!canTurnOn(i)) continue;
          const load = Number(st.loads[i] || 0);
          if (load < minLoad) { minLoad = load; cand = i; }
        }
        if (cand !== null) {
          st.relays[cand] = 1;
          st.lastChange[cand] = Date.now();
          st.lastGlobalChange = Date.now();
          direction = 'HEAT_ON';
          changed = true;
          node.status({fill:'green',shape:'dot',text:`ON L${cand+1}`});
        }
      }
    } else if (desired === 'HEAT_OFF' && onIdx.length > 0) {
      if (battPower <= cfg.offThreshold) {
        let cand = null, maxLoad = -Infinity;
        for (const i of onIdx) {
          if (!canTurnOff(i)) continue;
          const load = Number(st.loads[i] || 0);
          if (load > maxLoad) { maxLoad = load; cand = i; }
        }
        if (cand !== null) {
          st.relays[cand] = 0;
          st.lastChange[cand] = Date.now();
          st.lastGlobalChange = Date.now();
          direction = 'HEAT_OFF';
          changed = true;
          node.status({fill:'red',shape:'ring',text:`OFF L${cand+1}`});
        }
      }
    }

    if (changed) {
      if (direction === st.lastDirection) st.stepCount += 1;
      else {
        st.stepCount = 1;
        st.lastDirection = direction;
      }
    } else if (desired === 'HOLD') {
      st.stepCount = 0;
      st.lastDirection = null;
    }
  }
}

// formate Date & Time for status
const currentDT = new Date();
const formattedStatusTime = `${currentDT.getMonth() + 1}/${currentDT.getDate()}/${currentDT.getFullYear()}
                            ${currentDT.getHours()}:${currentDT.getMinutes()}:${currentDT.getSeconds()}`;
//node.warn("formated StatusTime: " + JSON.stringify(formattedStatusTime));

// ===== build status =====
let status = {
  mode: st.manual === null ? "auto" : "manual",
  manual: st.manual,
  timeLeft: null,
  relays: st.relays,
  soc: st.soc,
  batteryPower: battPower,
  boilerTemp: st.boilerTemp,
  inverterLoad: st.inverterLoad,
  lastStatusTime: formattedStatusTime,
  config: cfg
};
if (st.manual !== null && st.manualSince) {
  const elapsed = (Date.now() - st.manualSince) / 1000;
  status.timeLeft = Math.max(0, cfg.manualTimeoutSec - elapsed);
}

// ===== compare with last + throttle =====
let statusChanged = JSON.stringify(status) !== JSON.stringify(st.lastStatus);
let timeSinceStatus = (Date.now() - (st.lastStatusTime || 0)) / 1000;
let canEmitStatus = timeSinceStatus >= cfg.statusMinIntervalSec;

let msg3 = null;
if (statusChanged && canEmitStatus) {
  st.lastStatus = status;
  st.lastStatusTime = Date.now();
  msg3 = { topic: '/Heater/Status', payload: status };
}

// ===== prepare relay outputs only if changed =====
const relayMsgs = [null,null,null];
for (let i=0;i<3;i++) {
  if (st.relays[i] !== st.lastRelayStates[i]) {
    relayMsgs[i] = { topic: `/Relay/${i}/State`, payload: st.relays[i] };
    st.lastRelayStates[i] = st.relays[i];
  }
}

// ===== save state =====
context.set('st', st);

// ===== outputs =====
return [ relayMsgs[0], relayMsgs[1], relayMsgs[2], msg3 ];