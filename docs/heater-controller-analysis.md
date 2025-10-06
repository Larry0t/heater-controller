
# ⚙️ Victron 3-Phase Heater Controller — Developer Analysis

## 🧩 Purpose
This document provides a **technical deep-dive** into the internal logic, decision rules, state handling, and message flow of the *Victron 3-Phase Heater Controller* Node-RED function node.

It is intended for **developers and maintainers** who extend or debug the controller logic.

---

## 🧱 1. Architecture Overview

**Primary data flow:**

```
[Victron VE.Bus Inputs]
├── Battery Power (W)
├── Battery SOC (%)
├── AC Loads L1, L2, L3 (W)
├── Boiler Temperature (°C)
├── Inverter Output Load (W)
└── Manual Override (0/1)
│
▼
[Heater Controller Function Node]
│
├── Logic Engine
├── State Context
├── Failsafe Timers
└── Hysteresis Evaluation
▼
[Outputs]
├── Relay 0 → L1
├── Relay 1 → L2
├── Relay 2 → L3
└── /Heater/Status
```

---

## ⚙️ 2. Execution Model

Each message triggers an evaluation step in the function node.
Inputs update shared **context state** (`ctx`) before running the main logic loop.

**State categories:**
- **Measurements:** batteryPower, soc, boilerTemp, inverterLoad, loads[L1–L3]
- **Relays:** `ctx.relays = [0|1, 0|1, 0|1]`
- **Flags:** `ctx.manualOverride`, `ctx.lastChange`
- **Config:** thresholds and timing values

---

## 🔄 3. Rule Evaluation Sequence

### Step 1. Input Handling
Each incoming topic updates the relevant context variable:
```
/Dc/Battery/Power     → ctx.batteryPower
/Dc/Battery/Soc       → ctx.soc
/Ac/L1/Power          → ctx.loads[0]
/Ac/L2/Power          → ctx.loads[1]
/Ac/L3/Power          → ctx.loads[2]
/Boiler/Temp          → ctx.boilerTemp
/Inverter/Load        → ctx.inverterLoad
/Heater/Config        → ctx.config
/Heater/Manual        → ctx.manualOverride
```

### Step 2. Manual Override
If `ctx.manualOverride == true`, normal logic halts and all relays = ON.
`ctx.manualOverride` can timeout automatically (configurable `manualTimeoutSec`).

### Step 3. Condition Pre-Checks
If **boilerTemp ≥ limit**, **inverterLoad ≥ limit**, or **SOC < minSoc**,
then heating is disabled — all relays progressively switched OFF.

### Step 4. Battery Power Analysis
Battery power determines direction:
- `batteryPower > +onThreshold` → PV surplus → **HEAT_ON**
- `batteryPower < −offThreshold` → battery discharging → **HEAT_OFF**
- Otherwise → maintain current relay states (hysteresis zone)

### Step 5. HEAT_ON Progression
Rules applied sequentially:
1. If 0 relays ON → turn ON relay with **lowest line load**
2. If 1 relay ON → turn ON relay with **lowest load among OFF relays**
3. If 2 relays ON → turn ON the last remaining OFF relay
4. Enforce `minAnyChangeSec` cooldown between relay changes

### Step 6. HEAT_OFF Progression
1. If 3 relays ON → turn OFF relay with **highest line load**
2. If 2 relays ON → turn OFF relay with **highest load among ON relays**
3. If 1 relay ON → turn OFF the last remaining relay
4. Enforce same cooldown and min-ON/OFF timers

### Step 7. Timing and Safety
For each relay:
- Must stay **ON ≥ minOnSec**
- Must stay **OFF ≥ minOffSec**
- `lastChange` timestamp stored per relay in context

### Step 8. Output Suppression
Relay output topics (`/Relay/X/State`) are only emitted **if state changed**.
`/Heater/Status` is throttled by `statusMinIntervalSec` to reduce message noise.

---

## 📊 4. Context Model

```json
{
  "batteryPower": 2345,
  "soc": 76.3,
  "boilerTemp": 39.2,
  "inverterLoad": 3400,
  "loads": [1200, 900, 1100],
  "relays": [1, 1, 0],
  "manualOverride": false,
  "config": {
    "onThreshold": 1000,
    "offThreshold": -1000,
    "minSoc": 70,
    "boilerTempMax": 40,
    "inverterLoadMax": 5000,
    "minOnSec": 60,
    "minOffSec": 60,
    "minAnyChangeSec": 10,
    "statusMinIntervalSec": 5,
    "manualTimeoutSec": 600
  },
  "timestamps": {
    "relay0": "2025-10-06T13:42:10Z",
    "relay1": "2025-10-06T13:43:20Z",
    "relay2": "2025-10-06T13:44:00Z"
  },
  "lastStatusSent": "2025-10-06T13:44:02Z"
}


⸻

🧮 5. Decision Tree (Simplified)

                 ┌────────────┐
                 │Manual ON ? │───Yes──▶ Force all relays ON
                 └──────┬─────┘
                        │
                        ▼
              ┌──────────────┐
              │Boiler Temp > │──▶ OFF all relays
              │Inverter Load >│──▶ OFF all relays
              │SOC < MinSOC ? │──▶ OFF all relays
              └──────┬───────┘
                     │
             ┌───────▼──────────┐
             │Battery Power > +1k│──▶ HEAT_ON sequence
             │Battery Power < -1k│──▶ HEAT_OFF sequence
             │Otherwise          │──▶ Hold states
             └───────────────────┘


⸻

🧩 6. Status Object Schema

Field	Type	Description
relays	[int, int, int]	Current relay states (0=OFF,1=ON)
soc	float	Battery SOC
batteryPower	float	Power balance (W)
boilerTemp	float	Boiler temperature
inverterLoad	float	Inverter AC output load
manualOverride	bool	Global override flag
mode	"AUTO" or "MANUAL: FORCE ON"	Current control mode
lastChange	string	ISO timestamp of last relay change


⸻

🧰 7. Key Design Decisions

Aspect	Choice	Rationale
Progressive ON/OFF	1 relay per change	Prevent power step shock & phase imbalance
Flat hysteresis	±1000 W	Simpler and predictable PV behavior
Manual override	Force all ON	Emergency or testing mode
Timing enforcement	minOnSec, minOffSec, minAnyChangeSec	Prevent relay wear & oscillation
Throttle status	1 msg / few seconds	Reduce UI noise
Context persistence	Node context store	Survive flow redeploys
Dashboard configuration	Dynamic parameters	Runtime tuning, no redeploy required


⸻

🧠 8. Extension Points

Potential expansions:
	1.	Multiple heater groups (2+ boilers, same logic per group)
	2.	Smart export limiter integrating EV charger logic
	3.	MQTT publish for external logging (/heater/status)
	4.	InfluxDB metrics for energy tracking
	5.	Temperature-based modulation (PID-like relay time balancing)
	6.	Load prediction / smoothing using battery trend averaging

⸻

🧾 9. Development & Testing Notes

Test Case	Expected Behavior
PV > +1 kW, SOC > min, boiler < 40°C	Relays progressively ON
Battery −1 kW discharge	Relays progressively OFF
Inverter load > 5 kW	Block heating (no ON transitions)
Boiler temp ≥ 40°C	Force all relays OFF
Manual override ON	All relays ON immediately
Manual override timeout expires	Revert to AUTO
SOC < minSoc	All relays OFF
Relay state stable	No redundant output
Battery hovering in hysteresis	Relay states unchanged


⸻

🧩 10. Maintenance Tips
	•	When updating logic, always reset context after flow change.
	•	To debug state transitions: attach Debug node to /Heater/Status.
	•	If relays chatter, increase minAnyChangeSec or widen hysteresis.
	•	SSR relays → shorter cooldowns acceptable; mechanical → ≥60 s.
	•	If Victron feed stops, consider watchdog timer to turn OFF relays.

⸻

🏁 Summary

The Victron 3-Phase Heater Controller provides:
	•	Stable, predictable PV-driven heating control
	•	Balanced 3-phase relay switching
	•	Protection for inverter, battery, and boiler
	•	Safe and flexible manual override mechanism

The logic is modular, maintainable, and production-ready for deployment in Victron-based hybrid PV systems.

⸻

`docs/heater-controller-analysis.md`  
Document version: 1.0 — 2025-10-06
